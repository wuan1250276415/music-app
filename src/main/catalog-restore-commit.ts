import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import {readRestoreCommitSeal,readRestoreServiceReadyRequest,readRestoreServiceReadyProof} from '../platform/catalog-restore-commit.js';
import {CatalogRestoreTransactionStore,type LoadedRestoreTransaction} from './catalog-restore-transaction-store.js';
import type {CatalogRestoreRenderer} from './catalog-restore-renderer.js';
import type {CatalogLibraryLifecycle} from './catalog-library-lifecycle.js';

type Ports={dataDir:string;library:CatalogLibraryLifecycle;renderer:CatalogRestoreRenderer;assertFrozen:(owner:string)=>void;resumeAllowed:()=>boolean};
export class CatalogRestoreCommit{
 constructor(private readonly ports:Ports){}
 async prepare(input:LoadedRestoreTransaction,authorize:()=>void,signal:AbortSignal):Promise<LoadedRestoreTransaction>{
  const owner=input.intent.transactionId,check=()=>{signal.throwIfAborted();authorize();this.ports.assertFrozen(owner);this.ports.renderer.assertPrepared(input);};check();const store=new CatalogRestoreTransactionStore(this.ports.dataDir);let loaded=await store.load(owner);check();
  const normal=loaded.cutover.normal?.proof,activation=loaded.cutover.activation,hydration=loaded.cutover.hydration?.ready,pending=loaded.cutover.pending?.settled,renderer=loaded.cutover.renderer?.ready;
  if(loaded.lastSha256!==input.lastSha256||!normal||!activation?.proof||!hydration||!pending||!renderer||loaded.cutover.commit)throw new Error('恢复完成决策缺少已持久的三方准备或已有决策');const boot=(activation.request.role==='candidate'?loaded.cutover.candidateBoot:loaded.cutover.originalBoot)?.proof;
  if(!boot||!this.ports.library.matchesDormant(boot))throw new Error('恢复完成决策所属曲库实例不同');await store.assertLibrary(path.join(this.ports.dataDir,'library'),normal.libraryIdentity,normal.manifest,signal);check();
  const seal=readRestoreCommitSeal({version:1,operationId:owner,completionId:randomUUID(),activationId:activation.request.activationId,role:activation.request.role,libraryIdentity:normal.libraryIdentity,normalSha256:lifecycleDigest(normal),manifestSha256:lifecycleDigest(normal.manifest),pendingSha256:lifecycleDigest(pending),hydrationSha256:lifecycleDigest(hydration),rendererSha256:lifecycleDigest(renderer),resumeBackground:this.ports.resumeAllowed()});
  loaded=await store.commitRecord(loaded,'decision-sealed',seal);check();const sealRecordSha256=loaded.lastSha256;
  // Preserve the immutable decision before the SQLite header can change to WAL.
  await store.assertLibrary(path.join(this.ports.dataDir,'library'),normal.libraryIdentity,normal.manifest,signal);check();
  const request=readRestoreServiceReadyRequest({version:1,operationId:owner,completionId:seal.completionId,challenge:randomUUID(),instanceId:normal.instanceId,token:boot.token,libraryIdentity:normal.libraryIdentity,sealSha256:lifecycleDigest(seal),sealRecordSha256,normalSha256:lifecycleDigest(normal)},seal,normal,boot.token,sealRecordSha256);
  loaded=await store.commitRecord(loaded,'service-ready-intent',request);check();const proof=readRestoreServiceReadyProof(await this.ports.library.prepareCommittedService(request,boot,check),request,normal);check();
  if(!this.ports.library.matchesDormant(boot))throw new Error('恢复就绪结果所属曲库实例已变化');loaded=await store.commitRecord(loaded,'service-ready-held',proof);check();return loaded;
 }
}
