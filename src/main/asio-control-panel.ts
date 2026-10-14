import {MaintenanceHold,waitForOwnedChildClose} from './maintenance-hold.js';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {FrameReader,encodeFrame} from './audio-protocol.js';
import {RELEASE} from '../shared/release.js';
import {asioDriverId,type AsioDriverIdentity} from '../shared/asio-output.js';
import {readAsioPanelRequest,readAsioPanelOperation,readAsioPanelReply,type AsioPanelRequest,type AsioPanelState,type AsioPanelReply} from '../shared/asio-panel.js';
type Entry={identity:string;promise:Promise<AsioPanelState>;result:AsioPanelState|null;done:boolean};
type Context={request:AsioPanelRequest;nonce:string;child:ChildProcessWithoutNullStreams;entry:Entry;sequence:number;nativePhase:'opening'|AsioPanelReply['phase'];finishSent:boolean;
 failure:string|null;cancelled:boolean;opening:NodeJS.Timeout|null;lifetime:NodeJS.Timeout|null;finishTimer:NodeJS.Timeout|null;exitTimer:NodeJS.Timeout|null;
 resolveOpen:(s:AsioPanelState)=>void;openSettled:boolean;completion:Promise<AsioPanelState>;resolveCompletion:(s:AsioPanelState)=>void;completionSettled:boolean;last:AsioPanelReply|null};
