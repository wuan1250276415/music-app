import {MaintenanceHold,waitForOwnedChildClose} from './maintenance-hold.js';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {FrameReader} from './audio-protocol.js';
import {RELEASE} from '../shared/release.js';
import {validEndpoint} from '../shared/audio-output.js';
import {validateAudioCapabilities} from '../shared/audio-capabilities.js';
import type {AudioDevice,AudioDeviceCapabilities} from '../shared/contracts.js';
export class WasapiCapabilityProbe{
 private readonly maintenance=new MaintenanceHold();
 private child:ChildProcessWithoutNullStreams|null=null;
 private pending:{id:string;promise:Promise<AudioDeviceCapabilities>}|null=null;
 constructor(private readonly executable:string,private readonly revision:()=>number=()=>0){}
 inspect(device:AudioDevice):Promise<AudioDeviceCapabilities>{return this.maintenance.run(()=>this.inspectNow(device));}
 private inspectNow(device:AudioDevice):Promise<AudioDeviceCapabilities>{
  if(!validEndpoint(device.id)||!validEndpoint(device.name))return Promise.reject(new Error('设备标识无效'));
  if(this.pending)return this.pending.id===device.id?this.pending.promise:Promise.reject(new Error('正在读取另一设备的格式，请稍后重试'));
  if(this.child)return Promise.reject(new Error('设备能力查询进程尚未确认退出，请稍后重试'));
  const revision=this.revision(),nonce=randomUUID(),child=spawn(this.executable,['--device-info',nonce,String(process.pid),device.id],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;child.stdin.end();
  const promise=new Promise<AudioDeviceCapabilities>((resolve,reject)=>{
   let bytes=0,diagnostics=0,failed:Error|null=null,result:AudioDeviceCapabilities|null=null,settled=false,exitDeadline:NodeJS.Timeout|undefined;
   const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(deadline);if(exitDeadline)clearTimeout(exitDeadline);error?reject(error):resolve(result!);};
   const cancel=(error:Error)=>{failed??=error;child.kill();if(!exitDeadline)exitDeadline=setTimeout(()=>finish(new Error('设备能力查询进程未确认退出，已阻止再次查询')),2500);};
   const deadline=setTimeout(()=>cancel(new Error('设备格式查询超时，请检查驱动')),25000);
   const reader=new FrameReader(value=>{
    if(result||Object.keys(value).length!==5||value.backend!=='wasapi'||value.buildId!==RELEASE.hostBuildId||value.nonce!==nonce||!value.protocol||typeof value.protocol!=='object'||(value.protocol as {major:unknown;minor:unknown}).major!==RELEASE.audioProtocol.major||(value.protocol as {minor:unknown}).minor!==RELEASE.audioProtocol.minor)throw new Error('设备能力回执身份无效');
    result=validateAudioCapabilities(value.capabilities,device.id,device.name,revision);
   });
   child.on('error',error=>cancel(error));child.stdout.on('error',()=>cancel(new Error('设备能力回执中断')));child.stderr.on('error',()=>cancel(new Error('设备能力诊断中断')));
   child.stdout.on('data',(chunk:Buffer)=>{if(failed)return;bytes+=chunk.length;if(bytes>256*1024+4){cancel(new Error('设备能力回执超过预算'));return;}try{reader.push(chunk);}catch(error){cancel(error as Error);}});
   child.stderr.on('data',(chunk:Buffer)=>{diagnostics+=chunk.length;if(diagnostics>16384)cancel(new Error('设备能力诊断超过预算'));});
   child.once('close',(code,signal)=>{this.child=null;try{reader.finish();if(failed)throw failed;if(this.revision()!==revision)throw new Error('设备在查询期间发生变化，格式报告已丢弃，请重新读取');if(code!==0||signal||!result)throw new Error(`设备格式查询失败（${code??'未知'}），请刷新设备列表`);finish();}catch(error){finish(error as Error);}});
  });
  this.pending={id:device.id,promise};void promise.then(()=>{if(this.pending?.promise===promise)this.pending=null;},()=>{if(this.pending?.promise===promise)this.pending=null;});return promise;
 }
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{await waitForOwnedChildClose(this.child,()=>this.close());await this.pending?.promise.catch(()=>{});if(this.child)throw new Error('设备能力进程仍未释放');});}
 endMaintenance(owner:string):void{this.maintenance.end(owner);}
 close():void{this.child?.kill();}
 isIdle():boolean{return this.child===null;}
}
