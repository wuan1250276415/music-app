import {MaintenanceHold,waitForOwnedChildClose} from './maintenance-hold.js';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {FrameReader} from './audio-protocol.js';
import {RELEASE} from '../shared/release.js';
import {asioDriverId,validateAsioDriverKey,validateAsioCatalog,validateAsioCapabilities,type AsioDriverKey,type AsioDriverCatalog,type AsioCapabilities} from '../shared/asio-output.js';

export class AsioDrivers {
 private readonly maintenance=new MaintenanceHold();
 private child:ChildProcessWithoutNullStreams|null=null;
 private inspectingChild:ChildProcessWithoutNullStreams|null=null;
 private epoch=0;
 private pending:{key:string;promise:Promise<unknown>}|null=null;
 private capabilities:{key:string;revision:number;expires:number;value:AsioCapabilities}|null=null;
 constructor(private readonly executable:string,private readonly revision:()=>number,private readonly canInspect:()=>boolean){}
 isIdle():boolean{return this.child===null&&this.pending===null;}
 invalidateObservations():void{this.capabilities=null;}
 list():Promise<AsioDriverCatalog>{
  return this.query('catalog',[],value=>validateAsioCatalog(value,Date.now()));
 }
 inspect(value:unknown):Promise<AsioCapabilities>{
  const driver=validateAsioDriverKey(value);
  if(!this.canInspect())return Promise.reject(new Error('请先停止播放，再读取 ASIO 驱动能力；读取会初始化所选驱动，但不开始播放'));
  const revision=this.revision(),epoch=this.epoch;this.capabilities=null;
  return this.query('inspect',[driver.registryName,driver.clsid],value=>validateAsioCapabilities(value,driver,Date.now())).then(report=>{
   if(this.revision()!==revision||this.epoch!==epoch)throw new Error('设备在查询期间发生变化或查询已取消，请重新读取 ASIO 驱动');
   this.capabilities={key:asioDriverId(driver),revision,expires:performance.now()+60000,value:report};return report;
  });
 }
 observed(driver:AsioDriverKey):AsioCapabilities {
  const found=this.capabilities;
  if(!found||found.key!==asioDriverId(driver)||found.revision!==this.revision()||performance.now()>found.expires)throw new Error('请重新读取所选 ASIO 驱动的声道能力，报告已过期或设备已变化');
  return found.value;
 }
 private query<T>(operation:'catalog'|'inspect',args:string[],validate:(value:unknown)=>T):Promise<T>{
  this.maintenance.assertAvailable();
  const key=JSON.stringify([operation,args]);
  if(this.pending)return this.pending.key===key?this.pending.promise as Promise<T>:Promise.reject(new Error('正在读取 ASIO 驱动，请稍后重试'));
  if(this.child)return Promise.reject(new Error('ASIO 查询进程尚未确认退出，已阻止再次查询'));
  const epoch=this.epoch,nonce=randomUUID(),child=spawn(this.executable,[operation==='catalog'?'--asio-catalog':'--asio-info',nonce,String(process.pid),...args],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  this.child=child;if(operation==='inspect')this.inspectingChild=child;child.stdin.end();
  const promise=new Promise<T>((resolve,reject)=>{
   let bytes=0,diagnostics=0,failed:Error|null=null,result:T|undefined,seen=false,settled=false,exitDeadline:NodeJS.Timeout|undefined;
   const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(deadline);if(exitDeadline)clearTimeout(exitDeadline);error?reject(error):resolve(result!);};
   const cancel=(error:Error)=>{failed??=error;child.kill();if(!exitDeadline)exitDeadline=setTimeout(()=>finish(new Error('ASIO 查询进程未确认退出，已阻止再次查询')),2500);};
   const deadline=setTimeout(()=>cancel(new Error(operation==='inspect'?'ASIO 能力读取超时，请检查驱动':'ASIO 驱动列表读取超时')),operation==='inspect'?25000:10000);
   const reader=new FrameReader(reply=>{
    if(seen||Object.keys(reply).length!==7||reply.version!==1||reply.backend!=='asio'||reply.operation!==operation||reply.buildId!==RELEASE.hostBuildId||reply.nonce!==nonce||reply.architecture!=='x64')throw new Error('ASIO 查询回执身份无效');
    result=validate(reply.payload);seen=true;
   },256*1024);
   child.on('error',error=>cancel(error));child.stdout.on('error',()=>cancel(new Error('ASIO 查询回执管道中断')));child.stderr.on('error',()=>cancel(new Error('ASIO 查询诊断管道中断')));
   child.stdout.on('data',(chunk:Buffer)=>{if(failed)return;bytes+=chunk.length;if(bytes>256*1024+4){cancel(new Error('ASIO 查询回执超过预算'));return;}try{reader.push(chunk);}catch(error){cancel(error as Error);}});
   child.stderr.on('data',(chunk:Buffer)=>{diagnostics+=chunk.length;if(diagnostics>16384)cancel(new Error('ASIO 查询诊断超过预算'));});
   child.once('close',(code,signal)=>{if(this.child===child)this.child=null;if(this.inspectingChild===child)this.inspectingChild=null;try{reader.finish();if(failed)throw failed;if(this.epoch!==epoch)throw new Error('ASIO 查询已取消，结果已丢弃');if(code!==0||signal||!seen)throw new Error(`ASIO 查询失败（${code??'未知'}），驱动可能不可用`);finish();}catch(error){finish(error as Error);}});
  });
  this.pending={key,promise};const clear=()=>{if(this.pending?.promise===promise)this.pending=null;};void promise.then(clear,clear);return promise;
 }
 assertReleased():void{if(this.inspectingChild)throw new Error('ASIO 驱动查询进程尚未确认退出，请稍后再播放');}
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{await waitForOwnedChildClose(this.child,()=>this.close());await this.pending?.promise.catch(()=>{});if(this.child||this.inspectingChild)throw new Error('ASIO 查询进程仍未释放');});}
 endMaintenance(owner:string):void{this.maintenance.end(owner);}
 close():void{this.epoch++;this.capabilities=null;this.child?.kill();}
}