export class AsioControlPanel {
 private readonly maintenance=new MaintenanceHold();
 private state:AsioPanelState={revision:0,operationId:null,driver:null,phase:'idle',message:'尚未打开 ASIO 驱动面板',observedAt:Date.now(),processReleased:true,driverReleased:false,hardwareVerified:false};
 private current:Context|null=null;private receipts=new Map<string,Entry>();private shuttingDown=false;
 constructor(private readonly executable:string,private readonly canOpen:()=>boolean,private readonly invalidate:()=>void,private readonly publish:(state:AsioPanelState)=>void){}
 snapshot():AsioPanelState{return structuredClone(this.state);}
 isReleased():boolean{return this.current===null;}
 assertReleased():void{if(this.current)throw new Error('ASIO 驱动面板进程尚未释放，请先完成或取消驱动设置');}
 private update(patch:Partial<AsioPanelState>):void{
  this.state={...this.state,...patch,revision:this.state.revision+1,observedAt:Date.now(),hardwareVerified:false};
  const entry=this.state.operationId?this.receipts.get(this.state.operationId):undefined;if(entry)entry.result=this.snapshot();
  try{this.publish(this.snapshot());}catch{/* UI delivery does not change process ownership. */}
 }
 private settleOpen(c:Context):void{if(!c.openSettled){c.openSettled=true;c.resolveOpen(this.snapshot());}}
 private settleCompletion(c:Context):void{if(!c.completionSettled){c.completionSettled=true;c.resolveCompletion(this.snapshot());}}
 open(value:unknown):Promise<AsioPanelState>{
  this.maintenance.assertAvailable();
  const request=readAsioPanelRequest(value),identity=asioDriverId(request.driver),old=this.receipts.get(request.commandId);
  if(old){if(old.identity!==identity)throw new Error('ASIO 面板操作 ID 已用于其他驱动');return old.promise.then(result=>structuredClone(old.result??result));}
  if(this.shuttingDown||this.current||!this.canOpen())throw new Error('请先停止播放、等待旧音频及查询进程释放，再打开 ASIO 驱动面板');
  if(this.receipts.size>=128){for(const [id,e] of this.receipts)if(e.done){this.receipts.delete(id);break;}if(this.receipts.size>=128)throw new Error('ASIO 面板操作过多，请稍后重试');}
  let resolveOpen!:(s:AsioPanelState)=>void,resolveCompletion!:(s:AsioPanelState)=>void;
  const entry:Entry={identity,promise:new Promise(resolve=>{resolveOpen=resolve;}),result:null,done:false};
  this.receipts.set(request.commandId,entry);this.invalidate();
  const nonce=randomUUID();let child:ChildProcessWithoutNullStreams;
  try{child=spawn(this.executable,['--asio-panel',nonce,String(process.pid),request.driver.registryName,request.driver.clsid,request.commandId],{windowsHide:true,stdio:['pipe','pipe','pipe']});}
  catch{entry.done=true;this.update({operationId:request.commandId,driver:{...request.driver,description:''},phase:'failed',message:'无法启动 ASIO 驱动面板组件',processReleased:true,driverReleased:false});resolveOpen(this.snapshot());return entry.promise;}
  const c:Context={request,nonce,child,entry,sequence:0,nativePhase:'opening',finishSent:false,failure:null,cancelled:false,opening:null,lifetime:null,finishTimer:null,exitTimer:null,resolveOpen,openSettled:false,completion:new Promise(resolve=>{resolveCompletion=resolve;}),resolveCompletion,completionSettled:false,last:null};
  this.current=c;this.update({operationId:request.commandId,driver:{...request.driver,description:''},phase:'opening',message:'正在初始化所选 ASIO 驱动',processReleased:false,driverReleased:false});
  c.opening=setTimeout(()=>this.abort(c,'ASIO 驱动面板初始化超时',false),25000);
  c.lifetime=setTimeout(()=>this.abort(c,'ASIO 驱动面板会话超过 15 分钟，已请求结束',false),900000);
  let bytes=0,diagnostics=0;
  const reader=new FrameReader(reply=>{
   if(this.current!==c||c.cancelled||c.failure)return;
   if(Object.keys(reply).length!==7||reply.version!==1||reply.backend!=='asio'||reply.operation!=='panel'||reply.buildId!==RELEASE.hostBuildId||reply.nonce!==c.nonce||reply.architecture!=='x64')throw new Error('ASIO 面板回执身份无效');
   const next=readAsioPanelReply(reply.payload,request.driver,c.sequence);
   const allowed=c.nativePhase==='opening'?['calling','failed']:c.nativePhase==='calling'?['returned','failed']:c.nativePhase==='returned'?['closed','failed']:[];
   if(!allowed.includes(next.phase)||next.phase==='closed'&&!c.finishSent)throw new Error('ASIO 面板回执阶段与请求不符');
   c.sequence=next.sequence;c.nativePhase=next.phase;c.last=next;
   if(c.opening){clearTimeout(c.opening);c.opening=null;}
   if(next.phase==='calling'){
    this.update({driver:next.identity,phase:'calling',message:'已请求厂商驱动面板；请在厂商窗口中完成设置'});this.settleOpen(c);
   }else if(next.phase==='returned')this.update({driver:next.identity,phase:'returned',message:'驱动调用已返回；确认完成设置后释放驱动面板会话'});
   else{
    this.update({driver:next.identity,phase:'finishing',message:next.phase==='closed'?'驱动已释放，正在确认面板进程退出':'驱动面板调用未完成，正在确认进程退出',driverReleased:true});this.armExit(c);
   }
  },16384);
  child.on('error',error=>this.abort(c,`ASIO 面板进程不可用：${error.message}`,false));
  child.stdin.on('error',()=>this.abort(c,'ASIO 面板控制通道中断',false));
  child.stdout.on('error',()=>this.abort(c,'ASIO 面板回执通道中断',false));
  child.stderr.on('error',()=>this.abort(c,'ASIO 面板诊断通道中断',false));
  child.stdout.on('data',(chunk:Buffer)=>{if(this.current!==c||c.failure||c.cancelled)return;bytes+=chunk.length;if(bytes>65536){this.abort(c,'ASIO 面板回执超过预算',false);return;}try{reader.push(chunk);}catch(error){this.abort(c,error instanceof Error?error.message:String(error),false);}});
  child.stderr.on('data',(chunk:Buffer)=>{diagnostics+=chunk.length;if(diagnostics>65536)this.abort(c,'ASIO 面板诊断超过预算',false);});
  child.once('close',(code,signal)=>{
   if(this.current!==c)return;for(const timer of [c.opening,c.lifetime,c.finishTimer,c.exitTimer])if(timer)clearTimeout(timer);
   if(!c.cancelled&&!c.failure){try{reader.finish();}catch(error){c.failure=error instanceof Error?error.message:String(error);}}
   this.current=null;this.invalidate();entry.done=true;
   const clean=code===0&&!signal&&c.last?.driverReleased===true;
   this.update({phase:c.cancelled?'cancelled':!c.failure&&clean&&c.last?.phase==='closed'?'closed':'failed',processReleased:true,driverReleased:clean,
    message:c.cancelled?'面板会话已取消；厂商设置结果未确认，请重新读取驱动信息':c.failure??(!clean?'面板进程已退出，驱动设置及释放结果未确认':c.last?.phase==='closed'?'驱动面板会话已释放，请重新读取声道和缓冲信息':'所选驱动未能完成面板调用')});
   this.settleOpen(c);this.settleCompletion(c);
  });
  return entry.promise;
 }
 private armExit(c:Context):void{
  if(c.exitTimer)return;c.exitTimer=setTimeout(()=>{
   if(this.current!==c)return;c.child.kill();
   c.exitTimer=setTimeout(()=>{if(this.current!==c)return;this.update({phase:'release-unknown',message:'ASIO 面板进程尚未确认退出，播放保持停止',processReleased:false,driverReleased:false});this.settleOpen(c);this.settleCompletion(c);},2500);
  },2500);
 }
 private abort(c:Context,message:string,cancelled:boolean):void{
  if(this.current!==c)return;c.cancelled ||=cancelled;c.failure??=message;
  if(c.opening){clearTimeout(c.opening);c.opening=null;}if(c.finishTimer){clearTimeout(c.finishTimer);c.finishTimer=null;}
  this.update({phase:'finishing',message,driverReleased:false});c.child.kill();this.armExit(c);
 }
 finish(value:unknown):Promise<AsioPanelState>{
  const id=readAsioPanelOperation(value),c=this.current;
  if(!c){if(id===this.state.operationId)return Promise.resolve(this.snapshot());throw new Error('ASIO 面板会话已变化');}
  if(c.request.commandId!==id)throw new Error('ASIO 面板会话已变化');
  if(c.finishSent||c.cancelled||c.failure)return c.completion;
  if(c.nativePhase!=='returned')throw new Error('请先关闭厂商面板并等待驱动调用返回，再释放会话；无法返回时可取消');
  c.finishSent=true;this.update({phase:'finishing',message:'正在释放 ASIO 驱动面板会话'});
  c.finishTimer=setTimeout(()=>this.abort(c,'ASIO 面板驱动释放超时',false),5000);
  try{c.child.stdin.write(encodeFrame({nonce:c.nonce,operationId:id,action:'finish',commandId:randomUUID()}),error=>{if(error)this.abort(c,'ASIO 面板释放命令未能发送',false);});}
  catch{this.abort(c,'ASIO 面板释放命令未能发送',false);}return c.completion;
 }
 cancel(value:unknown):Promise<AsioPanelState>{
  const id=readAsioPanelOperation(value),c=this.current;if(!c){if(id===this.state.operationId)return Promise.resolve(this.snapshot());throw new Error('ASIO 面板会话已变化');}
  if(c.request.commandId!==id)throw new Error('ASIO 面板会话已变化');this.abort(c,'正在取消 ASIO 驱动面板会话',true);return c.completion;
 }
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{
  const current=this.current;await waitForOwnedChildClose(current?.child??null,()=>{if(current)this.abort(current,'曲库维护正在释放 ASIO 驱动面板',true);});
  if(this.current)throw new Error('ASIO 面板进程仍未释放');
 });}
 endMaintenance(owner:string):void{this.maintenance.end(owner);}
 suspend():void{const c=this.current;if(c)this.abort(c,'系统正在休眠，正在释放 ASIO 驱动面板',true);}
 close():void{this.shuttingDown=true;const c=this.current;if(c)this.abort(c,'应用正在释放 ASIO 驱动面板',true);}
}
