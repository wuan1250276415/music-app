import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readRestoreNormalRequest,readRestoreNormalProof} from '../platform/catalog-restore-normal.js';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import {CatalogRestoreTransactionStore,type LoadedRestoreTransaction} from './catalog-restore-transaction-store.js';
import type {CatalogLibraryLifecycle} from './catalog-library-lifecycle.js';
import type {CatalogRestoreRenderer} from './catalog-restore-renderer.js';

type Ports={dataDir:string;library:CatalogLibraryLifecycle;renderer:CatalogRestoreRenderer;assertFrozen:(owner:string)=>void};
// Preparation keeps ordinary RPCs and all three maintenance owners closed.
// A later durable terminal and separately acknowledged releases are required.
export class CatalogRestoreNormalPreparation{
 constructor(private readonly ports:Ports){}
 async prepare(input:LoadedRestoreTransaction,authorize:()=>void,signal:AbortSignal):Promise<LoadedRestoreTransaction>{
  const owner=input.intent.transactionId,check=()=>{signal.throwIfAborted();authorize();this.ports.assertFrozen(owner);this.ports.renderer.assertPrepared(input);};check();
  const store=new CatalogRestoreTransactionStore(this.ports.dataDir);let loaded=await store.load(owner);check();const activation=loaded.cutover.activation,hydration=loaded.cutover.hydration?.ready,renderer=loaded.cutover.renderer?.ready;
  if(loaded.lastSha256!==input.lastSha256||!activation?.proof||!hydration||!renderer||loaded.cutover.normal)throw new Error('普通服务准备缺少已持久的三方恢复结果');const boot=(activation.request.role==='candidate'?loaded.cutover.candidateBoot:loaded.cutover.originalBoot)?.proof;
  if(!boot||!this.ports.library.matchesDormant(boot))throw new Error('普通服务准备所属曲库进程不同');
  const request=readRestoreNormalRequest({version:1,operationId:owner,activationId:activation.request.activationId,challenge:randomUUID(),instanceId:boot.instanceId,token:boot.token,role:activation.request.role,libraryIdentity:boot.libraryIdentity,activationSha256:lifecycleDigest(activation.proof),hydrationSha256:lifecycleDigest(hydration),rendererSha256:lifecycleDigest(renderer)},activation.proof,hydration,renderer,boot.token);
  loaded=await store.normalRecord(loaded,'normal-intent',request);check();
  const proof=readRestoreNormalProof(await this.ports.library.prepareNormalFrozen(request,boot,check),request,activation.proof,hydration.mainSha256);check();
  await store.assertLibrary(path.join(this.ports.dataDir,'library'),proof.libraryIdentity,proof.manifest,signal);check();if(!this.ports.library.matchesDormant(boot))throw new Error('普通服务准备完成后曲库所有者不同');
  loaded=await store.normalRecord(loaded,'normal-prepared',proof);check();return loaded;
 }
}
