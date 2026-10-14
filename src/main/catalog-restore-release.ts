import {randomUUID} from 'node:crypto';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import {readRestoreLibraryReleaseRequest,readRestoreMainReleaseIntent,readRestoreMainReleaseProof} from '../platform/catalog-restore-release.js';
import {CatalogRestoreTransactionStore,type LoadedRestoreTransaction} from './catalog-restore-transaction-store.js';
import type {MainCatalogResources} from './catalog-main-resources.js';
import type {CatalogRestoreRenderer} from './catalog-restore-renderer.js';
import type {CatalogLibraryLifecycle} from './catalog-library-lifecycle.js';
import type {CatalogRestoreMaintenance} from './catalog-restore-maintenance.js';

type Ports={dataDir:string;resources:MainCatalogResources;library:CatalogLibraryLifecycle;renderer:CatalogRestoreRenderer;maintenance:CatalogRestoreMaintenance};
export class CatalogRestoreRelease{
 constructor(private readonly ports:Ports){}
 async release(input:LoadedRestoreTransaction,authorize:()=>void,signal:AbortSignal):Promise<LoadedRestoreTransaction>{
  const owner=input.intent.transactionId,held=()=>{signal.throwIfAborted();authorize();this.ports.maintenance.assertReleaseHeld(owner);};held();this.ports.maintenance.assertFrozen(owner);this.ports.renderer.assertPrepared(input);
  const store=new CatalogRestoreTransactionStore(this.ports.dataDir);let loaded=await store.load(owner);held();
  const commit=loaded.cutover.commit,ready=commit?.proof,activation=loaded.cutover.activation,boot=activation?.request.role==='candidate'?loaded.cutover.candidateBoot?.proof:loaded.cutover.originalBoot?.proof,record=loaded.records.find(record=>record.kind==='service-ready-held');
  if(loaded.lastSha256!==input.lastSha256||!commit||!ready||!activation?.proof||!boot||!record||loaded.cutover.libraryRelease||loaded.cutover.mainRelease||!this.ports.library.matchesDormant(boot))throw new Error('恢复资源释放缺少当前已持久的冻结服务证明');
  this.ports.renderer.handoffPrepared(loaded,held);const check=()=>{held();this.ports.renderer.assertPrepared(loaded);};check();
  const request=readRestoreLibraryReleaseRequest({version:1,operationId:owner,completionId:commit.seal.completionId,challenge:randomUUID(),instanceId:ready.instanceId,token:boot.token,libraryIdentity:ready.libraryIdentity,sealSha256:lifecycleDigest(commit.seal),readySha256:lifecycleDigest(ready),readyRecordSha256:record.sha256,resumeWatch:commit.seal.resumeBackground},commit.seal,ready,boot.token,record.sha256);
  loaded=await store.releaseRecord(loaded,'library-release-intent',request);check();this.ports.maintenance.beginRestoredRelease(request);
  const proof=await this.ports.library.releaseCommittedService(request,boot,async proof=>{check();loaded=await store.releaseRecord(loaded,'library-released',proof);check();},check);check();
  this.ports.maintenance.markRestoredReleased(proof);check();if(!this.ports.library.matchesReleased(proof))throw new Error('恢复曲库普通服务转换未确认当前实际进程');
  const intent=readRestoreMainReleaseIntent({version:1,operationId:owner,completionId:commit.seal.completionId,challenge:randomUUID(),libraryReleaseSha256:lifecycleDigest(proof),resources:this.ports.resources.restoreResourceNames(),resumeBackground:commit.seal.resumeBackground},proof,commit.seal);
  loaded=await store.releaseRecord(loaded,'main-release-intent',intent);check();
  await this.ports.resources.releaseRestoreResources(owner,intent.resumeBackground,()=>{check();if(!this.ports.library.matchesReleased(proof))throw new Error('释放主程序资源期间曲库实际进程已改变');});check();this.ports.resources.assertRestoreResourcesReleased(owner);
  const result=readRestoreMainReleaseProof({version:1,operationId:owner,completionId:intent.completionId,challenge:intent.challenge,requestSha256:lifecycleDigest(intent),resourcesSha256:lifecycleDigest(this.ports.resources.restoreResourceNames()),resourcesReleased:true,playbackHeld:true,historyHeld:true,userGateHeld:true},intent);
  loaded=await store.releaseRecord(loaded,'main-resources-released',result);check();this.ports.resources.assertRestoreResourcesReleased(owner);return loaded;
 }
}
