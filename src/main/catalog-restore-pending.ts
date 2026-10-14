import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readCatalogBackupPendingSnapshot} from '../platform/catalog-backup-file.js';
import {pendingDirectory,copyPendingFile,verifyPendingArchive,readOriginalPending} from '../platform/catalog-restore-pending-files.js';
import {readRestorePendingIntent,readRestorePendingRequest,readRestorePendingReply,pendingFiles,type RestorePendingRequest,type RestorePendingReply} from '../shared/catalog-restore-pending.js';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import {CatalogRestoreTransactionStore,type LoadedRestoreTransaction} from './catalog-restore-transaction-store.js';
import type {PlaybackHistoryRecorder} from './playback-history.js';

type Ports={dataDir:string;history:PlaybackHistoryRecorder;assertFrozen:(owner:string)=>void;send:(request:RestorePendingRequest)=>void};
export class CatalogRestorePendingCoordinator{
 private waiting:{request:RestorePendingRequest;authorize:()=>void;resolve:(reply:RestorePendingReply)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}|null=null;
 constructor(private readonly ports:Ports){}
 reply(value:unknown,authorize:()=>void):void{
  authorize();const reply=readRestorePendingReply(value),waiting=this.waiting;if(!waiting)throw new Error('没有当前恢复待保存资料挑战');waiting.authorize();this.ports.assertFrozen(reply.operationId);
  const request=waiting.request;if(reply.operationId!==request.operationId||reply.activationId!==request.activationId||reply.challenge!==request.challenge||reply.archiveSha256!==request.archiveSha256||reply.originalSha256!==lifecycleDigest(request.original))throw new Error('恢复待保存资料回执身份或原内容不同');
  clearTimeout(waiting.timer);this.waiting=null;if(reply.error)waiting.reject(new Error(reply.error));else waiting.resolve(reply);
 }
 private challenge(request:RestorePendingRequest,authorize:()=>void,signal:AbortSignal):Promise<RestorePendingReply>{
  if(this.waiting)throw new Error('已有界面待保存资料挑战');return new Promise((resolve,reject)=>{
   const fail=(error:Error)=>{if(this.waiting?.request.challenge!==request.challenge)return;clearTimeout(timer);this.waiting=null;signal.removeEventListener('abort',aborted);reject(error);};
   const aborted=()=>fail(new Error('恢复待保存资料处理已中断，隔离原文继续保留'));const timer=setTimeout(()=>fail(new Error('界面尚未确认恢复待保存资料处理，原文与维护占用保留')),20000);
   this.waiting={request,authorize,resolve:reply=>{signal.removeEventListener('abort',aborted);resolve(reply);},reject:error=>{signal.removeEventListener('abort',aborted);reject(error);},timer};signal.addEventListener('abort',aborted,{once:true});
   try{signal.throwIfAborted();authorize();this.ports.send(request);}catch(error){fail(error instanceof Error?error:new Error(String(error)));}
  });
 }
 async prepare(input:LoadedRestoreTransaction,authorize:()=>void,signal:AbortSignal):Promise<LoadedRestoreTransaction>{
  const store=new CatalogRestoreTransactionStore(this.ports.dataDir),operationId=input.intent.transactionId,check=()=>{signal.throwIfAborted();authorize();this.ports.assertFrozen(operationId);};check();let loaded=await store.load(operationId);
  if(loaded.lastSha256!==input.lastSha256||!loaded.cutover.activation?.proof||loaded.cutover.pending)throw new Error('恢复可写准备或原记录已变化');
  const activation=loaded.cutover.activation,original=loaded.rollback;if(!original)throw new Error('恢复前快照缺失');
  if(await pendingDirectory(original.stagePath)!==original.stageIdentity||await pendingDirectory(loaded.source.prepared.stagePath)!==loaded.source.prepared.stageIdentity)throw new Error('两侧待保存资料来源目录身份不同');
  const originalPending=await readCatalogBackupPendingSnapshot(original.stagePath,original.manifest,{check}),files=pendingFiles(original.manifest,loaded.source.prepared.manifest);
  const folder=path.join(store.paths(operationId).transaction,'pending');await store.roots(loaded.intent);check();await fs.mkdir(folder,{mode:0o700});const directoryIdentity=await pendingDirectory(folder);
  const intent=readRestorePendingIntent({version:1,operationId,activationId:activation.request.activationId,challenge:randomUUID(),role:activation.request.role,directoryIdentity,originalManifestSha256:lifecycleDigest(original.manifest),candidateManifestSha256:lifecycleDigest(loaded.source.prepared.manifest),originalValuesSha256:lifecycleDigest(originalPending.values),files});
  loaded=await store.pendingRecord(loaded,'pending-intent',intent);check();
  const space=await fs.statfs(folder,{bigint:true});if(space.bavail*space.bsize<BigInt(files.reduce((n,f)=>n+f.bytes,0)+1024*1024))throw new Error('恢复资料隔离目录的可用空间不足');
  for(const file of files){check();const source=file.name.startsWith('original-')?original.stagePath:loaded.source.prepared.stagePath,leaf=file.name.endsWith('-renderer.json')?'renderer-pending.json':'playback-history-pending.json';await copyPendingFile(path.join(source,'state',leaf),path.join(folder,file.name),file,check);}
  await verifyPendingArchive(folder,intent,check);if(await pendingDirectory(original.stagePath)!==original.stageIdentity||await pendingDirectory(loaded.source.prepared.stagePath)!==loaded.source.prepared.stageIdentity)throw new Error('两侧隔离来源目录在复制期间变化');loaded=await store.pendingRecord(loaded,'pending-archived',{archiveSha256:lifecycleDigest(intent)});check();
  const savedOriginal=await readOriginalPending(folder,intent,check);if(lifecycleDigest(savedOriginal)!==intent.files.find(f=>f.name==='original-renderer.json')!.sha256)throw new Error('当前原界面快照不是规范捕获内容');
  const request=readRestorePendingRequest({version:1,operationId,activationId:intent.activationId,challenge:intent.challenge,archiveSha256:lifecycleDigest(intent),role:intent.role,original:savedOriginal});
  const reply=await this.challenge(request,authorize,signal);check();loaded=await store.pendingRecord(loaded,'pending-renderer',reply);check();
  const history=await this.ports.history.settleRestorePending(operationId,intent.activationId,intent.files.find(f=>f.name==='original-history.json')!.sha256,intent.role==='candidate',check);check();
  loaded=await store.pendingRecord(loaded,'pending-settled',{archiveSha256:lifecycleDigest(intent),rendererReplySha256:lifecycleDigest(reply),historyBeforeSha256:history.beforeSha256,historyAfterSha256:history.afterSha256,historyReset:intent.role==='candidate'});check();return loaded;
 }
}
