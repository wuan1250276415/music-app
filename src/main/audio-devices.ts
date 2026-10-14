import {MaintenanceHold,waitForOwnedChildClose} from './maintenance-hold.js';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {FrameReader} from './audio-protocol.js';
import {RELEASE} from '../shared/release.js';
import {validEndpoint} from '../shared/audio-output.js';
import type {AudioDeviceList,AudioDevice} from '../shared/contracts.js';
export class WasapiDevices{
 private readonly maintenance=new MaintenanceHold();
 private child:ChildProcessWithoutNullStreams|null=null;
 private pending:Promise<AudioDeviceList>|null=null;
 list():Promise<AudioDeviceList>{return this.maintenance.run(()=>this.listNow());}
 private listNow():Promise<AudioDeviceList>{
  if(this.pending)return this.pending;if(this.child)return Promise.reject(new Error('设备枚举进程尚未确认退出，请稍后重试'));
  const revision=this.revision(),nonce=randomUUID(),child=spawn(this.executable,['--devices',nonce,String(process.pid)],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;child.stdin.end();
  const promise=new Promise<AudioDeviceList>((resolve,reject)=>{
   let bytes=0,diagnostics=0,failed:Error|null=null,result:AudioDeviceList|null=null,settled=false,exitDeadline:NodeJS.Timeout|undefined;
   const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(deadline);if(exitDeadline)clearTimeout(exitDeadline);error?reject(error):resolve(result!);};
   const cancel=(error:Error)=>{failed??=error;child.kill();if(!exitDeadline)exitDeadline=setTimeout(()=>finish(new Error('设备枚举进程未确认退出，已阻止再次枚举')),2500);};
   const deadline=setTimeout(()=>cancel(new Error('读取输出设备超时，请检查驱动')),10000);
   const reader=new FrameReader(value=>{
    if(result||Object.keys(value).length!==7||value.backend!=='wasapi'||value.buildId!==RELEASE.hostBuildId||value.nonce!==nonce||!value.protocol||typeof value.protocol!=='object'||(value.protocol as {major:unknown;minor:unknown}).major!==RELEASE.audioProtocol.major||(value.protocol as {minor:unknown}).minor!==RELEASE.audioProtocol.minor||typeof value.truncated!=='boolean'||typeof value.incomplete!=='boolean'||!Array.isArray(value.devices)||value.devices.length>128)throw new Error('输出设备回执无效');
    const ids=new Set<string>(),devices:AudioDevice[]=[];
    for(const entry of value.devices){const d=entry as AudioDevice;if(!d||Object.keys(d).length!==3||!validEndpoint(d.id)||!validEndpoint(d.name)||typeof d.isDefault!=='boolean'||ids.has(d.id))throw new Error('输出设备条目无效');ids.add(d.id);devices.push({id:d.id,name:d.name,isDefault:d.isDefault});}
    if(devices.filter(d=>d.isDefault).length>1)throw new Error('默认输出设备标识不唯一');result={backend:'wasapi',devices,truncated:value.truncated,incomplete:value.incomplete,observedAt:Date.now(),deviceRevision:revision};
   });
   child.on('error',error=>cancel(error));child.stdout.on('error',()=>cancel(new Error('设备回执管道中断')));child.stderr.on('error',()=>cancel(new Error('设备诊断管道中断')));
   child.stdout.on('data',(chunk:Buffer)=>{if(failed)return;bytes+=chunk.length;if(bytes>256*1024+4){cancel(new Error('设备回执超过预算'));return;}try{reader.push(chunk);}catch(error){cancel(error as Error);}});
   child.stderr.on('data',(chunk:Buffer)=>{diagnostics+=chunk.length;if(diagnostics>16384)cancel(new Error('设备诊断超过预算'));});
   child.once('close',(code,signal)=>{this.child=null;try{reader.finish();if(failed)throw failed;if(this.revision()!==revision)throw new Error('设备在读取期间发生变化，请重新读取');if(code!==0||signal||!result)throw new Error(`WASAPI 设备枚举失败（${code??'未知'}）`);finish();}catch(error){finish(error as Error);}});
  });
  this.pending=promise;void promise.then(()=>{if(this.pending===promise)this.pending=null;},()=>{if(this.pending===promise)this.pending=null;});return promise;
 }
 constructor(private readonly executable:string,private readonly revision:()=>number=()=>0){}
 isCurrent(catalog:AudioDeviceList):boolean{return catalog.deviceRevision===this.revision();}
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{await waitForOwnedChildClose(this.child,()=>this.close());await this.pending?.catch(()=>{});if(this.child)throw new Error('设备枚举进程仍未释放');});}
 endMaintenance(owner:string):void{this.maintenance.end(owner);}
 close():void{this.child?.kill();}
}
