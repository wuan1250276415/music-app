import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {lifecycleDigest,type CatalogRestoreBootProof} from '../platform/catalog-library-lifecycle.js';
import {readRestoreHydrationIntent,readRestoreHydrationReady,type RestoreHydrationProof} from '../platform/catalog-restore-hydration.js';
import {readRestoreMainPrior,readRestoreStateSnapshot,type RestoreMainPrior,type RestoreStateSnapshot} from '../shared/catalog-restore-state.js';
import {CatalogRestoreTransactionStore,type LoadedRestoreTransaction} from './catalog-restore-transaction-store.js';
import type {CatalogLibraryLifecycle} from './catalog-library-lifecycle.js';

type Ports={dataDir:string;library:CatalogLibraryLifecycle;assertFrozen:(owner:string)=>void;prior:(owner:string)=>RestoreMainPrior;prepare:(owner:string,proof:RestoreHydrationProof,historySha256:string,authorize:()=>void)=>Promise<RestoreStateSnapshot>;outputReleased:()=>boolean};
// No normal-ready transition or background release is authorized by this step.
export class CatalogRestoreHydration{
 constructor(private readonly ports:Ports){}
 async prepare(input:LoadedRestoreTransaction,authorize:()=>void,signal:AbortSignal):Promise<LoadedRestoreTransaction>{
  const operationId=input.intent.transactionId,check=()=>{signal.throwIfAborted();authorize();this.ports.assertFrozen(operationId);};check();const store=new CatalogRestoreTransactionStore(this.ports.dataDir);let loaded=await store.load(operationId);check();
  const activation=loaded.cutover.activation,pending=loaded.cutover.pending?.settled;
  if(loaded.lastSha256!==input.lastSha256||!activation?.proof||!pending||loaded.cutover.hydration)throw new Error('恢复状态重建缺少已持久可写准备或待保存结果');
  const boot=(activation.request.role==='candidate'?loaded.cutover.candidateBoot:loaded.cutover.originalBoot)?.proof as CatalogRestoreBootProof|undefined;
  if(!boot||!this.ports.library.matchesDormant(boot))throw new Error('恢复状态所属曲库实例不同');
  const prior=readRestoreMainPrior(this.ports.prior(operationId)),intent=readRestoreHydrationIntent({request:{version:1,operationId,activationId:activation.request.activationId,challenge:randomUUID(),instanceId:boot.instanceId,token:boot.token,role:activation.request.role,libraryIdentity:boot.libraryIdentity,activationSha256:lifecycleDigest(activation.proof),pendingSha256:lifecycleDigest(pending),priorMainSha256:lifecycleDigest(prior)},prior});
  loaded=await store.hydrationRecord(loaded,'hydration-intent',intent);check();
  const proof=await this.ports.library.hydrateFrozen(intent.request,boot,check);check();
  await store.assertLibrary(path.join(this.ports.dataDir,'library'),proof.libraryIdentity,activation.proof.manifest,signal);check();
  if(lifecycleDigest(readRestoreMainPrior(this.ports.prior(operationId)))!==intent.request.priorMainSha256)throw new Error('Main 原状态在恢复读取期间变化');
  const current=readRestoreStateSnapshot(await this.ports.prepare(operationId,proof,pending.historyAfterSha256,check));check();
  if(!this.ports.outputReleased()||!this.ports.library.matchesDormant(boot)||lifecycleDigest(current)!==proof.snapshotSha256)throw new Error('Main 使用状态或原进程与恢复读取不同');
  const ready=readRestoreHydrationReady({library:proof,mainSha256:lifecycleDigest(current),historyAfterSha256:pending.historyAfterSha256,outputReleased:true,backgroundStarted:false},intent.request,pending);
  loaded=await store.hydrationRecord(loaded,'hydration-ready',ready);check();return loaded;
 }
}
