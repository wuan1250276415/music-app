import {randomUUID} from 'node:crypto';
import {readRestoreAppRequest,readRestoreAppReply,readRestoreAppReady,restoreAppQueue,restoreAppBrowse,RESTORE_APP_READ_KEYS,type RestoreAppReadKey,type RestoreAppRequest,type RestoreAppReply} from '../shared/catalog-restore-application.js';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import {RESTORE_TRANSACTION_FRAME_BYTES} from '../shared/catalog-restore-transaction.js';
import {CatalogRestoreTransactionStore,type LoadedRestoreTransaction} from './catalog-restore-transaction-store.js';
import type {MainCatalogResources} from './catalog-main-resources.js';
import type {CatalogRestoreRenderer} from './catalog-restore-renderer.js';
import type {CatalogLibraryLifecycle} from './catalog-library-lifecycle.js';
import type {CatalogRestoreMaintenance} from './catalog-restore-maintenance.js';

const channels=new Set(['playback:state','queue:view','library:stats','library:roots','playlist:list','library:browse','library:item','library:artwork','library:artwork-candidate','library:artwork-lease','library:lyrics-bundle','audio:backend','audio:output','audio:asio-output','search:index-state','catalog:view','desktop:files']);
const core:Record<string,RestoreAppReadKey>={'playback:state':'playback','queue:view':'queue','library:stats':'stats','library:roots':'roots','playlist:list':'playlists','library:browse':'browse'};
type Ports={dataDir:string;resources:MainCatalogResources;renderer:CatalogRestoreRenderer;library:CatalogLibraryLifecycle;maintenance:CatalogRestoreMaintenance;location:()=>{webContentsId:number;epoch:number;url:string};send:(request:RestoreAppRequest)=>void};
type Active={loaded:LoadedRestoreTransaction;request:RestoreAppRequest;signal:AbortSignal;authorize:()=>void;accepting:boolean;quiesced:boolean;failed:string;observed:Map<RestoreAppReadKey,Set<string>>;reply:RestoreAppReply|null;result:Promise<RestoreAppReply>;resolve:(reply:RestoreAppReply)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout;abort:()=>void};
export class CatalogRestoreApplication{
 private active:Active|null=null;
 constructor(private readonly ports:Ports){}
 private check(active:Active):void{
  if(this.active!==active||active.failed)throw new Error(active.failed||'恢复应用读取不属于当前操作');active.signal.throwIfAborted();active.authorize();const owner=active.request.operationId;this.ports.maintenance.assertReleaseHeld(owner);if(active.quiesced)this.ports.resources.assertFinalBarrier(owner);else this.ports.resources.assertRestoreResourcesReleased(owner);this.ports.renderer.assertPrepared(active.loaded);
  const proof=active.loaded.cutover.libraryRelease?.proof,now=this.ports.location(),intent=active.loaded.cutover.renderer!.intent;if(!proof||!this.ports.library.matchesReleased(proof)||now.webContentsId!==intent.webContentsId||now.epoch!==active.request.documentEpoch||now.url!==intent.url)throw new Error('恢复应用所属曲库实例或新文档已改变');
 }
 private fail(active:Active,error:Error):void{if(active.failed)return;active.failed=error.message;active.accepting=false;clearTimeout(active.timer);active.signal.removeEventListener('abort',active.abort);active.reject(error);}
 tryRead<T>(channel:string,args:unknown[],action:()=>Promise<T>|T,authorizeSender:()=>void):Promise<T>|undefined{
  const active=this.active;if(!active||!active.accepting||!channels.has(channel))return undefined;
  // Automatic image reads may retain display leases/cache. Explicit refresh is
  // a separate user operation and cannot run behind the held document.
  if(channel==='library:artwork'&&args[1]===true||channel==='library:artwork-candidate'&&args[3]===true)return Promise.reject(new Error('恢复界面加载期间不能主动重读封面'));
  const check=()=>{authorizeSender();this.check(active);};check();return this.ports.resources.runRestoreRead(active.request.operationId,()=>Promise.resolve(action()).then(value=>{
   check();const key=core[channel];if(key){let projection:unknown=value;
    if(key==='browse'){const response=value as {status?:string;snapshot?:string;total?:number},query=(args[0] as {query?:unknown})?.query;if(response.status!=='ready')return value;projection=restoreAppBrowse(query,response.snapshot,response.total);}
    if(Buffer.byteLength(JSON.stringify(projection))>RESTORE_TRANSACTION_FRAME_BYTES)throw new Error('恢复应用读取超过单次资料预算');const sha=lifecycleDigest(projection),values=active.observed.get(key)??new Set<string>();values.delete(sha);values.add(sha);while(values.size>8)values.delete(values.values().next().value!);active.observed.set(key,values);
   }return value;
  }),check);
 }
 reply(value:unknown,authorizeSender:()=>void):void{
  authorizeSender();const active=this.active;if(!active)throw new Error('没有当前恢复应用加载挑战');this.check(active);const reply=readRestoreAppReply(value),request=active.request;
  if(reply.operationId!==request.operationId||reply.completionId!==request.completionId||reply.challenge!==request.challenge||reply.documentId!==request.documentId||reply.documentToken!==request.documentToken||reply.documentEpoch!==request.documentEpoch||reply.appVersion!==request.appVersion||reply.requestSha256!==lifecycleDigest(request))throw new Error('恢复应用回执与原文档挑战不同');
  if(active.reply){if(lifecycleDigest(active.reply)!==lifecycleDigest(reply))throw new Error('恢复应用原回执不能改变');return;}
  if(reply.error){active.reply=reply;this.fail(active,new Error(reply.error));return;}
  if(reply.queueSha256!==request.queueSha256||reply.pendingValuesSha256!==request.pendingValuesSha256||!reply.reads||RESTORE_APP_READ_KEYS.some(key=>!active.observed.get(key)?.has(reply.reads![key])))throw new Error('恢复应用就绪回执没有对应的实际主程序读取结果');
  active.reply=reply;clearTimeout(active.timer);active.resolve(reply);
 }
 assertMounted(loaded:LoadedRestoreTransaction):void{const active=this.active,ready=loaded.cutover.application?.ready;if(!active?.reply||!ready||lifecycleDigest(active.reply)!==lifecycleDigest(ready.reply)||lifecycleDigest(active.request)!==lifecycleDigest(loaded.cutover.application?.request))throw new Error('当前恢复应用尚未确认原实际加载证明');this.check(active);}
 async quiesceReads(loaded:LoadedRestoreTransaction,authorize:()=>void):Promise<void>{
  this.assertMounted(loaded);authorize();const active=this.active!;if(active.quiesced)throw new Error('恢复应用已进入最终准备，不能重试原读取阶段');active.accepting=false;
  await this.ports.resources.waitRestoreReads(active.request.operationId);this.check(active);authorize();this.ports.resources.installFinalBarrier(active.request.operationId);active.quiesced=true;this.check(active);
 }
 forgetCompleted(loaded:LoadedRestoreTransaction):void{this.assertMounted(loaded);if(!loaded.cutover.completed||!this.active!.quiesced||this.active!.accepting)throw new Error('恢复应用尚未完成或读取仍开放');const active=this.active!;clearTimeout(active.timer);active.signal.removeEventListener('abort',active.abort);this.active=null;}
 async prepare(input:LoadedRestoreTransaction,authorize:()=>void,signal:AbortSignal):Promise<LoadedRestoreTransaction>{
  if(this.active)throw new Error('已有恢复应用加载意图，不能猜测重试');signal.throwIfAborted();authorize();const owner=input.intent.transactionId;this.ports.maintenance.assertReleaseHeld(owner);this.ports.resources.assertRestoreResourcesReleased(owner);this.ports.renderer.assertPrepared(input);
  const store=new CatalogRestoreTransactionStore(this.ports.dataDir);let loaded=await store.load(owner);signal.throwIfAborted();authorize();const main=loaded.cutover.mainRelease?.proof,renderer=loaded.cutover.renderer?.ready,seal=loaded.cutover.commit?.seal,hydration=loaded.cutover.hydration?.ready;
  if(loaded.lastSha256!==input.lastSha256||!main||!renderer||!seal||!hydration||loaded.cutover.application)throw new Error('恢复应用加载缺少原主程序或新文档准备结果');
  const request=readRestoreAppRequest({version:1,operationId:owner,completionId:seal.completionId,challenge:randomUUID(),documentId:renderer.reply.documentId,documentToken:renderer.reply.documentToken,documentEpoch:renderer.reply.documentEpoch,appVersion:renderer.reply.appVersion,mainReleaseSha256:lifecycleDigest(main),rendererReadySha256:lifecycleDigest(renderer),queueSha256:lifecycleDigest(restoreAppQueue(hydration.library.snapshot.queue)),pendingValuesSha256:renderer.reply.pendingValuesSha256});
  loaded=await store.applicationRecord(loaded,'application-intent',request);signal.throwIfAborted();authorize();this.ports.resources.assertRestoreResourcesReleased(owner);this.ports.renderer.assertPrepared(loaded);
  let resolve!:(reply:RestoreAppReply)=>void,reject!:(error:Error)=>void;const result=new Promise<RestoreAppReply>((yes,no)=>{resolve=yes;reject=no;});void result.catch(()=>{});let active!:Active;
  const abort=()=>this.fail(active,new Error('恢复应用加载已中断，原资料与交互占用保留')),timer=setTimeout(()=>this.fail(active,new Error('恢复应用实际读取或加载没有获得完整确认')),60000);active={loaded,request,signal,authorize,accepting:true,quiesced:false,failed:'',observed:new Map(),reply:null,result,resolve,reject,timer,abort};this.active=active;signal.addEventListener('abort',abort,{once:true});
  try{this.check(active);this.ports.send(request);const reply=await result;this.check(active);const now=this.ports.location(),ready=readRestoreAppReady({reply,navigation:{webContentsId:now.webContentsId,documentEpoch:now.epoch,url:now.url},readsObserved:true},request,lifecycleDigest(request),loaded.cutover.renderer!.intent);
   loaded=await store.applicationRecord(loaded,'application-ready',ready);this.check(active);active.loaded=loaded;return loaded;
  }catch(error){this.fail(active,error instanceof Error?error:new Error(String(error)));throw error;}
 }
}
