import {MaintenanceHold} from './maintenance-hold.js';
import type {PlaybackCoordinator} from './playback.js';
import type {PlaybackHistoryRecorder} from './playback-history.js';

type Resource={name:string;begin:(owner:string)=>Promise<void>;end:(owner:string,resume:boolean)=>Promise<unknown>|void};
type Ports={pause:()=>void;resume:()=>void;resumeError?:(message:string)=>void;playback:PlaybackCoordinator;history:PlaybackHistoryRecorder;resources:readonly Resource[]};

// Private Main half of backup maintenance. It does not authorize a capture:
// Renderer freeze and the Library maintenance lease are separate requirements.
export class MainCatalogResources {
 private readonly hold=new MaintenanceHold();private releaseWork:Promise<void>|null=null;
 private releaseOwner='';private resumeIntent:boolean|null=null;
 private restoreRelease:{owner:string;resume:boolean;work:Promise<void>;released:boolean}|null=null;
 private readonly restoreReads=new Set<Promise<unknown>>();
 private finalBarrier:{owner:string;released:boolean;historySha256:string|null}|null=null;
 constructor(private readonly ports:Ports){}
 get held():boolean{return this.hold.held||this.finalBarrier!==null;}
 assertAvailable():void{if(this.finalBarrier)throw new Error('曲库恢复尚未持久完成，操作继续暂停');this.hold.assertAvailable();}
 assertFrozen(owner:string):void{this.hold.assertFrozen(owner);if(this.restoreRelease)throw new Error('恢复主程序资源已请求释放，不能作为冻结资源使用');}
 // The outer request gate remains owned after individual resources resume.
 assertHeld(owner:string):void{if(this.finalBarrier?.released)this.assertFinalBarrier(owner,true);else this.hold.assertFrozen(owner);}
 restoreResourceNames():string[]{return this.ports.resources.map(resource=>resource.name);}
 run<T>(action:()=>Promise<T>|T):Promise<T>{try{this.assertAvailable();}catch(error){return Promise.reject(error);}return this.hold.run(()=>{this.assertAvailable();return action();});}
 begin(owner:string):Promise<void>{if(this.finalBarrier)return Promise.reject(new Error('已有未完成恢复的独立交互占用'));return this.hold.begin(owner,async()=>{
  this.releaseWork=null;this.releaseOwner='';this.resumeIntent=null;this.restoreRelease=null;this.ports.pause();
  // Register every hold synchronously, including keyboard routing, before any
  // native close event can trigger a fallback or another resource operation.
  const names=['播放输出',...this.ports.resources.map(r=>r.name)];
  const begin=[()=>this.ports.playback.beginMaintenance(owner),...this.ports.resources.map(r=>()=>r.begin(owner))];
  const work=begin.map(action=>{try{return action();}catch(error){return Promise.reject(error);}});
  const results=await Promise.allSettled(work);
  const errors=results.flatMap((result,i)=>result.status==='rejected'?[names[i]+'：'+String(result.reason instanceof Error?result.reason.message:result.reason).slice(0,300)]:[]);
  if(errors.length)throw new Error(errors.join('；').slice(0,1024));
  await this.hold.waitRequests();
  // Output observation has ceased and all prior Main requests have settled.
  // Flush/persist Main memory while the Library still accepts checkpoints.
  await this.ports.history.beginMaintenance(owner);
 });}
 release(owner:string,resumeBackground:boolean):Promise<void>{
  if(this.restoreRelease)return Promise.reject(new Error('恢复资源已进入分阶段释放，普通维护释放不能开放交互'));
  if(this.releaseWork){if(owner!==this.releaseOwner||resumeBackground!==this.resumeIntent)return Promise.reject(new Error('主窗口维护释放身份或恢复意图不同'));return this.releaseWork;}
  // A premature or wrong-owner request must not poison the actual release.
  this.hold.assertFrozen(owner);
  this.releaseOwner=owner;this.resumeIntent=resumeBackground;
  const work=Promise.resolve().then(async()=>{
   this.hold.assertFrozen(owner);
   await this.endResources(owner,resumeBackground);
   this.ports.history.endMaintenance(owner);this.ports.playback.endMaintenance(owner);
   this.hold.end(owner);if(resumeBackground)this.ports.resume();
  });this.releaseWork=work;void work.catch(()=>{});return work;
 }
 private async endResources(owner:string,resume:boolean,authorize:()=>void=()=>{}):Promise<void>{
  const results=await Promise.allSettled(this.ports.resources.map(resource=>Promise.resolve().then(()=>{authorize();return resource.end(owner,resume);}))),errors=results.flatMap((result,index)=>result.status==='rejected'?[this.ports.resources[index].name+'：'+String(result.reason instanceof Error?result.reason.message:result.reason).slice(0,300)]:[]);
  if(errors.length)throw new Error(errors.join('；').slice(0,1024));authorize();
 }
 releaseRestoreResources(owner:string,resume:boolean,authorize:()=>void):Promise<void>{
  authorize();this.assertHeld(owner);if(this.releaseWork)throw new Error('普通维护已请求释放，不能进入恢复释放');
  if(this.restoreRelease){if(this.restoreRelease.owner!==owner||this.restoreRelease.resume!==resume)throw new Error('恢复主程序资源释放身份或意图不同');return this.restoreRelease.work;}
  this.ports.playback.assertRestoreFrozen(owner);this.ports.history.restoreSnapshot(owner);
  const work=Promise.resolve().then(async()=>{authorize();this.assertHeld(owner);await this.endResources(owner,resume,authorize);this.ports.playback.assertRestoreFrozen(owner);this.ports.history.restoreSnapshot(owner);this.assertHeld(owner);authorize();this.restoreRelease!.released=true;});
  this.restoreRelease={owner,resume,work,released:false};void work.catch(()=>{});return work;
 }
 assertRestoreResourcesReleased(owner:string):void{
  this.assertHeld(owner);if(!this.restoreRelease?.released||this.restoreRelease.owner!==owner)throw new Error('恢复主程序资源尚未全部确认释放');this.ports.playback.assertRestoreFrozen(owner);this.ports.history.restoreSnapshot(owner);
 }
 runRestoreRead<T>(owner:string,action:()=>Promise<T>|T,authorize:()=>void):Promise<T>{
  authorize();this.assertRestoreResourcesReleased(owner);
  const work=Promise.resolve().then(()=>{authorize();this.assertRestoreResourcesReleased(owner);return action();}).then(value=>{authorize();this.assertRestoreResourcesReleased(owner);return value;}).finally(()=>this.restoreReads.delete(work));this.restoreReads.add(work);return work;
 }
 async waitRestoreReads(owner:string):Promise<void>{this.assertRestoreResourcesReleased(owner);await Promise.allSettled([...this.restoreReads]);if(this.restoreReads.size)throw new Error('恢复界面仍有读取尚未结束');this.assertRestoreResourcesReleased(owner);}
 installFinalBarrier(owner:string):void{
  this.assertRestoreResourcesReleased(owner);if(this.restoreReads.size||this.finalBarrier)throw new Error('恢复读取未停止或最终交互占用已登记');this.finalBarrier={owner,released:false,historySha256:null};
 }
 assertFinalBarrier(owner:string,released=false):void{
  const barrier=this.finalBarrier;if(!barrier||barrier.owner!==owner||!this.restoreRelease?.released||this.restoreRelease.owner!==owner||this.restoreReads.size)throw new Error('恢复最终交互占用或读取停止未确认');
  if(!barrier.released){if(released)throw new Error('恢复播放及历史资源尚未释放');this.hold.assertFrozen(owner);this.ports.playback.assertRestoreFrozen(owner);this.ports.history.restoreSnapshot(owner);return;}
  if(this.hold.held||this.ports.playback.maintenanceIsHeld||!barrier.historySha256)throw new Error('恢复普通维护占用尚未释放');this.ports.playback.assertRestoreStopped(owner);this.ports.history.assertRestoreCompletionQuiet(owner,barrier.historySha256);
 }
 async releaseFinalOwners(owner:string,historySha256:string,authorize:()=>void):Promise<void>{
  authorize();this.assertFinalBarrier(owner);if(this.finalBarrier!.released)throw new Error('恢复最终资源不能重复释放');
  await this.ports.history.assertRestorePendingResult(owner,historySha256,authorize);authorize();this.assertFinalBarrier(owner);
  // Install the history completion barrier before ending its ordinary hold.
  // No timer/checkpoint can race the not-yet-durable completion decision.
  this.ports.history.endRestoreMaintenance(owner,historySha256);this.ports.playback.endRestoreMaintenance(owner);this.hold.end(owner);
  this.finalBarrier!.historySha256=historySha256;this.finalBarrier!.released=true;this.assertFinalBarrier(owner,true);authorize();
 }
 completeFinalBarrier(owner:string):void{
  this.assertFinalBarrier(owner,true);const historySha256=this.finalBarrier!.historySha256!,resume=this.restoreRelease!.resume;
  this.ports.history.completeRestore(owner,historySha256);this.ports.playback.completeRestore(owner);this.finalBarrier=null;this.restoreRelease=null;this.releaseWork=null;this.releaseOwner='';this.resumeIntent=null;
  if(resume)try{this.ports.resume();}catch(error){try{this.ports.resumeError?.('曲库恢复已完成，后台界面刷新未完成：'+String(error instanceof Error?error.message:error).slice(0,500));}catch{/* Completion is already durable; diagnostic failure does not undo it. */}}
 }
}
