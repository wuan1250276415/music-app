import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {readRestoreRendererIntent,readRestoreRendererReply,type RestoreRendererIntent,type RestoreRendererReply,type RestoreRendererRequest} from '../shared/catalog-restore-renderer.js';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import {RELEASE} from '../shared/release.js';
import {CatalogRestoreTransactionStore,type LoadedRestoreTransaction} from './catalog-restore-transaction-store.js';

type Location={webContentsId:number;epoch:number;url:string};
type Ports={dataDir:string;rendererFile:string;location:()=>Location;assertHydrated:(loaded:LoadedRestoreTransaction)=>void;reload:()=>void};
type Active={intent:RestoreRendererIntent;started:boolean;navigation:boolean;loaded:boolean;failed:string;load:Promise<void>;loadResolve:()=>void;loadReject:(error:Error)=>void;result:Promise<RestoreRendererReply>;resolve:(reply:RestoreRendererReply)=>void;reject:(error:Error)=>void;checkAfter:()=>void;timer:NodeJS.Timeout;signal:AbortSignal;abort:()=>void;reply:RestoreRendererReply|null};
export class CatalogRestoreRenderer{
 private active:Active|null=null;
 private handedOff=false;
 constructor(private readonly ports:Ports){}
 private knownUrl(url:string):boolean{try{const parsed=new URL(url);return parsed.protocol==='file:'&&!parsed.search&&!parsed.hash&&path.resolve(fileURLToPath(parsed)).toLowerCase()===path.resolve(this.ports.rendererFile).toLowerCase();}catch{return false;}}
 private current(active:Active):void{
  if(active.failed)throw new Error(active.failed);active.checkAfter();active.signal.throwIfAborted();const now=this.ports.location();if(!active.started||!active.navigation||now.webContentsId!==active.intent.webContentsId||now.epoch!==active.intent.request.documentEpoch||!this.knownUrl(now.url)||now.url!==active.intent.url)throw new Error('当前恢复界面不是已登记的新文档');
 }
 // The host observes the only allowed loading transition. Every subsequent
 // navigation still takes the ordinary interruption path, including refresh.
 loading():boolean{const active=this.active;if(!active||active.started)return false;try{const now=this.ports.location();active.checkAfter();active.signal.throwIfAborted();if(now.webContentsId!==active.intent.webContentsId||now.epoch!==active.intent.request.documentEpoch||now.url!==active.intent.url||!this.knownUrl(now.url))return false;active.started=true;return true;}catch{return false;}}
 navigation(url:string,isMainFrame:boolean,isInPlace:boolean):boolean{
  const active=this.active;if(!active)return false;if(!isMainFrame)return true;
  try{active.checkAfter();active.signal.throwIfAborted();const now=this.ports.location();if(active.failed||active.navigation||isInPlace||!this.knownUrl(url)||url!==active.intent.url||now.webContentsId!==active.intent.webContentsId||![active.intent.previousEpoch,active.intent.request.documentEpoch].includes(now.epoch))return false;active.navigation=true;return true;}catch{return false;}
 }
 loaded():void{const active=this.active;if(!active?.started||active.loaded)return;try{this.current(active);active.loaded=true;active.loadResolve();}catch(error){this.fail(error instanceof Error?error:new Error(String(error)));}}
 private fail(error:Error):void{const active=this.active;if(!active||active.failed)return;active.failed=error.message;clearTimeout(active.timer);active.signal.removeEventListener('abort',active.abort);active.loadReject(error);active.reject(error);}
 assertPrepared(loaded:LoadedRestoreTransaction):void{
  const active=this.active,renderer=loaded.cutover.renderer;if(!active||!active.loaded||!active.reply||!renderer?.ready||lifecycleDigest(active.intent)!==lifecycleDigest(renderer.intent)||lifecycleDigest(active.reply)!==lifecycleDigest(renderer.ready.reply))throw new Error('当前新界面尚未确认原准备证明');this.current(active);
 }
 handoffPrepared(loaded:LoadedRestoreTransaction,authorizeAfter:()=>void):void{
  this.assertPrepared(loaded);if(this.handedOff)throw new Error('新恢复文档已交接到释放阶段');authorizeAfter();
  // Keep the independently observed document/frame/epoch checks. Replace only
  // the obsolete frozen-Library/Main-cache guard before those owners resume.
  this.active!.checkAfter=authorizeAfter;this.handedOff=true;this.current(this.active!);
 }
 forgetCompleted(loaded:LoadedRestoreTransaction):void{this.assertPrepared(loaded);if(!loaded.cutover.completed)throw new Error('新恢复文档尚无完成证明');const active=this.active!;clearTimeout(active.timer);active.signal.removeEventListener('abort',active.abort);this.active=null;this.handedOff=false;}
 async seed(authorize:()=>void):Promise<RestoreRendererRequest|null>{
  authorize();const active=this.active;if(!active)return null;this.current(active);await active.load;authorize();this.current(active);return structuredClone(active.intent.request);
 }
 reply(value:unknown,authorize:()=>void):void{
  authorize();const active=this.active;if(!active?.loaded)throw new Error('没有当前新文档的恢复准备请求');this.current(active);const reply=readRestoreRendererReply(value),request=active.intent.request;
  if(reply.operationId!==request.operationId||reply.activationId!==request.activationId||reply.challenge!==request.challenge||reply.documentToken!==request.documentToken||reply.documentEpoch!==request.documentEpoch||reply.appVersion!==request.appVersion||reply.requestSha256!==lifecycleDigest(request)||reply.prepared&&(reply.snapshotSha256!==request.snapshotSha256||reply.pendingValuesSha256!==request.pendingValuesSha256))throw new Error('恢复界面回执与原挑战不同');
  if(active.reply){if(lifecycleDigest(active.reply)!==lifecycleDigest(reply))throw new Error('恢复界面原回执不能改变');return;}
  active.reply=reply;clearTimeout(active.timer);active.signal.removeEventListener('abort',active.abort);if(reply.error)active.reject(new Error(reply.error));else active.resolve(reply);
 }
 async prepare(input:LoadedRestoreTransaction,authorizeBefore:()=>void,authorizeAfter:()=>void,signal:AbortSignal):Promise<LoadedRestoreTransaction>{
  if(this.active)throw new Error('已有界面准备登记，不能猜测重试');authorizeBefore();signal.throwIfAborted();this.ports.assertHydrated(input);const store=new CatalogRestoreTransactionStore(this.ports.dataDir);let loaded=await store.load(input.intent.transactionId);authorizeBefore();signal.throwIfAborted();
  const ready=loaded.cutover.hydration?.ready,pending=loaded.cutover.pending?.renderer,activation=loaded.cutover.activation;if(loaded.lastSha256!==input.lastSha256||!ready||!pending||pending.error||!pending.resultSha256||!activation?.proof||loaded.cutover.renderer)throw new Error('界面准备缺少已持久的 Main 状态或待保存结果');
  const now=this.ports.location();if(!this.knownUrl(now.url))throw new Error('当前界面不是固定应用页面');
  const intent=readRestoreRendererIntent({request:{version:1,operationId:loaded.intent.transactionId,activationId:activation.request.activationId,challenge:randomUUID(),documentToken:randomUUID(),documentEpoch:now.epoch+1,appVersion:RELEASE.appVersion,hydrationSha256:lifecycleDigest(ready),snapshot:ready.library.snapshot,snapshotSha256:ready.mainSha256,pendingValuesSha256:pending.resultSha256},webContentsId:now.webContentsId,previousEpoch:now.epoch,url:now.url});
  loaded=await store.rendererRecord(loaded,'renderer-intent',intent);authorizeBefore();signal.throwIfAborted();this.ports.assertHydrated(loaded);
  let loadResolve!:()=>void,loadReject!:(error:Error)=>void,resolve!:(reply:RestoreRendererReply)=>void,reject!:(error:Error)=>void;const load=new Promise<void>((yes,no)=>{loadResolve=yes;loadReject=no;}),result=new Promise<RestoreRendererReply>((yes,no)=>{resolve=yes;reject=no;});void load.catch(()=>{});void result.catch(()=>{});
  const checkAfter=()=>{authorizeAfter();this.ports.assertHydrated(loaded);},abort=()=>this.fail(new Error('恢复界面准备已中断，原资料与维护占用保留')),timer=setTimeout(()=>this.fail(new Error('新界面未确认恢复准备，原资料与占用保留')),60000);
  const active:Active={intent,started:false,navigation:false,loaded:false,failed:'',load,loadResolve,loadReject,result,resolve,reject,checkAfter,timer,signal,abort,reply:null};this.active=active;signal.addEventListener('abort',abort,{once:true});
  try{signal.throwIfAborted();authorizeBefore();this.ports.reload();const reply=await result;this.current(active);const observed=this.ports.location();loaded=await store.rendererRecord(loaded,'renderer-ready',{reply,navigation:{webContentsId:observed.webContentsId,documentEpoch:observed.epoch,url:observed.url,crossDocument:true}});this.current(active);return loaded;}
  catch(error){this.fail(error instanceof Error?error:new Error(String(error)));throw error;}
 }
}
