import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import {RELEASE} from '../shared/release.js';
import {backupUuid} from '../shared/catalog-backup.js';
import {readRestoreApplyRequest,readCatalogRestoreConsent,readRestoreApplyState,initialRestoreApplyState,restoreApplyActive,type CatalogRestoreApplyState,type RestoreApplyRequest} from '../shared/catalog-restore-consent.js';
import type {CatalogRestoreCoordinator} from './catalog-restore.js';
import type {CatalogRestoreCutover} from './catalog-restore-cutover.js';

type Ports={preview:CatalogRestoreCoordinator;cutover:CatalogRestoreCutover;admit:()=>void;available:()=>boolean;publish:(state:CatalogRestoreApplyState)=>void};
const message=(error:unknown)=>String(error instanceof Error?error.message:error).slice(0,1024)||'恢复未确认完成，原资料及记录保留';
// A short IPC accepts one explicit review. The owned Main operation then
// survives its planned document replacement; old IPC delivery is not completion.
export class CatalogRestoreApply{
 private state:CatalogRestoreApplyState={...initialRestoreApplyState};private identity='';private accepted:Promise<CatalogRestoreApplyState>|null=null;private work:Promise<void>|null=null;private closed=false;private stopped='';
 constructor(private readonly ports:Ports){}
 get busy():boolean{return Boolean(this.accepted||this.work);}
 snapshot():CatalogRestoreApplyState{return readRestoreApplyState(this.state);}
 owns(value:unknown):boolean{return backupUuid(value)===this.state.operationId&&restoreApplyActive(this.state);}
 private change(patch:Partial<CatalogRestoreApplyState>):void{this.state={...this.state,...patch};try{this.ports.publish(this.snapshot());}catch{/* The operation, not event delivery, owns completion. */}}
 private check(authorize:()=>void):void{if(this.closed||this.stopped||!this.ports.available())throw new Error(this.stopped||'恢复确认所属应用已变化');authorize();}
 start(value:unknown,authorize:()=>void):Promise<CatalogRestoreApplyState>{
  const request=readRestoreApplyRequest(value),identity=JSON.stringify(request);authorize();
  if(request.transactionId===this.state.operationId){if(this.identity!==identity)throw new Error('原恢复确认不能改变来源或审核内容');return this.accepted??Promise.resolve(this.snapshot());}
  if(this.busy||this.closed||this.ports.cutover.busy||!this.ports.available())throw new Error('已有恢复操作或应用尚未准备好');
  this.ports.admit();
  this.identity=identity;this.stopped='';this.state={version:1,operationId:request.transactionId,sourceId:request.sourceId,phase:'checking',message:'正在核对本次恢复确认与原审核资料。',cancelRequested:false};this.change({});
  const accepted=Promise.resolve().then(()=>this.accept(request,authorize)).catch(error=>{this.change({phase:'interrupted',message:message(error)});throw error;}).finally(()=>{if(this.accepted===accepted)this.accepted=null;});this.accepted=accepted;void accepted.catch(()=>{});return accepted;
 }
 private async accept(request:RestoreApplyRequest,authorize:()=>void):Promise<CatalogRestoreApplyState>{
  this.check(authorize);const review=await this.ports.preview.review(request.sourceId,authorize);this.check(authorize);
  if(lifecycleDigest(review)!==request.reviewSha256)throw new Error('审核内容已经变化，请重新阅读并确认');
  const consent=readCatalogRestoreConsent({version:1,transactionId:request.transactionId,sourceId:request.sourceId,preparedSha256:review.preparedSha256,stageIdentity:review.stageIdentity,checkSha256:review.checkSha256,reviewSha256:request.reviewSha256,checkedAt:review.checkedAt,acceptedAt:new Date().toISOString(),origin:review.evidence.origin,backupSha256:review.preview.sha256,buildId:RELEASE.mainBuildId,policy:review.policy,replaceLibrary:true,confirmAccessReset:true,keepPendingForReview:true});
  this.change({phase:'preparing',message:'已接受恢复确认，正在准备候选曲库和当前曲库的一致快照。'});
  const work=this.run(request,consent,authorize);this.work=work;void work.finally(()=>{if(this.work===work)this.work=null;}).catch(()=>{});return this.snapshot();
 }
 private async run(request:RestoreApplyRequest,consent:ReturnType<typeof readCatalogRestoreConsent>,authorize:()=>void):Promise<void>{
  const timer=setTimeout(()=>{this.stopped||='恢复超过3小时，原资料和记录保留等待核对。';this.ports.cutover.interrupt(this.stopped);},3*60*60*1000);
  try{
   this.check(authorize);const selected=await this.ports.cutover.apply(request.transactionId,request.sourceId,()=>this.check(authorize),consent);this.check(authorize);
   this.change({phase:'finishing',message:selected.phase==='original-readonly'?'候选曲库未能启用，正在核对并返回原曲库。':'曲库切换已核对，正在恢复设置和新界面。'});
   // prepareCompletion transfers authorization to its independently checked new
   // document before the original sender frame becomes unavailable.
   const completed=await this.ports.cutover.prepareCompletion(request.transactionId,()=>this.check(authorize));
   const proof=completed.cutover.completed;if(!proof||proof.operationId!==request.transactionId)throw new Error('恢复完成证明不属于原确认');
   this.change({phase:proof.role==='candidate'?'applied':'retained',message:proof.role==='candidate'?'备份曲库已恢复。播放保持停止，请重新确认音乐目录及在线设置。':('已返回原曲库，备份未替换当前资料。原恢复记录保留，播放保持停止。'+(selected.reason?' 原因：'+selected.reason:'')).slice(0,1024)});
  }catch(error){const reason=message(error);this.ports.cutover.interrupt(reason);this.change({phase:'interrupted',message:reason});}finally{clearTimeout(timer);}
 }
 cancel(value:unknown):boolean{
  if(!this.owns(value))throw new Error('恢复应用操作已变化');this.stopped||='已请求停止恢复，保留资料及记录等待核对。';this.change({cancelRequested:true,message:this.stopped});
  if(this.ports.cutover.owns(this.state.operationId!))this.ports.cutover.cancel(this.state.operationId);return true;
 }
 close():Promise<unknown>{this.closed=true;if(restoreApplyActive(this.state)){this.stopped||='应用退出，恢复资料和记录保留等待核对。';this.ports.cutover.interrupt(this.stopped);}return Promise.allSettled([this.accepted,this.work]);}
}
