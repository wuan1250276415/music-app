import {utilityProcess,type UtilityProcess} from 'electron';
import type {CatalogRestoreConsent} from '../shared/catalog-restore-consent.js';
import {backupUuid} from '../shared/catalog-backup.js';
import {readRestorePreparationFrame,RESTORE_TRANSACTION_FRAME_BYTES,type RestoreCandidateProof,type RestoreRollbackProof} from '../shared/catalog-restore-transaction.js';
import type {CatalogCapturedSnapshot} from '../shared/catalog-maintenance.js';
import {CatalogRestoreStore} from './catalog-restore-store.js';
import {CatalogRestoreTransactionStore,type LoadedRestoreTransaction} from './catalog-restore-transaction-store.js';
import type {CatalogRestoreMaintenance} from './catalog-restore-maintenance.js';
import {randomUUID} from 'node:crypto';
import {readCatalogServiceStopRequest} from '../platform/catalog-library-lifecycle.js';
import type {CatalogLibraryLifecycle} from './catalog-library-lifecycle.js';

type Ports={dataDir:string;workerPath:string;maintenance:CatalogRestoreMaintenance;libraryLifecycle:CatalogLibraryLifecycle;ready:()=>boolean;lifecycleAvailable:()=>boolean;busy:()=>boolean};
const message=(error:unknown)=>String(error instanceof Error?error.message:error).slice(0,1024)||'整库恢复准备失败';
// Trusted Main-only preparation. Public apply passes the original consent;
// no Renderer path or copied task grants access to a source file.
export class CatalogRestorePreparation{
 private transactionId:string|null=null;private work:Promise<LoadedRestoreTransaction>|null=null;private owner:UtilityProcess|null=null;private stopped='';private closed=false;private prepared:LoadedRestoreTransaction|null=null;
 private sourceId:string|null=null;private consentIdentity='';
 private closingWork:Promise<LoadedRestoreTransaction>|null=null;
 private readonly store:CatalogRestoreTransactionStore;
 constructor(private readonly ports:Ports){this.store=new CatalogRestoreTransactionStore(ports.dataDir);}
 get busy():boolean{return Boolean(this.work||this.closingWork||this.owner||this.prepared||this.ports.maintenance.busy);}
 assertCompletedHandoff(value:string):void{if(this.transactionId!==value||this.prepared?.intent.transactionId!==value||this.work||this.owner||this.closingWork||this.stopped||this.closed)throw new Error('恢复准备进程或原操作尚未完成交接');}
 forgetCompleted(value:string):void{this.assertCompletedHandoff(value);this.prepared=null;this.transactionId=null;this.sourceId=null;this.consentIdentity='';this.stopped='';}
 private check(authorize:()=>void):void{if(this.stopped||this.closed||!this.ports.ready())throw new Error(this.stopped||'应用状态变化，整库恢复准备中断');authorize();}
 interrupt(reason:string):void{if(!this.busy)return;this.stopped||=reason;this.ports.maintenance.interrupt(reason);if(this.closingWork&&this.transactionId)this.ports.libraryLifecycle.interruptFrozenStop(this.transactionId);if(this.owner){try{this.owner.postMessage({kind:'cancel',transactionId:this.transactionId});}catch{}try{this.owner.kill();}catch{/* Actual exit still owns settlement. */}}}
 close():Promise<unknown>{this.closed=true;this.interrupt('应用退出，整库恢复准备中断');return Promise.allSettled([...(this.work?[this.work]:[]),...(this.closingWork?[this.closingWork]:[])]);}
 async cancel(value:unknown):Promise<boolean>{const transactionId=backupUuid(value);if(transactionId!==this.transactionId)throw new Error('整库恢复准备操作已变化');if(this.work||this.owner||this.closingWork){this.interrupt('已取消整库恢复准备，等待原操作结束并保留资料。');return true;}if(this.prepared){await this.abortPrepared(transactionId);return true;}if(this.ports.maintenance.busy)throw new Error('恢复维护未确认释放，请退出后重新启动并核对原资料');return false;}
 prepare(value:unknown,sourceValue:unknown,authorize:()=>void,consent?:CatalogRestoreConsent):Promise<LoadedRestoreTransaction>{
  const transactionId=backupUuid(value),sourceId=backupUuid(sourceValue);authorize();if(transactionId===this.transactionId){if(this.consentIdentity!==(consent?JSON.stringify(consent):''))throw new Error('原恢复准备不能改变用户确认');if(this.work){if(this.sourceId!==sourceId)throw new Error('同一恢复事务不能改用其他来源');return this.work;}if(this.prepared?.intent.source.operationId===sourceId){this.check(authorize);this.ports.maintenance.assertFrozen(transactionId);return Promise.resolve(this.prepared);}throw new Error('原恢复事务尚未完成或来源不同');}
  if(this.busy||this.ports.busy()||this.closed||!this.ports.ready())throw new Error('已有备份恢复或应用尚未准备好');this.transactionId=transactionId;this.sourceId=sourceId;this.consentIdentity=consent?JSON.stringify(consent):'';this.stopped='';
  const work=Promise.resolve().then(()=>this.run(transactionId,sourceId,authorize,consent));this.work=work;void work.finally(()=>{if(this.work===work)this.work=null;}).catch(()=>{});return work;
 }
 private worker(loaded:LoadedRestoreTransaction,authorize:()=>void,mode:'candidate'|'rollback',snapshot?:CatalogCapturedSnapshot):Promise<RestoreCandidateProof|RestoreRollbackProof>{return this.inspectWorker(loaded,authorize,mode,snapshot);}
 private async inspectWorker(loaded:LoadedRestoreTransaction,authorize:()=>void,mode:'candidate'|'rollback',snapshot?:CatalogCapturedSnapshot):Promise<RestoreCandidateProof|RestoreRollbackProof>{
  this.check(authorize);const transactionId=loaded.intent.transactionId,worker=utilityProcess.fork(this.ports.workerPath,[],{serviceName:'Aural Restore Preparation',stdio:'pipe',execArgv:['--max-old-space-size=256']});this.owner=worker;
  let sequence=0,diagnostics=0,failure='',done=false,result:RestoreCandidateProof|RestoreRollbackProof|null=null;
  const exit=new Promise<number>(resolve=>worker.once('exit',code=>{if(this.owner===worker)this.owner=null;resolve(code);})),stop=(error:unknown)=>{failure||=message(error);try{worker.kill();}catch{}};
  const retry=setInterval(()=>{if((failure||this.stopped||this.closed)&&this.owner===worker)try{worker.kill();}catch{}},1000);
  worker.stderr?.on('data',(bytes:Buffer)=>{diagnostics+=bytes.length;if(diagnostics>16384)stop(new Error('整库恢复准备诊断超过预算'));});
  worker.on('message',value=>{if(this.owner!==worker)return;try{
   this.check(authorize);if(Buffer.byteLength(JSON.stringify(value))>RESTORE_TRANSACTION_FRAME_BYTES)throw new Error('整库恢复准备消息超过预算');const frame=readRestorePreparationFrame(value,transactionId,sequence++,mode,loaded.source.prepared.manifest);if(done)throw new Error('整库恢复准备完成后仍有消息');if(frame.kind==='error')throw new Error(frame.message);if(frame.kind==='progress')return;
   if(frame.kind==='rollback'){this.ports.maintenance.assertFrozen(transactionId);if(!snapshot||JSON.stringify(frame.result.manifest)!==JSON.stringify(snapshot.manifest)||frame.result.stagePath!==snapshot.stagePath||frame.result.liveIdentity!==loaded.intent.liveIdentity)throw new Error('原曲库一致快照进程报告与已捕获证明不同');}
   done=true;result=frame.result;worker.postMessage({kind:'ack',transactionId,sequence:frame.sequence});
  }catch(error){stop(error);}});
  try{try{worker.postMessage({kind:'begin',mode,transactionId,userData:this.ports.dataDir,...(mode==='rollback'?{snapshot}:{})});}catch(error){stop(error);}const code=await exit;this.check(authorize);if(failure)throw new Error(failure);if(code!==0||!result)throw new Error('整库恢复准备进程没有正常确认退出');if(mode==='rollback')this.ports.maintenance.assertFrozen(transactionId);return result;}finally{clearInterval(retry);}
 }
 private async run(transactionId:string,sourceId:string,authorize:()=>void,consent?:CatalogRestoreConsent):Promise<LoadedRestoreTransaction>{
  let loaded:LoadedRestoreTransaction|null=null;const timer=setTimeout(()=>this.interrupt('整库恢复准备超过45分钟，等待原操作结束'),45*60*1000);
  try{
   this.check(authorize);const source=await new CatalogRestoreStore(this.ports.dataDir).load(sourceId);this.check(authorize);loaded=await this.store.create(transactionId,source,consent);this.check(authorize);
   const candidate=await this.worker(loaded,authorize,'candidate');this.check(authorize);loaded=await this.store.candidatePrepared(loaded,candidate);this.check(authorize);
   const snapshot=await this.ports.maintenance.capture(transactionId,authorize);this.check(authorize);this.ports.maintenance.assertFrozen(transactionId);
   const rollback=await this.worker(loaded,authorize,'rollback',snapshot);this.check(authorize);loaded=await this.store.rollbackCaptured(loaded,rollback);this.ports.maintenance.assertFrozen(transactionId);this.check(authorize);this.ports.maintenance.ready(transactionId);this.prepared=loaded;return loaded;
  }catch(error){let text=message(error);this.ports.maintenance.interrupt(text);if(loaded){try{await this.store.abortBeforeCutover(await this.store.load(transactionId),text);}catch(recordError){text=(text+'；原事务未确认终止：'+message(recordError)).slice(0,1024);throw new Error(text);}}
   try{await this.ports.maintenance.releaseBeforeCutover(transactionId);}catch(releaseError){text=(text+'；'+message(releaseError)).slice(0,1024);}throw new Error(text);
  }finally{clearTimeout(timer);}
 }
 retireLibrary(value:unknown,authorize:()=>void):Promise<LoadedRestoreTransaction>{
  const transactionId=backupUuid(value);this.check(authorize);if(this.work||this.owner||this.closingWork||!this.prepared||this.prepared.intent.transactionId!==transactionId)throw new Error('原恢复准备尚未结束或不存在');
  const lease=this.ports.maintenance.lease(transactionId),instance=this.ports.libraryLifecycle.instance();if(instance.mode!=='original')throw new Error('原曲库实例并非普通服务');
  const check=()=>{if(this.stopped||this.closed||!this.ports.lifecycleAvailable())throw new Error(this.stopped||'应用状态变化，原曲库关闭证明未完成');authorize();};
  const work=Promise.resolve().then(async()=>{
   check();let loaded=await this.store.load(transactionId);check();if(!loaded.rollback||loaded.records.length!==2)throw new Error('恢复准备没有完整候选及当前快照证明');
   const request=readCatalogServiceStopRequest({version:1,...lease,challenge:randomUUID(),instanceId:instance.instanceId,mode:'original',libraryIdentity:loaded.intent.liveIdentity,manifest:loaded.rollback.manifest});
   this.ports.maintenance.beginLibraryClose(transactionId);loaded=await this.store.beginServiceClose(loaded,request);check();this.prepared=loaded;
   const proof=await this.ports.libraryLifecycle.stopFrozen(request,async receipt=>{check();loaded=await this.store.serviceClosed(loaded,receipt);this.prepared=loaded;check();return loaded.lastSha256;},check);
   check();loaded=await this.store.serviceExited(loaded,proof);this.prepared=loaded;check();this.ports.maintenance.markLibraryClosed(proof);this.ports.maintenance.assertCutoverReady(transactionId);return loaded;
  }).catch(error=>{this.ports.maintenance.interrupt(message(error));throw error;});this.closingWork=work;void work.finally(()=>{if(this.closingWork===work)this.closingWork=null;}).catch(()=>{});return work;
 }
 async abortPrepared(value:unknown):Promise<void>{const transactionId=backupUuid(value);if(this.work||this.owner||this.closingWork||!this.prepared||this.prepared.intent.transactionId!==transactionId)throw new Error('原恢复准备尚未结束或不存在');const current=await this.store.load(transactionId);if(!current.aborted)await this.store.abortBeforeCutover(current,'已明确取消尚未切换的恢复准备，原曲库保持。');await this.ports.maintenance.releaseBeforeCutover(transactionId);this.prepared=null;}
}
