import {randomUUID} from 'node:crypto';
import {readRestoreFinalRequest,readRestoreFinalReply,readRestoreFinalProof,bindRestoreFinalReply,RESTORE_FINAL_MAIN_KEYS,type RestoreFinalRequest,type RestoreFinalReply,type RestoreFinalProof} from '../shared/catalog-restore-finalization.js';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import {CatalogRestoreTransactionStore,type LoadedRestoreTransaction} from './catalog-restore-transaction-store.js';
import type {MainCatalogResources} from './catalog-main-resources.js';
import type {CatalogRestoreApplication} from './catalog-restore-application.js';
import type {CatalogRestoreMaintenance} from './catalog-restore-maintenance.js';

type Ports={dataDir:string;resources:MainCatalogResources;application:CatalogRestoreApplication;maintenance:CatalogRestoreMaintenance;send:(request:RestoreFinalRequest)=>void};
type Active={loaded:LoadedRestoreTransaction;request:RestoreFinalRequest;signal:AbortSignal;authorize:()=>void;reply:RestoreFinalReply|null;failed:string;result:Promise<RestoreFinalReply>;resolve:(value:RestoreFinalReply)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout;abort:()=>void};
// Releases ordinary maintenance owners, retaining an independent input barrier.
// This is not a completed certificate, startup permission or a public apply API.
export class CatalogRestoreFinalization{
 private active:Active|null=null;
 constructor(private readonly ports:Ports){}
 private check(active:Active):void{
  if(this.active!==active||active.failed)throw new Error(active.failed||'恢复最终准备不属于当前操作');active.signal.throwIfAborted();active.authorize();this.ports.maintenance.assertReleaseHeld(active.request.operationId);this.ports.resources.assertFinalBarrier(active.request.operationId);this.ports.application.assertMounted(active.loaded);
 }
 private fail(active:Active,error:Error):void{if(active.failed)return;active.failed=error.message;clearTimeout(active.timer);active.signal.removeEventListener('abort',active.abort);active.reject(error);}
 reply(value:unknown,authorizeSender:()=>void):void{
  authorizeSender();const active=this.active;if(!active)throw new Error('没有当前恢复最终文档挑战');this.check(active);const reply=readRestoreFinalReply(value);bindRestoreFinalReply(reply,active.request,lifecycleDigest(active.request));
  if(active.reply){if(lifecycleDigest(active.reply)!==lifecycleDigest(reply))throw new Error('恢复最终文档原回执不能改变');return;}
  active.reply=reply;clearTimeout(active.timer);if(reply.error)this.fail(active,new Error(reply.error));else active.resolve(reply);
 }
 async prepare(input:LoadedRestoreTransaction,authorize:()=>void,signal:AbortSignal):Promise<LoadedRestoreTransaction>{
  if(this.active)throw new Error('已有恢复最终准备，不能猜测重试');const owner=input.intent.transactionId;signal.throwIfAborted();authorize();this.ports.application.assertMounted(input);this.ports.resources.assertRestoreResourcesReleased(owner);this.ports.maintenance.finalizing(owner);
  const store=new CatalogRestoreTransactionStore(this.ports.dataDir);let loaded=await store.load(owner);signal.throwIfAborted();authorize();const app=loaded.cutover.application,history=loaded.cutover.pending?.settled;
  if(loaded.lastSha256!==input.lastSha256||!app?.ready||!history||loaded.cutover.finalization)throw new Error('恢复最终准备缺少原应用及历史处理证明');
  const request=readRestoreFinalRequest({version:1,operationId:owner,completionId:app.request.completionId,challenge:randomUUID(),documentId:app.request.documentId,documentToken:app.request.documentToken,documentEpoch:app.request.documentEpoch,appVersion:app.request.appVersion,applicationReadySha256:lifecycleDigest(app.ready),applicationReplySha256:lifecycleDigest(app.ready.reply),pendingValuesSha256:app.request.pendingValuesSha256});
  loaded=await store.finalizationRecord(loaded,'finalization-intent',request);signal.throwIfAborted();authorize();this.ports.application.assertMounted(loaded);
  await this.ports.application.quiesceReads(loaded,()=>{signal.throwIfAborted();authorize();});signal.throwIfAborted();authorize();this.ports.resources.assertFinalBarrier(owner);
  let resolve!:(value:RestoreFinalReply)=>void,reject!:(error:Error)=>void;const result=new Promise<RestoreFinalReply>((yes,no)=>{resolve=yes;reject=no;});void result.catch(()=>{});let active!:Active;
  const abort=()=>this.fail(active,new Error('恢复最终准备已中断，资料和独立交互占用保留')),timer=setTimeout(()=>this.fail(active,new Error('恢复最终文档状态没有获得确认')),30000);active={loaded,request,signal,authorize,reply:null,failed:'',result,resolve,reject,timer,abort};this.active=active;signal.addEventListener('abort',abort,{once:true});
  try{
   this.check(active);this.ports.send(request);const reply=await result;this.check(active);
   await this.ports.resources.releaseFinalOwners(owner,history.historyAfterSha256,()=>this.check(active));this.check(active);this.ports.resources.assertFinalBarrier(owner,true);
   const proof=readRestoreFinalProof({requestSha256:lifecycleDigest(request),reply,main:Object.fromEntries(RESTORE_FINAL_MAIN_KEYS.map(key=>[key,true])) as RestoreFinalProof['main'],historyPendingSha256:history.historyAfterSha256},request,lifecycleDigest(request),history.historyAfterSha256);
   loaded=await store.finalizationRecord(loaded,'final-resources-held',proof);this.check(active);this.ports.resources.assertFinalBarrier(owner,true);active.loaded=loaded;this.ports.maintenance.finalReady(owner);return loaded;
  }catch(error){this.fail(active,error instanceof Error?error:new Error(String(error)));throw error;}
 }
 assertReady(loaded:LoadedRestoreTransaction):void{const active=this.active,proof=loaded.cutover.finalization?.proof;if(!active?.reply||!proof||lifecycleDigest(active.request)!==lifecycleDigest(loaded.cutover.finalization?.request)||lifecycleDigest(active.reply)!==lifecycleDigest(proof.reply))throw new Error('恢复最终准备尚未确认原实际证明');this.check(active);this.ports.resources.assertFinalBarrier(active.request.operationId,true);}
 forgetCompleted(loaded:LoadedRestoreTransaction):void{this.assertReady(loaded);if(!loaded.cutover.completed)throw new Error('恢复尚无持久完成证明');const active=this.active!;clearTimeout(active.timer);active.signal.removeEventListener('abort',active.abort);this.active=null;}
}
