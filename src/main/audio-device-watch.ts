import {MaintenanceHold,waitForOwnedChildClose} from './maintenance-hold.js';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {FrameReader} from './audio-protocol.js';
import {RELEASE} from '../shared/release.js';
import type {AudioDeviceWatchState} from '../shared/contracts.js';
export class AudioDeviceWatch {
 private readonly maintenance=new MaintenanceHold();
 private state:AudioDeviceWatchState={revision:0,status:'stopped',message:'设备变化通知尚未启动',observedAt:Date.now(),reasons:[]};
 private child:ChildProcessWithoutNullStreams|null=null;
 private pending:Promise<AudioDeviceWatchState>|null=null;
 private heartbeat:NodeJS.Timeout|null=null;
 private stopping=false;
 private interrupted=false;private systemEpoch=0;private maintenanceResume=false;
 constructor(private readonly executable:string,private readonly publish:(state:AudioDeviceWatchState)=>void){}
 snapshot():AudioDeviceWatchState{return {...this.state,reasons:[...this.state.reasons]};}
 private changed(status:AudioDeviceWatchState['status'],message:string,reasons:string[]):void{
  if(this.state.revision>=Number.MAX_SAFE_INTEGER)throw new Error('设备变化修订达到上限');
  this.state={revision:this.state.revision+1,status,message,reasons,observedAt:Date.now()};try{this.publish(this.snapshot());}catch{/* A UI failure cannot restart the native watcher. */}
 }
 start():Promise<AudioDeviceWatchState>{
  if(this.maintenance.held)return Promise.reject(new Error('曲库维护期间设备通知暂停'));
  if(this.interrupted)return Promise.reject(new Error('设备通知因系统休眠暂停'));
  if(this.stopping)return Promise.reject(new Error('应用正在关闭'));
  if(this.pending)return this.pending;if(this.state.status==='watching')return Promise.resolve(this.snapshot());
  if(this.child)return Promise.reject(new Error('旧设备通知进程尚未确认退出，暂不能重新启动'));
  const nonce=randomUUID(),child=spawn(this.executable,['--device-watch',nonce,String(process.pid)],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;child.stdin.end();this.changed('starting','正在连接设备变化通知',[]);
  let finish!:(value:AudioDeviceWatchState)=>void;const promise=new Promise<AudioDeviceWatchState>(resolve=>{finish=resolve;});this.pending=promise;
  let settled=false,failed=false,ready=false,sequence=0n,lastFrame=performance.now(),windowAt=lastFrame,bytes=0,diagnostics=0;
  const complete=()=>{if(settled)return;settled=true;this.pending=null;finish(this.snapshot());};
  const fail=(message:string)=>{
   if(failed||this.stopping||this.interrupted||this.maintenance.held)return;failed=true;if(this.heartbeat)clearInterval(this.heartbeat);this.heartbeat=null;
   this.changed('unavailable',message,[]);child.kill();complete();
  };
  const reader=new FrameReader(value=>{
   if(Object.keys(value).length!==7||value.backend!=='wasapi'||value.buildId!==RELEASE.hostBuildId||value.nonce!==nonce||!value.protocol||typeof value.protocol!=='object'||(value.protocol as {major:unknown;minor:unknown}).major!==RELEASE.audioProtocol.major||(value.protocol as {minor:unknown}).minor!==RELEASE.audioProtocol.minor||typeof value.sequence!=='string'||!/^\d{1,20}$/.test(value.sequence)||!['ready','changed','heartbeat'].includes(String(value.kind))||!Array.isArray(value.reasons)||value.reasons.length>5||value.reasons.some(reason=>typeof reason!=='string'||!['state','added','removed','default-output','properties'].includes(reason))||new Set(value.reasons).size!==value.reasons.length)throw new Error('设备通知回执无效');
   const next=BigInt(value.sequence);if(next!==sequence+1n||next>0xffffffffffffffffn||!ready&&value.kind!=='ready'||ready&&value.kind==='ready'||(value.kind==='changed')!==(value.reasons.length>0))throw new Error('设备通知顺序无效');
   sequence=next;lastFrame=performance.now();
   if(!ready){ready=true;this.changed('watching','设备变化通知已连接',[]);complete();}
   else if(value.kind==='changed')this.changed('watching','设备列表或系统默认输出已变化，请重新读取',value.reasons as string[]);
  },4096);
  this.heartbeat=setInterval(()=>{const elapsed=performance.now()-lastFrame;if(!ready&&elapsed>5000)fail('设备通知连接超时，可手动刷新设备列表');else if(ready&&elapsed>6500)fail('设备通知心跳中断，可手动刷新或重新连接通知');},1000);
  child.on('error',()=>fail('设备变化通知启动失败，可手动刷新设备列表'));
  child.stdout.on('error',()=>fail('设备通知管道中断'));child.stderr.on('error',()=>fail('设备通知诊断中断'));
  child.stdout.on('data',(chunk:Buffer)=>{
   if(failed||this.stopping||this.interrupted||this.maintenance.held)return;if(performance.now()-windowAt>=5000){windowAt=performance.now();bytes=0;diagnostics=0;}bytes+=chunk.length;if(bytes>32768){fail('设备通知超过速率预算，可手动刷新设备列表');return;}
   try{reader.push(chunk);}catch(error){fail(error instanceof Error?error.message:'设备通知无效');}
  });
  child.stderr.on('data',(chunk:Buffer)=>{diagnostics+=chunk.length;if(diagnostics>16384)fail('设备通知诊断超过预算');});
  child.once('close',()=>{
   if(this.child===child)this.child=null;
   if(!this.stopping&&!this.interrupted&&!this.maintenance.held&&!failed){try{reader.finish();}catch{/* Treat partial shutdown as unavailable. */}fail('设备变化通知已断开，可手动刷新或重新连接通知');}
   complete();
  });
  return promise;
 }
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{
  this.maintenanceResume=!this.stopping&&!this.interrupted&&['starting','watching'].includes(this.state.status);
  if(this.heartbeat)clearInterval(this.heartbeat);this.heartbeat=null;
  await waitForOwnedChildClose(this.child,()=>{this.child?.kill();this.changed('stopped','曲库维护，设备变化通知已暂停',[]);});
  await this.pending;if(this.child)throw new Error('设备通知进程仍未释放');
 });}
 endMaintenance(owner:string,resume:boolean):Promise<AudioDeviceWatchState>{
  const restart=this.maintenanceResume;this.maintenance.end(owner);this.maintenanceResume=false;
  return resume&&restart&&!this.stopping&&!this.interrupted?this.start():Promise.resolve(this.snapshot());
 }
 close():void{this.stopping=true;if(this.heartbeat)clearInterval(this.heartbeat);this.heartbeat=null;this.child?.kill();this.changed('stopped','设备变化通知已关闭',[]);}
 suspendForSystem():void{++this.systemEpoch;this.interrupted=true;if(this.heartbeat)clearInterval(this.heartbeat);this.heartbeat=null;this.child?.kill();this.changed('stopped','系统休眠，设备目录与能力观察已失效',[]);}
 async resumeAfterSystem():Promise<AudioDeviceWatchState>{
  const epoch=this.systemEpoch,child=this.child;
  try{
  if(child&&child.exitCode===null&&child.signalCode===null)await new Promise<void>((resolve,reject)=>{
   const finish=()=>{clearTimeout(timer);resolve();};
   const timer=setTimeout(()=>{child.off('close',finish);reject(new Error('旧设备通知进程尚未退出，未重连'));},2500);child.once('close',finish);
  });
  if(this.stopping||epoch!==this.systemEpoch)return this.snapshot();
  if(this.child)throw new Error('旧设备通知句柄尚未释放，未重连');
  this.interrupted=false;return this.start();
  }catch(error){if(!this.stopping&&epoch===this.systemEpoch)this.changed('unavailable','系统唤醒后的设备通知重连未完成，可手动刷新或重连',[]);throw error;}
 }
}
