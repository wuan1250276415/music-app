import {utilityProcess,type UtilityProcess} from 'electron';
import {backupUuid} from '../shared/catalog-backup.js';
import {readRestoreFrame,readRestoreState,RESTORE_FRAME_BYTES,type CatalogRestoreState,type CatalogRestorePreview,type CatalogRestorePrepared} from '../shared/catalog-restore.js';
import {CatalogRestoreStore,type RestoreReservation,type LoadedRestorePrepared} from './catalog-restore-store.js';
import type {CatalogRestoreHistory} from '../shared/catalog-restore-history.js';
import {readCatalogRestoreReview,bindRestoreReviewEvidence,type CatalogRestoreReview,type RestoreReviewEvidence} from '../shared/catalog-restore-review.js';
import type {CatalogRestoreCompatibility} from '../shared/catalog-restore-compatibility.js';
type Ports={dataDir:string;workerPath:string;ready:()=>boolean;busy:()=>boolean;pick:()=>Promise<string|null>;publish:(state:CatalogRestoreState)=>void};
const message=(e:unknown)=>String(e instanceof Error?e.message:e).slice(0,1024)||'恢复预览失败';
export class CatalogRestoreCoordinator {
 private state:CatalogRestoreState={operationId:null,phase:'idle',bytes:0,total:0,message:'',preview:null,cancelRequested:false};
 private work:Promise<CatalogRestorePreview|null>|null=null;private owner:UtilityProcess|null=null;private closed=false;private stopped='';private lastProgress=0;private readonly store:CatalogRestoreStore;
 constructor(private readonly ports:Ports){this.store=new CatalogRestoreStore(ports.dataDir);}
 private reviewCache:CatalogRestoreReview|null=null;
 private historyRead:Promise<CatalogRestoreHistory>|null=null;
 async review(value:unknown,authorize:()=>void):Promise<CatalogRestoreReview>{
  const operationId=backupUuid(value);this.check(authorize);if(this.busy||this.ports.busy()||this.state.phase!=='ready'||this.state.operationId!==operationId||!this.reviewCache)throw new Error('请先按当前版本重新核对并预览恢复资料');
  const expected=this.reviewCache,loaded=await this.store.load(operationId);this.check(authorize);if(this.busy||this.ports.busy()||this.reviewCache!==expected||this.state.phase!=='ready'||this.state.operationId!==operationId||loaded.preparedSha256!==expected.preparedSha256||loaded.prepared.stageIdentity!==expected.stageIdentity||loaded.checks.at(-1)?.sha256!==expected.checkSha256||JSON.stringify(loaded.preview)!==JSON.stringify(expected.preview))throw new Error('恢复审核资料已变化，请重新核对');
  return readCatalogRestoreReview(expected);
 }
 private async saveReview(operationId:string,proof:{prepared:CatalogRestorePrepared;review:RestoreReviewEvidence;compatibility:CatalogRestoreCompatibility},authorize:()=>void):Promise<void>{
  const loaded=await this.store.load(operationId);this.check(authorize);const latest=loaded.checks.at(-1);if(!latest?.compatibility||JSON.stringify(loaded.prepared)!==JSON.stringify(proof.prepared)||JSON.stringify(latest.compatibility)!==JSON.stringify(proof.compatibility))throw new Error('恢复审核缺少本次原内容及兼容性核对回执');
  this.reviewCache=readCatalogRestoreReview({version:1,preview:loaded.preview,preparedSha256:loaded.preparedSha256,stageIdentity:loaded.prepared.stageIdentity,checkSha256:latest.sha256,checkedAt:latest.checkedAt,compatibility:latest.compatibility,evidence:bindRestoreReviewEvidence(proof.review,loaded.prepared.manifest,loaded.preview.pendingValues),policy:'import-disabled-and-quarantined-v1'});
 }
 history():Promise<CatalogRestoreHistory>{if(this.historyRead)return this.historyRead;const pending=this.store.list();this.historyRead=pending;void pending.finally(()=>{if(this.historyRead===pending)this.historyRead=null;}).catch(()=>{});return pending;}
 get busy():boolean{return Boolean(this.work||this.owner);}
 snapshot():CatalogRestoreState{return readRestoreState(this.state);}
 private change(patch:Partial<CatalogRestoreState>):void{this.state={...this.state,...patch};if(Object.keys(patch).every(k=>k==='bytes'||k==='total')&&Date.now()-this.lastProgress<100)return;this.lastProgress=Date.now();try{this.ports.publish(this.snapshot());}catch{/* Main remains authoritative after document replacement. */}}
 private check(authorize:()=>void):void{if(this.closed||this.stopped||!this.ports.ready())throw new Error(this.stopped||'应用状态变化，恢复预览未完成');authorize();}
 interrupt(reason:string):void{this.reviewCache=null;if(!this.work)return;this.stopped||=reason;if(this.owner){try{this.owner.postMessage({kind:'cancel',operationId:this.state.operationId});}catch{}try{this.owner.kill();}catch{/* Actual exit still owns completion. */}}}
 cancel(value:unknown):boolean{if(backupUuid(value)!==this.state.operationId)throw new Error('恢复操作已变化');if(!this.work||this.state.phase==='choosing')return false;this.change({cancelRequested:true,message:'正在等待原校验进程结束。'});this.interrupt('恢复预览已取消，暂存资料保留。');return true;}
 close():Promise<unknown>{this.closed=true;this.interrupt('应用退出，恢复预览已中断。');return this.work?.catch(()=>{})??Promise.resolve();}
 start(value:unknown,authorize:()=>void):Promise<CatalogRestorePreview|null>{
  const operationId=backupUuid(value);authorize();if(operationId===this.state.operationId){if(this.work)return this.work;if(this.state.phase==='ready')return Promise.resolve(this.state.preview);if(this.state.phase==='cancelled')return Promise.resolve(null);throw new Error(this.state.message||'原恢复预览未完成');}
  if(this.busy||this.ports.busy())throw new Error('已有备份、恢复或维护操作尚未结束');if(this.closed||!this.ports.ready())throw new Error('应用尚未准备好恢复预览');
  this.reviewCache=null;this.stopped='';this.state={operationId,phase:'choosing',bytes:0,total:0,message:'请选择需要恢复的曲库备份。',preview:null,cancelRequested:false};this.change({});
  const work=Promise.resolve().then(()=>this.run(operationId,authorize));this.work=work;void work.finally(()=>{if(this.work===work)this.work=null;}).catch(()=>{});return work;
 }
 recheck(value:unknown,authorize:()=>void):Promise<CatalogRestorePreview|null>{
  const operationId=backupUuid(value);authorize();if(this.busy||this.ports.busy())throw new Error('已有备份、恢复或维护尚未结束');if(this.closed||!this.ports.ready())throw new Error('应用尚未准备好核对恢复资料');
  this.reviewCache=null;this.stopped='';this.state={operationId,phase:'inspecting',bytes:0,total:0,message:'正在重新读取原准备回执，并独立核对当前暂存内容。',preview:null,cancelRequested:false};this.change({});
  const work=Promise.resolve().then(()=>this.runRecheck(operationId,authorize));this.work=work;void work.finally(()=>{if(this.work===work)this.work=null;}).catch(()=>{});return work;
 }
 private async runRecheck(operationId:string,authorize:()=>void):Promise<CatalogRestorePreview|null>{
  const timer=setTimeout(()=>this.interrupt('恢复暂存核对超过45分钟，等待原进程结束。'),45*60*1000);
  try{const loaded=await this.store.load(operationId);if(loaded.checks.length>=16)throw new Error('恢复核对回执达到16条预算，原资料保留');this.check(authorize);
   const checked=await this.inspect(loaded.reservation,authorize,loaded);this.check(authorize);const preview=await this.store.checked(loaded,checked.prepared,checked.pendingValues,checked.compatibility);this.check(authorize);await this.saveReview(operationId,checked,authorize);this.check(authorize);
   this.change({phase:'ready',preview,bytes:preview.bytes,total:preview.bytes,message:'已重新核对暂存内容、数据库结构及部分设置；尚未替换当前曲库。'});return preview;
  }catch(e){const text=message(e);this.change({phase:this.state.cancelRequested?'cancelled':'failed',message:text,preview:null});if(this.state.cancelRequested)return null;throw new Error(text);}finally{clearTimeout(timer);}
 }
 private async inspect(reservation:RestoreReservation,authorize:()=>void,loaded?:LoadedRestorePrepared):Promise<{prepared:CatalogRestorePrepared;pendingValues:number;compatibility:CatalogRestoreCompatibility;review:RestoreReviewEvidence}>{
  this.check(authorize);const worker=utilityProcess.fork(this.ports.workerPath,[],{serviceName:'Aural Restore Preview',stdio:'pipe',execArgv:['--max-old-space-size=256']});this.owner=worker;
  let expected=0,failure='',done=false,result:{prepared:CatalogRestorePrepared;pendingValues:number;compatibility:CatalogRestoreCompatibility;review:RestoreReviewEvidence}|null=null,diagnostics=0;
  const exit=new Promise<number>(resolve=>worker.once('exit',code=>{if(this.owner===worker)this.owner=null;resolve(code);}));const stop=(e:unknown)=>{failure||=message(e);try{worker.kill();}catch{}};
  const retry=setInterval(()=>{if((failure||this.stopped||this.closed)&&this.owner===worker)try{worker.kill();}catch{}},1000);
  worker.stderr?.on('data',(v:Buffer)=>{diagnostics+=v.length;if(diagnostics>16384)stop(new Error('恢复诊断超过预算'));});
  worker.on('message',raw=>{if(this.owner!==worker)return;try{this.check(authorize);if(Buffer.byteLength(JSON.stringify(raw))>RESTORE_FRAME_BYTES)throw new Error('恢复消息超过预算');const frame=readRestoreFrame(raw);if(frame.operationId!==reservation.operationId||frame.sequence!==expected++||done)throw new Error('恢复进程身份或顺序不符');if(frame.kind==='error')throw new Error(frame.message);if(frame.kind==='progress'){this.change({phase:frame.phase,bytes:frame.bytes,total:frame.total});return;}done=true;result={prepared:frame.result,pendingValues:frame.pendingValues,compatibility:frame.compatibility,review:frame.review};worker.postMessage({kind:'ack',operationId:frame.operationId,sequence:frame.sequence});}catch(e){stop(e);}});
  try{try{worker.postMessage(loaded?{kind:'begin',mode:'check',operationId:reservation.operationId,parent:reservation.parent,parentIdentity:reservation.parentIdentity,prepared:loaded.prepared}:{kind:'begin',mode:'stage',operationId:reservation.operationId,filename:reservation.filename,parent:reservation.parent,parentIdentity:reservation.parentIdentity,source:reservation.source});}catch(e){stop(e);}const code=await exit;this.check(authorize);if(failure)throw new Error(failure);if(code!==0||!result)throw new Error('恢复校验进程未正常确认退出');return result;}finally{clearInterval(retry);}
 }
 private async run(operationId:string,authorize:()=>void):Promise<CatalogRestorePreview|null>{
  let deadline:NodeJS.Timeout|undefined;try{const filename=await this.ports.pick();if(!filename){this.change({phase:'cancelled',message:'已取消选择恢复文件。'});return null;}this.check(authorize);
   deadline=setTimeout(()=>this.interrupt('恢复预览超过45分钟，等待原进程结束。'),45*60*1000);this.change({phase:'verifying',message:'正在独立校验备份，并在私有目录建立恢复暂存。'});const reservation=await this.store.begin(operationId,filename);this.check(authorize);
   const inspected=await this.inspect(reservation,authorize);this.check(authorize);const preview=await this.store.complete(reservation,inspected.prepared,inspected.pendingValues,inspected.compatibility);this.check(authorize);await this.saveReview(operationId,inspected,authorize);this.check(authorize);
   this.change({phase:'ready',preview,bytes:preview.bytes,total:preview.bytes,message:'备份内容、数据库结构及部分设置已核对，当前曲库尚未替换。'});return preview;
  }catch(e){const text=message(e);this.change({phase:this.state.cancelRequested?'cancelled':'failed',message:text,preview:null});if(this.state.cancelRequested)return null;throw new Error(text);}finally{if(deadline)clearTimeout(deadline);}
 }
}
