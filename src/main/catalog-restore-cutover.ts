import type {CatalogRestoreConsent} from '../shared/catalog-restore-consent.js';
import type {CatalogRestoreCompletion} from './catalog-restore-completion.js';
import type {CatalogRestoreFinalization} from './catalog-restore-finalization.js';
import type {CatalogRestoreApplication} from './catalog-restore-application.js';
import type {CatalogRestoreRelease} from './catalog-restore-release.js';
import type {CatalogRestoreCommit} from './catalog-restore-commit.js';
import type {CatalogRestoreNormalPreparation} from './catalog-restore-normal.js';
import type {CatalogRestoreRenderer} from './catalog-restore-renderer.js';
import type {CatalogRestoreHydration} from './catalog-restore-hydration.js';
import type {CatalogRestorePendingCoordinator} from './catalog-restore-pending.js';
import {readCatalogRestoreActivationRequest,type CatalogRestoreActivationProof} from '../platform/catalog-restore-activation.js';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import {randomUUID} from 'node:crypto';
import {backupUuid} from '../shared/catalog-backup.js';
import type {DirectoryMoveAction} from '../shared/catalog-directory-move.js';
import {completedCutoverMove,type RestoreBootRole} from '../platform/catalog-restore-cutover.js';
import {readCatalogServiceStopRequest} from '../platform/catalog-library-lifecycle.js';
import {CatalogRestoreTransactionStore,type LoadedRestoreTransaction} from './catalog-restore-transaction-store.js';
import type {CatalogRestorePreparation} from './catalog-restore-preparation.js';
import type {CatalogRestoreMaintenance} from './catalog-restore-maintenance.js';
import type {CatalogLibraryLifecycle} from './catalog-library-lifecycle.js';
import type {CatalogDirectoryMover} from './catalog-directory-mover.js';

type Ports={dataDir:string;preparation:CatalogRestorePreparation;maintenance:CatalogRestoreMaintenance;libraryLifecycle:CatalogLibraryLifecycle;mover:CatalogDirectoryMover;pending:CatalogRestorePendingCoordinator;hydration:CatalogRestoreHydration;renderer:CatalogRestoreRenderer;normal:CatalogRestoreNormalPreparation;commit:CatalogRestoreCommit;release:CatalogRestoreRelease;application:CatalogRestoreApplication;finalization:CatalogRestoreFinalization;completion:CatalogRestoreCompletion;available:()=>boolean;serviceAbsent:()=>boolean};
export type RestoreCutoverResult={phase:'candidate-readonly'|'original-readonly'|'candidate-writable-paused'|'original-writable-paused'|'candidate-ready-held'|'original-ready-held'|'candidate-resources-released-held'|'original-resources-released-held'|'candidate-app-mounted-held'|'original-app-mounted-held'|'candidate-final-resources-held'|'original-final-resources-held'|'candidate-completed'|'original-completed';transaction:LoadedRestoreTransaction;reason:string|null};
const message=(error:unknown)=>String(error instanceof Error?error.message:error).slice(0,1024)||'整库切换未完成';

