import {CatalogRestoreTransactionStore,restoreTransactionOptionalDirectory,type LoadedRestoreTransaction} from './catalog-restore-transaction-store.js';
import {CatalogDirectoryMoveJournal,directoryMovePaths,type LoadedDirectoryMove} from './catalog-directory-move-journal.js';
import {inspectCatalogRestoreStartup,type RestoreStartupInspection} from './catalog-restore-startup.js';
import {cutoverMoveManifest,libraryManifestDigest} from '../platform/catalog-restore-cutover.js';
import {inventoryCatalogLibraryDirectory} from '../platform/catalog-backup-file.js';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import {backupUuid} from '../shared/catalog-backup.js';
import {MOVE_RECONCILIATION_POLICY,readRecordedMoveReview,type RecordedMoveReview} from '../shared/catalog-move-reconciliation.js';

export type RecordedMoveInspection={review:RecordedMoveReview;startup:RestoreStartupInspection;transaction:LoadedRestoreTransaction;native:LoadedDirectoryMove};
// Confirm an already recorded actual native exit, never synthesize a missing
// exit receipt from directory observations or inspect mutable WAL as old DELETE.
export async function inspectRecordedMove(dataDir:string,value:unknown,check:()=>void,signal:AbortSignal):Promise<RecordedMoveInspection>{
 const transactionId=backupUuid(value),store=new CatalogRestoreTransactionStore(dataDir),guard=()=>{signal.throwIfAborted();check();};guard();
 const startup=await inspectCatalogRestoreStartup(dataDir,guard);guard();const transaction=await store.load(transactionId);guard();
 const pending=transaction.cutover.moves.at(-1);if(!pending||pending.completion||transaction.cutover.activation||transaction.cutover.completed||transaction.aborted||!transaction.exited||!transaction.closed)throw new Error('当前事务没有可审核的激活前未决切换回执');
 const native=await CatalogDirectoryMoveJournal.reopen(dataDir,transactionId,pending.request.operationId);guard();
 if(!native.completed||!native.exitSha256||!native.proof||native.stages.length!==4||JSON.stringify(native.request)!==JSON.stringify(pending.request))throw new Error('缺少原切换进程的完整阶段及实际正常退出回执，不能补记');
 const paths=directoryMovePaths(pending.request),manifest=cutoverMoveManifest(store.context(transaction),pending.request.action),expected=manifest.files.filter(file=>file.path.startsWith('library/'));
 await store.roots(transaction.intent);guard();if(await restoreTransactionOptionalDirectory(paths.source)!==null||await restoreTransactionOptionalDirectory(paths.target)!==pending.request.sourceIdentity)throw new Error('原切换的源位置或目标目录身份不同，资料保持');
 const actual=await inventoryCatalogLibraryDirectory(paths.target,{signal,check:guard});guard();if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('目标曲库完整内容与原切换清单不同，不能补记');
 const again=await store.load(transactionId),nativeAgain=await CatalogDirectoryMoveJournal.reopen(dataDir,transactionId,pending.request.operationId);guard();
 if(again.lastSha256!==transaction.lastSha256||nativeAgain.requestSha256!==native.requestSha256||nativeAgain.exitSha256!==native.exitSha256||lifecycleDigest(nativeAgain.proof)!==lifecycleDigest(native.proof)||await restoreTransactionOptionalDirectory(paths.source)!==null||await restoreTransactionOptionalDirectory(paths.target)!==pending.request.sourceIdentity)throw new Error('原切换记录或目录在审核期间变化');
 const after=await inspectCatalogRestoreStartup(dataDir,guard);guard();if(lifecycleDigest(after)!==lifecycleDigest(startup))throw new Error('恢复历史或实际目录在审核期间变化');
 return {transaction,native,startup,review:readRecordedMoveReview({version:1,transactionId,operationId:pending.request.operationId,action:pending.request.action,transactionSha256:transaction.lastSha256,startupSha256:lifecycleDigest(startup),requestSha256:native.requestSha256,exitSha256:native.exitSha256,filesSha256:libraryManifestDigest(manifest),targetIdentity:pending.request.sourceIdentity,files:actual.length,bytes:actual.reduce((n,file)=>n+file.bytes,0),inspectedAt:new Date().toISOString(),policy:MOVE_RECONCILIATION_POLICY})};
}
