import {CatalogRestoreTransactionStore,type LoadedRestoreTransaction} from './catalog-restore-transaction-store.js';
import {prepareCatalogRestoreCompleted,assertCatalogRestoreStartupSafe} from './catalog-restore-startup.js';
import type {MainCatalogResources} from './catalog-main-resources.js';
import type {CatalogRestoreFinalization} from './catalog-restore-finalization.js';
import type {CatalogRestoreApplication} from './catalog-restore-application.js';
import type {CatalogRestoreRenderer} from './catalog-restore-renderer.js';
import type {CatalogRestoreMaintenance} from './catalog-restore-maintenance.js';
import type {CatalogRestorePreparation} from './catalog-restore-preparation.js';
import type {CatalogLibraryLifecycle} from './catalog-library-lifecycle.js';

type Ports={dataDir:string;resources:MainCatalogResources;finalization:CatalogRestoreFinalization;application:CatalogRestoreApplication;renderer:CatalogRestoreRenderer;maintenance:CatalogRestoreMaintenance;preparation:CatalogRestorePreparation;library:CatalogLibraryLifecycle};
export class CatalogRestoreCompletion{
 constructor(private readonly ports:Ports){}
 private assertOwners(loaded:LoadedRestoreTransaction):void{
  const owner=loaded.intent.transactionId,library=loaded.cutover.libraryRelease?.proof;if(!library)throw new Error('恢复完成缺少原普通曲库实例');this.ports.finalization.assertReady(loaded);this.ports.application.assertMounted(loaded);this.ports.renderer.assertPrepared(loaded);this.ports.maintenance.assertReleaseHeld(owner);this.ports.resources.assertFinalBarrier(owner,true);this.ports.library.assertCompletedHandoff(library);this.ports.preparation.assertCompletedHandoff(owner);
 }
 async complete(input:LoadedRestoreTransaction,authorize:()=>void,signal:AbortSignal):Promise<LoadedRestoreTransaction>{
  const check=()=>{signal.throwIfAborted();authorize();this.assertOwners(input);};check();const store=new CatalogRestoreTransactionStore(this.ports.dataDir);let loaded=await store.load(input.intent.transactionId);check();if(loaded.lastSha256!==input.lastSha256||loaded.cutover.completed)throw new Error('恢复完成原最终资源记录已变化或已完成');
  const certificate=await prepareCatalogRestoreCompleted(this.ports.dataDir,loaded,check);check();loaded=await store.completedRecord(loaded,certificate);check();
  // Reopen the actual persisted completed chain and all retained namespaces.
  // A prospective projection or a successful write alone cannot open input.
  const permission=await assertCatalogRestoreStartupSafe(this.ports.dataDir,check);check();if(!permission||permission.completionId!==certificate.completionId||permission.recordSha256!==loaded.lastSha256||permission.libraryIdentity!==certificate.libraryIdentity||permission.origin!==certificate.origin)throw new Error('恢复完成证书尚未获得真实重启准入');
  this.assertOwners(loaded);const owner=loaded.intent.transactionId;this.ports.maintenance.prepareCompleted(owner,loaded.lastSha256);
  // No await after owner detachment: all preconditions were checked while the
  // independent input/history/playback barriers still owned this operation.
  this.ports.finalization.forgetCompleted(loaded);this.ports.application.forgetCompleted(loaded);this.ports.renderer.forgetCompleted(loaded);this.ports.preparation.forgetCompleted(owner);this.ports.library.handoffCompleted(loaded.cutover.libraryRelease!.proof!);
  this.ports.resources.completeFinalBarrier(owner);this.ports.maintenance.publishCompleted(owner,loaded.lastSha256);return loaded;
 }
}