// Trusted Main coordinator. Public admission supplies the original reviewed
// consent; full completion retains all owners until durable normal-start admission.
export class CatalogRestoreCutover{
 private transactionId:string|null=null;private sourceId:string|null=null;private consentIdentity='';private work:Promise<RestoreCutoverResult>|null=null;private result:RestoreCutoverResult|null=null;private closed=false;private stopped='';private control:AbortController|null=null;
 private readonly store:CatalogRestoreTransactionStore;private activationWork:Promise<CatalogRestoreActivationProof>|null=null;private pendingWork:Promise<LoadedRestoreTransaction>|null=null;private hydrationWork:Promise<LoadedRestoreTransaction>|null=null;private rendererWork:Promise<LoadedRestoreTransaction>|null=null;private normalWork:Promise<LoadedRestoreTransaction>|null=null;private commitWork:Promise<LoadedRestoreTransaction>|null=null;private completionPreparation:Promise<LoadedRestoreTransaction>|null=null;private resourceReleaseWork:Promise<LoadedRestoreTransaction>|null=null;private applicationWork:Promise<LoadedRestoreTransaction>|null=null;private finalizationWork:Promise<LoadedRestoreTransaction>|null=null;private completeWork:Promise<LoadedRestoreTransaction>|null=null;private lastCompleted:LoadedRestoreTransaction|null=null;
 constructor(private readonly ports:Ports){this.store=new CatalogRestoreTransactionStore(ports.dataDir);}
 get busy():boolean{return this.transactionId!==null;}
 owns(value:string):boolean{return this.transactionId===value;}
 private check(authorize:()=>void):void{if(this.stopped||this.closed||!this.ports.available())throw new Error(this.stopped||'应用状态变化，整库切换需要恢复核对');this.control?.signal.throwIfAborted();authorize();}
 interrupt(reason:string):void{if(!this.busy)return;this.stopped||=reason;this.control?.abort(new Error(reason));this.ports.maintenance.interrupt(reason);this.ports.preparation.interrupt(reason);this.ports.mover.interrupt(reason);if(this.transactionId){this.ports.libraryLifecycle.interruptFrozenStop(this.transactionId);this.ports.libraryLifecycle.interruptDormant(this.transactionId);}}
 close():Promise<unknown>{this.closed=true;this.interrupt('应用退出，整库恢复须重新核对');return Promise.allSettled([this.work,this.activationWork,this.pendingWork,this.hydrationWork,this.rendererWork,this.normalWork,this.commitWork,this.completionPreparation,this.resourceReleaseWork,this.applicationWork,this.finalizationWork,this.completeWork]);}
 cancel(value:unknown):boolean{if(backupUuid(value)!==this.transactionId)throw new Error('整库切换操作已变化');this.interrupt('已请求中断整库恢复，资料和维护占用保留，等待恢复核对。');return true;}
 apply(value:unknown,sourceValue:unknown,authorize:()=>void,consent?:CatalogRestoreConsent):Promise<RestoreCutoverResult>{
  const transactionId=backupUuid(value),sourceId=backupUuid(sourceValue);authorize();
  if(this.transactionId===transactionId){if(this.sourceId!==sourceId||this.consentIdentity!==(consent?JSON.stringify(consent):''))throw new Error('原整库切换不能改变恢复来源或确认');if(this.work)return this.work;if(this.result){this.check(authorize);return Promise.resolve(this.result);}throw new Error('原整库切换未完成，须按持久记录恢复核对');}
  if(this.busy||this.closed||!this.ports.available())throw new Error('已有整库切换或应用不可用');this.transactionId=transactionId;this.sourceId=sourceId;this.consentIdentity=consent?JSON.stringify(consent):'';this.result=null;this.stopped='';this.control=new AbortController();
  const work=this.run(transactionId,sourceId,authorize,consent).then(result=>{this.result=result;return result;}).finally(()=>{if(this.work===work)this.work=null;});this.work=work;void work.catch(()=>{});return work;
 }
 private async move(loaded:LoadedRestoreTransaction,action:DirectoryMoveAction,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  this.check(authorize);this.ports.maintenance.assertCutoverReady(loaded.intent.transactionId);const request=this.store.moveRequest(loaded,randomUUID(),action),signal=this.control!.signal;
  loaded=await this.store.beginMove(loaded,request,signal);this.check(authorize);this.ports.maintenance.assertCutoverReady(loaded.intent.transactionId);
  const proof=await this.ports.mover.run(request,signal);this.check(authorize);this.ports.maintenance.assertCutoverReady(loaded.intent.transactionId);loaded=await this.store.completeMove(loaded,proof,signal);this.check(authorize);return loaded;
 }
 private async boot(loaded:LoadedRestoreTransaction,role:RestoreBootRole,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  this.check(authorize);this.ports.maintenance.assertCutoverReady(loaded.intent.transactionId);loaded=await this.store.beginBoot(loaded,role,randomUUID(),this.control!.signal);this.check(authorize);
  const request=(role==='candidate'?loaded.cutover.candidateBoot:loaded.cutover.originalBoot)!.request;let proof;
  try{proof=await this.ports.libraryLifecycle.startDormant(request,()=>this.check(authorize));}
  catch(error){this.check(authorize);if(!this.ports.serviceAbsent())throw new Error('恢复启动失败但原进程尚未实际退出，资料及占用保留',{cause:error});loaded=await this.store.bootFailed(loaded,role,message(error));throw error;}
  this.check(authorize);this.ports.maintenance.markDormant(proof,request);loaded=await this.store.bootReady(loaded,role,proof);this.check(authorize);return loaded;
 }
 private async stopCandidate(loaded:LoadedRestoreTransaction,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  const boot=loaded.cutover.candidateBoot?.proof;if(!boot)throw new Error('候选只读曲库没有已持久启动证明');this.check(authorize);const lease=this.ports.maintenance.lease(loaded.intent.transactionId);
  if(lease.token!==boot.token||!this.ports.libraryLifecycle.matchesDormant(boot))throw new Error('候选只读实例已变化');const request=readCatalogServiceStopRequest({version:1,...lease,challenge:randomUUID(),instanceId:boot.instanceId,mode:'dormant',libraryIdentity:boot.libraryIdentity,manifest:loaded.source.prepared.manifest});
  this.ports.maintenance.beginLibraryClose(loaded.intent.transactionId);loaded=await this.store.dormantClosing(loaded,request);this.check(authorize);
  const proof=await this.ports.libraryLifecycle.stopFrozen(request,async receipt=>{this.check(authorize);loaded=await this.store.dormantClosed(loaded,receipt);this.check(authorize);return loaded.lastSha256;},()=>this.check(authorize));
  this.check(authorize);loaded=await this.store.dormantExited(loaded,proof);this.check(authorize);this.ports.maintenance.markLibraryClosed(proof);this.ports.maintenance.assertCutoverReady(loaded.intent.transactionId);return loaded;
 }
 private async rollbackCore(loaded:LoadedRestoreTransaction,reason:string,authorize:()=>void):Promise<RestoreCutoverResult>{
  this.check(authorize);if(loaded.cutover.activation)throw new Error('可写准备已经登记，须按新清单恢复核对，不能移动旧只读目录');if(!this.ports.mover.quiescent||loaded.cutover.moves.some(move=>!move.completion))throw new Error('存在未确认目录移动，不能猜测回滚方向，原资料和占用保留');
  if(!loaded.cutover.rollbackReason)loaded=await this.store.beginRollback(loaded,reason);this.check(authorize);
  if(loaded.cutover.candidateBoot?.proof&&!loaded.cutover.dormantExited)loaded=await this.stopCandidate(loaded,authorize);
  if(!this.ports.serviceAbsent())throw new Error('曲库服务未实际退出，不能回滚目录');this.ports.maintenance.assertCutoverReady(loaded.intent.transactionId);
  if(completedCutoverMove(loaded.cutover,'install-candidate')&&!completedCutoverMove(loaded.cutover,'retire-candidate'))loaded=await this.move(loaded,'retire-candidate',authorize);
  if(completedCutoverMove(loaded.cutover,'retire-original')&&!completedCutoverMove(loaded.cutover,'restore-original'))loaded=await this.move(loaded,'restore-original',authorize);
  loaded=await this.boot(loaded,'original',authorize);return {phase:'original-readonly',transaction:loaded,reason};
 }
 rollback(value:unknown,authorize:()=>void):Promise<RestoreCutoverResult>{
  const transactionId=backupUuid(value);this.check(authorize);if(transactionId!==this.transactionId||this.work||this.activationWork||this.result?.phase!=='candidate-readonly')throw new Error('没有可回滚的当前候选只读曲库');
  this.result=null;const work=Promise.resolve().then(async()=>this.rollbackCore(await this.store.load(transactionId),'已明确请求结束候选恢复并放回原曲库。',authorize)).catch(error=>{this.ports.maintenance.interrupt(message(error));throw error;});this.work=work;
  void work.then(result=>{this.result=result;}).finally(()=>{if(this.work===work)this.work=null;}).catch(()=>{});return work;
 }
 prepareWritable(value:unknown,authorize:()=>void):Promise<CatalogRestoreActivationProof>{
  const transactionId=backupUuid(value);this.check(authorize);if(transactionId!==this.transactionId||this.work||!this.result)throw new Error('没有已确认的当前恢复只读曲库');if(this.activationWork)return this.activationWork;
  const expectedRole=this.result.phase.startsWith('candidate')?'candidate':'original';
  const work=Promise.resolve().then(async()=>{
   let loaded=await this.store.load(transactionId);this.check(authorize);this.ports.maintenance.assertFrozen(transactionId);
   const boot=expectedRole==='candidate'?loaded.cutover.candidateBoot:loaded.cutover.originalBoot;if(!boot?.proof||!this.ports.libraryLifecycle.matchesDormant(boot.proof))throw new Error('恢复只读启动证明与当前进程不同');
   const request=readCatalogRestoreActivationRequest({version:1,operationId:transactionId,activationId:randomUUID(),challenge:randomUUID(),instanceId:boot.proof.instanceId,token:boot.proof.token,role:expectedRole,libraryIdentity:boot.proof.libraryIdentity,bootSha256:lifecycleDigest(boot.proof),credentialScope:expectedRole==='candidate'?randomUUID():null},boot.proof);
   loaded=await this.store.beginActivation(loaded,request,this.control!.signal);this.check(authorize);this.ports.maintenance.assertFrozen(transactionId);
   const proof=await this.ports.libraryLifecycle.activateFrozen(request,boot.request,boot.proof,()=>this.check(authorize));this.check(authorize);this.ports.maintenance.assertFrozen(transactionId);
   loaded=await this.store.activationReady(loaded,proof,this.control!.signal);this.check(authorize);this.result={...this.result!,phase:expectedRole==='candidate'?'candidate-writable-paused':'original-writable-paused',transaction:loaded};return proof;
  }).catch(error=>{this.ports.maintenance.interrupt(message(error));throw error;});this.activationWork=work;void work.catch(()=>{});return work;
 }
 preparePending(value:unknown,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  const transactionId=backupUuid(value);this.check(authorize);if(transactionId!==this.transactionId||this.work||!this.result?.transaction.cutover.activation?.proof)throw new Error('当前恢复可写准备尚未持久确认');if(this.pendingWork)return this.pendingWork;
  const check=()=>{this.check(authorize);this.ports.maintenance.assertFrozen(transactionId);const boot=this.result?.transaction.cutover.activation?.request.role==='candidate'?this.result?.transaction.cutover.candidateBoot:this.result?.transaction.cutover.originalBoot;if(!boot?.proof||!this.ports.libraryLifecycle.matchesDormant(boot.proof))throw new Error('恢复待保存资料所属曲库实例已变化');};
  check();const work=this.ports.pending.prepare(this.result.transaction,check,this.control!.signal).then(transaction=>{check();this.result={...this.result!,transaction};return transaction;}).catch(error=>{this.ports.maintenance.interrupt(message(error));throw error;});this.pendingWork=work;void work.catch(()=>{});return work;
 }
 prepareHydration(value:unknown,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  const transactionId=backupUuid(value);this.check(authorize);if(transactionId!==this.transactionId||this.work||!this.result?.transaction.cutover.pending?.settled)throw new Error('当前恢复待保存处理尚未持久确认');if(this.hydrationWork)return this.hydrationWork;
  const check=()=>{this.check(authorize);this.ports.maintenance.assertFrozen(transactionId);};check();const work=this.ports.hydration.prepare(this.result.transaction,check,this.control!.signal).then(transaction=>{check();this.result={...this.result!,transaction};return transaction;}).catch(error=>{this.ports.maintenance.interrupt(message(error));throw error;});this.hydrationWork=work;void work.catch(()=>{});return work;
 }
 prepareRenderer(value:unknown,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  const transactionId=backupUuid(value);this.check(authorize);if(transactionId!==this.transactionId||this.work||!this.result?.transaction.cutover.hydration?.ready)throw new Error('当前 Main 恢复状态尚未持久确认');if(this.rendererWork)return this.rendererWork;
  const before=()=>{this.check(authorize);this.ports.maintenance.assertFrozen(transactionId);};
  // Authorization to replace this owned document is granted before the persisted
  // reload. Afterward the Renderer coordinator validates the fresh document;
  // retaining the old frame's authorization would reject every controlled reload.
  const after=()=>{this.check(()=>{});this.ports.maintenance.assertFrozen(transactionId);};before();const work=this.ports.renderer.prepare(this.result.transaction,before,after,this.control!.signal).then(transaction=>{after();this.result={...this.result!,transaction};return transaction;}).catch(error=>{this.ports.maintenance.interrupt(message(error));throw error;});this.rendererWork=work;void work.catch(()=>{});return work;
 }
 prepareNormal(value:unknown,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  const transactionId=backupUuid(value);this.check(authorize);if(transactionId!==this.transactionId||this.work||!this.result?.transaction.cutover.renderer?.ready)throw new Error('当前恢复界面尚未持久确认');if(this.normalWork)return this.normalWork;
  const check=()=>{this.check(authorize);this.ports.maintenance.assertFrozen(transactionId);};check();const work=this.ports.normal.prepare(this.result.transaction,check,this.control!.signal).then(transaction=>{check();this.result={...this.result!,transaction};return transaction;}).catch(error=>{this.ports.maintenance.interrupt(message(error));throw error;});this.normalWork=work;void work.catch(()=>{});return work;
 }
 prepareCommittedService(value:unknown,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  const transactionId=backupUuid(value);this.check(authorize);if(transactionId!==this.transactionId||this.work||!this.result?.transaction.cutover.normal?.proof)throw new Error('当前恢复普通服务准备尚未持久确认');if(this.commitWork)return this.commitWork;
  const check=()=>{this.check(authorize);this.ports.maintenance.assertFrozen(transactionId);};check();const work=this.ports.commit.prepare(this.result.transaction,check,this.control!.signal).then(transaction=>{check();this.result={...this.result!,phase:transaction.cutover.commit!.seal.role==='candidate'?'candidate-ready-held':'original-ready-held',transaction};return transaction;}).catch(error=>{this.ports.maintenance.interrupt(message(error));throw error;});this.commitWork=work;void work.catch(()=>{});return work;
 }
 releasePrepared(value:unknown,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  const transactionId=backupUuid(value);this.check(authorize);if(transactionId!==this.transactionId||this.work||!this.result?.transaction.cutover.commit?.proof)throw new Error('恢复释放缺少当前服务就绪证明');if(this.resourceReleaseWork)return this.resourceReleaseWork;
  const check=()=>this.check(authorize);const work=this.ports.release.release(this.result.transaction,check,this.control!.signal).then(transaction=>{check();this.result={...this.result!,phase:transaction.cutover.commit!.seal.role==='candidate'?'candidate-resources-released-held':'original-resources-released-held',transaction};return transaction;}).catch(error=>{this.interrupt(message(error));throw error;});this.resourceReleaseWork=work;void work.catch(()=>{});return work;
 }
 prepareApplication(value:unknown,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  const transactionId=backupUuid(value);this.check(authorize);if(transactionId!==this.transactionId||this.work||!this.result?.transaction.cutover.mainRelease?.proof)throw new Error('恢复应用加载缺少当前资源释放证明');if(this.applicationWork)return this.applicationWork;
  const check=()=>this.check(authorize);const work=this.ports.application.prepare(this.result.transaction,check,this.control!.signal).then(transaction=>{check();this.result={...this.result!,phase:transaction.cutover.commit!.seal.role==='candidate'?'candidate-app-mounted-held':'original-app-mounted-held',transaction};return transaction;}).catch(error=>{this.interrupt(message(error));throw error;});this.applicationWork=work;void work.catch(()=>{});return work;
 }
 prepareFinalResources(value:unknown,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  const transactionId=backupUuid(value);this.check(authorize);if(transactionId!==this.transactionId||this.work||!this.result?.transaction.cutover.application?.ready)throw new Error('恢复最终准备缺少当前正常应用证明');if(this.finalizationWork)return this.finalizationWork;
  const check=()=>this.check(authorize);const work=this.ports.finalization.prepare(this.result.transaction,check,this.control!.signal).then(transaction=>{check();this.result={...this.result!,phase:transaction.cutover.commit!.seal.role==='candidate'?'candidate-final-resources-held':'original-final-resources-held',transaction};return transaction;}).catch(error=>{this.interrupt(message(error));throw error;});this.finalizationWork=work;void work.catch(()=>{});return work;
 }
 completeRestore(value:unknown,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  const transactionId=backupUuid(value);authorize();if(!this.busy&&this.lastCompleted?.intent.transactionId===transactionId)return Promise.resolve(this.lastCompleted);
  this.check(authorize);if(transactionId!==this.transactionId||this.work||!this.result?.transaction.cutover.finalization?.proof)throw new Error('恢复完成缺少当前最终资源证明');if(this.completeWork)return this.completeWork;
  const check=()=>this.check(authorize);const work=this.ports.completion.complete(this.result.transaction,check,this.control!.signal).then(transaction=>{
   if(!transaction.cutover.completed||this.transactionId!==transactionId)throw new Error('恢复完成交接不属于原操作');this.lastCompleted=transaction;this.transactionId=null;this.sourceId=null;this.consentIdentity='';this.result=null;this.control=null;this.stopped='';this.activationWork=null;this.pendingWork=null;this.hydrationWork=null;this.rendererWork=null;this.normalWork=null;this.commitWork=null;this.resourceReleaseWork=null;this.applicationWork=null;this.finalizationWork=null;this.completeWork=null;this.completionPreparation=null;return transaction;
  }).catch(error=>{this.interrupt(message(error));throw error;});this.completeWork=work;void work.catch(()=>{});return work;
 }
 prepareCompletion(value:unknown,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  const transactionId=backupUuid(value);this.check(authorize);if(transactionId!==this.transactionId)throw new Error('恢复完成准备不属于当前操作');if(this.completionPreparation)return this.completionPreparation;
  if(this.work||!this.result||!['candidate-readonly','original-readonly'].includes(this.result.phase))throw new Error('恢复完成准备缺少已核对的只读曲库');
  const work=Promise.resolve().then(async()=>{
   await this.prepareWritable(transactionId,authorize);await this.preparePending(transactionId,authorize);await this.prepareHydration(transactionId,authorize);await this.prepareRenderer(transactionId,authorize);
   // The old frame granted its one replacement. Continue under the same Main
   // operation and independently verified fresh document, rather than its dead IPC.
   const after=()=>{this.check(()=>{});if(!this.result)throw new Error('恢复完成准备的当前事务丢失');this.ports.renderer.assertPrepared(this.result.transaction);};
   after();await this.prepareNormal(transactionId,after);after();await this.prepareCommittedService(transactionId,after);await this.releasePrepared(transactionId,()=>this.check(()=>{}));await this.prepareApplication(transactionId,()=>this.check(()=>{}));await this.prepareFinalResources(transactionId,()=>this.check(()=>{}));return this.completeRestore(transactionId,()=>this.check(()=>{}));
  }).catch(error=>{this.ports.maintenance.interrupt(message(error));throw error;});this.completionPreparation=work;void work.catch(()=>{});return work;
 }
 private async run(transactionId:string,sourceId:string,authorize:()=>void,consent?:CatalogRestoreConsent):Promise<RestoreCutoverResult>{
  const timer=setTimeout(()=>this.interrupt('整库恢复超过3小时，资料和占用保留，等待核对'),3*60*60*1000);
  try{
   this.check(authorize);await this.ports.preparation.prepare(transactionId,sourceId,authorize,consent);this.check(authorize);let loaded=await this.ports.preparation.retireLibrary(transactionId,authorize);this.check(authorize);
   try{loaded=await this.move(loaded,'retire-original',authorize);loaded=await this.move(loaded,'install-candidate',authorize);loaded=await this.boot(loaded,'candidate',authorize);return {phase:'candidate-readonly',transaction:loaded,reason:null};}
   catch(error){this.check(authorize);loaded=await this.store.load(transactionId);this.check(authorize);if(!this.ports.serviceAbsent()&&!loaded.cutover.candidateBoot?.proof)throw new Error('恢复启动或记录未确认，保留资料及占用等待核对',{cause:error});return await this.rollbackCore(loaded,message(error),authorize);}
  }catch(error){this.ports.maintenance.interrupt(message(error));throw error;}finally{clearTimeout(timer);}
 }
}
