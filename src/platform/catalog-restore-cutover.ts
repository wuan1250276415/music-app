import {readMoveReconciliationAudit,type MoveReconciliationAudit} from '../shared/catalog-move-reconciliation.js';
import {readRestoreCompleted,type RestoreCompleted} from './catalog-restore-completion.js';
import {readRestoreFinalRequest,bindRestoreFinalRequest,readRestoreFinalProof,type RestoreFinalRequest,type RestoreFinalProof} from '../shared/catalog-restore-finalization.js';
import {readRestoreAppRequest,readRestoreAppReady,restoreAppQueue,type RestoreAppRequest,type RestoreAppReady} from '../shared/catalog-restore-application.js';
import {readRestoreLibraryReleaseRequest,readRestoreLibraryReleaseProof,readRestoreMainReleaseIntent,readRestoreMainReleaseProof,type RestoreLibraryReleaseRequest,type RestoreLibraryReleaseProof,type RestoreMainReleaseIntent,type RestoreMainReleaseProof} from './catalog-restore-release.js';
import {readRestoreCommitSeal,readRestoreServiceReadyRequest,readRestoreServiceReadyProof,type RestoreCommitSeal,type RestoreServiceReadyRequest,type RestoreServiceReadyProof} from './catalog-restore-commit.js';
import {readRestoreNormalRequest,readRestoreNormalProof,type RestoreNormalRequest,type RestoreNormalProof} from './catalog-restore-normal.js';
import {readRestoreRendererIntent,readRestoreRendererReady,type RestoreRendererIntent,type RestoreRendererReady} from '../shared/catalog-restore-renderer.js';
import {readRestoreHydrationIntent,readRestoreHydrationRequest,readRestoreHydrationReady,type RestoreHydrationIntent,type RestoreHydrationReady} from './catalog-restore-hydration.js';
import {readRestorePendingIntent,readRestorePendingReply,readRestorePendingSettled,pendingFiles,type RestorePendingIntent,type RestorePendingReply,type RestorePendingSettled} from '../shared/catalog-restore-pending.js';
import {readCatalogRestoreActivationRequest,readCatalogRestoreActivationProof,type CatalogRestoreActivationRequest,type CatalogRestoreActivationProof} from './catalog-restore-activation.js';
import {backupUuid,type CatalogBackupManifest} from '../shared/catalog-backup.js';
import {restoreTransactionFields as fields,restoreTransactionDigest,type RestoreTransactionIntent,type RestoreCandidateProof} from '../shared/catalog-restore-transaction.js';
import {readDirectoryMoveRequest,type CatalogDirectoryMoveRequest,type DirectoryMoveAction} from '../shared/catalog-directory-move.js';
import {readCatalogRestoreBootRequest,readCatalogRestoreBootProof,readCatalogServiceStopRequest,readCatalogServiceStopReceipt,readCatalogServiceExitProof,lifecycleDigest,type CatalogRestoreBootRequest,type CatalogRestoreBootProof,type CatalogServiceStopRequest,type CatalogServiceStopReceipt,type CatalogServiceExitProof} from './catalog-library-lifecycle.js';

export const RESTORE_CUTOVER_KINDS=['move-intent','move-completed','move-reconciled','boot-intent','boot-ready','boot-failed','rollback-intent','dormant-closing','dormant-closed','dormant-exited','activation-intent','activation-ready','pending-intent','pending-archived','pending-renderer','pending-settled','hydration-intent','hydration-ready','renderer-intent','renderer-ready','normal-intent','normal-prepared','decision-sealed','service-ready-intent','service-ready-held','library-release-intent','library-released','main-release-intent','main-resources-released','application-intent','application-ready','finalization-intent','final-resources-held','completed'] as const;
export type RestoreCutoverKind=typeof RESTORE_CUTOVER_KINDS[number];
export type RestoreBootRole='candidate'|'original';
export type RestoreMoveCompletion={operationId:string;requestSha256:string;exitSha256:string;filesSha256:string};
export type RestoreBootIntent={role:RestoreBootRole;request:CatalogRestoreBootRequest};
export type RestoreBootReady={role:RestoreBootRole;proof:CatalogRestoreBootProof};
export type RestoreBootFailure={role:RestoreBootRole;requestSha256:string;reason:string};
export type RestoreRollbackIntent={reason:string};
export type RestoreReconciledMove={move:RestoreMoveCompletion;audit:MoveReconciliationAudit};
export type RestoreCutoverPayload=RestoreReconciledMove|CatalogDirectoryMoveRequest|RestoreMoveCompletion|RestoreBootIntent|RestoreBootReady|RestoreBootFailure|RestoreRollbackIntent|CatalogServiceStopRequest|CatalogServiceStopReceipt|CatalogServiceExitProof|CatalogRestoreActivationRequest|CatalogRestoreActivationProof|RestorePendingIntent|RestorePendingReply|RestorePendingSettled|{archiveSha256:string}|RestoreHydrationIntent|RestoreHydrationReady|RestoreRendererIntent|RestoreRendererReady|RestoreNormalRequest|RestoreNormalProof|RestoreCommitSeal|RestoreServiceReadyRequest|RestoreServiceReadyProof|RestoreLibraryReleaseRequest|RestoreLibraryReleaseProof|RestoreMainReleaseIntent|RestoreMainReleaseProof|RestoreAppRequest|RestoreAppReady|RestoreFinalRequest|RestoreFinalProof|RestoreCompleted;
export type RestoreBootState={request:CatalogRestoreBootRequest;proof:CatalogRestoreBootProof|null;failure:string|null};
export type RestoreCutoverState={moves:Array<{request:CatalogDirectoryMoveRequest;completion:RestoreMoveCompletion|null}>;candidateBoot:RestoreBootState|null;originalBoot:RestoreBootState|null;rollbackReason:string|null;dormantClosing:CatalogServiceStopRequest|null;dormantClosed:CatalogServiceStopReceipt|null;dormantExited:CatalogServiceExitProof|null;activation:{request:CatalogRestoreActivationRequest;proof:CatalogRestoreActivationProof|null}|null;pending:{intent:RestorePendingIntent;archived:boolean;renderer:RestorePendingReply|null;settled:RestorePendingSettled|null}|null;hydration:{intent:RestoreHydrationIntent;ready:RestoreHydrationReady|null}|null;renderer:{intent:RestoreRendererIntent;ready:RestoreRendererReady|null}|null;normal:{request:RestoreNormalRequest;proof:RestoreNormalProof|null}|null;commit:{seal:RestoreCommitSeal;request:RestoreServiceReadyRequest|null;proof:RestoreServiceReadyProof|null}|null;libraryRelease:{request:RestoreLibraryReleaseRequest;proof:RestoreLibraryReleaseProof|null}|null;mainRelease:{intent:RestoreMainReleaseIntent;proof:RestoreMainReleaseProof|null}|null;application:{request:RestoreAppRequest;ready:RestoreAppReady|null}|null;finalization:{request:RestoreFinalRequest;proof:RestoreFinalProof|null}|null;completed:RestoreCompleted|null};
export type RestoreCutoverContext={intent:RestoreTransactionIntent;candidate:RestoreCandidateProof|null;closed:CatalogServiceStopReceipt|null;exited:CatalogServiceExitProof|null;candidateManifest:CatalogBackupManifest;originalSnapshotManifest:CatalogBackupManifest|null;commitSealRecordSha256?:string;serviceReadyRecordSha256?:string;finalRecordSha256?:string;previousRecordSha256?:string};
export const emptyRestoreCutover=():RestoreCutoverState=>({moves:[],candidateBoot:null,originalBoot:null,rollbackReason:null,dormantClosing:null,dormantClosed:null,dormantExited:null,activation:null,pending:null,hydration:null,renderer:null,normal:null,commit:null,libraryRelease:null,mainRelease:null,application:null,finalization:null,completed:null});
export const libraryManifestDigest=(manifest:CatalogBackupManifest)=>lifecycleDigest(manifest.files.filter(file=>file.path.startsWith('library/')));
const reason=(value:unknown):string=>{if(typeof value!=='string'||!value||value.length>1024||value.includes('\0'))throw new Error('整库恢复失败原因无效');return value;};
function role(value:unknown):RestoreBootRole{if(value!=='candidate'&&value!=='original')throw new Error('恢复启动角色无效');return value;}
export function completedCutoverMove(state:RestoreCutoverState,action:DirectoryMoveAction):boolean{return state.moves.some(move=>move.request.action===action&&Boolean(move.completion));}
function settledMoves(state:RestoreCutoverState):void{if(state.moves.some(move=>!move.completion))throw new Error('目录移动意图尚无实际正常退出及内容核对证明');}
export function cutoverMoveManifest(context:RestoreCutoverContext,action:DirectoryMoveAction):CatalogBackupManifest{if(!context.closed)throw new Error('原曲库尚无数据库关闭回执');return action==='retire-original'||action==='restore-original'?context.closed.manifest:context.candidateManifest;}
export function cutoverMoveRequest(context:RestoreCutoverContext,operationId:string,action:DirectoryMoveAction):CatalogDirectoryMoveRequest{
 if(!context.candidate)throw new Error('原候选曲库尚未准备');const i=context.intent;
 return readDirectoryMoveRequest({version:1,kind:'directory-move',operationId,transactionId:i.transactionId,action,userData:i.userData,userDataIdentity:i.userDataIdentity,transactionIdentity:i.transactionIdentity,dataIdentity:i.dataIdentity,candidateIdentity:i.candidateIdentity,sourceIdentity:action==='retire-original'||action==='restore-original'?i.liveIdentity:context.candidate.libraryIdentity});
}
export function readRestoreMoveCompletion(value:unknown):RestoreMoveCompletion{const v=fields(value,['operationId','requestSha256','exitSha256','filesSha256']);return {operationId:backupUuid(v.operationId),requestSha256:restoreTransactionDigest(v.requestSha256),exitSha256:restoreTransactionDigest(v.exitSha256),filesSha256:restoreTransactionDigest(v.filesSha256)};}

// Parse the ordered immutable global chain. This is deliberately independent of
// current process liveness; live owners and file checks gate each new append.
export function readRestoreCutoverRecord(kind:RestoreCutoverKind,value:unknown,context:RestoreCutoverContext,state:RestoreCutoverState):RestoreCutoverPayload{
 if(state.completed)throw new Error('恢复完成终态不能追加记录');
 if(!context.exited||!context.closed||!context.candidate)throw new Error('整库切换缺少原服务实际退出或候选证明');
 const transactionId=context.intent.transactionId,retired=completedCutoverMove(state,'retire-original'),installed=completedCutoverMove(state,'install-candidate'),candidateRetired=completedCutoverMove(state,'retire-candidate'),originalRestored=completedCutoverMove(state,'restore-original');
 if(kind==='activation-intent'){
  settledMoves(state);if(state.activation||state.dormantClosing&&!state.dormantExited)throw new Error('恢复激活已登记或原只读服务尚未退出');
  const request=readCatalogRestoreActivationRequest(value),boot=request.role==='candidate'?state.candidateBoot:state.originalBoot;
  if(!boot?.proof||request.role==='candidate'&&Boolean(state.rollbackReason)||request.role==='original'&&!state.rollbackReason)throw new Error('恢复可写激活缺少对应角色的只读启动证明');
  readCatalogRestoreActivationRequest(request,boot.proof);state.activation={request,proof:null};return request;
 }
 if(kind==='activation-ready'){
  const activation=state.activation;if(!activation||activation.proof)throw new Error('恢复可写回执没有原意图或已重复');const boot=activation.request.role==='candidate'?state.candidateBoot:state.originalBoot;
  if(!boot?.proof)throw new Error('恢复可写回执没有原只读启动证明');const proof=readCatalogRestoreActivationProof(value,activation.request,boot.request,{currentBuild:false});
  if(proof.pid!==boot.proof.pid||proof.buildId!==boot.proof.buildId)throw new Error('恢复可写回执改变了原只读进程');activation.proof=proof;return proof;
 }
 if(kind==='pending-intent'){
  const activation=state.activation;if(!activation?.proof||state.pending||!context.originalSnapshotManifest)throw new Error('恢复待保存资料缺少可写准备或原快照');
  const intent=readRestorePendingIntent(value);if(intent.operationId!==transactionId||intent.activationId!==activation.request.activationId||intent.role!==activation.request.role||intent.originalManifestSha256!==lifecycleDigest(context.originalSnapshotManifest)||intent.candidateManifestSha256!==lifecycleDigest(context.candidateManifest)||JSON.stringify(intent.files)!==JSON.stringify(pendingFiles(context.originalSnapshotManifest,context.candidateManifest)))throw new Error('两侧待保存资料意图与原清单不同');
  state.pending={intent,archived:false,renderer:null,settled:null};return intent;
 }
 if(kind==='pending-archived'){
  const pending=state.pending,v=fields(value,['archiveSha256']);if(!pending||pending.archived||v.archiveSha256!==lifecycleDigest(pending.intent))throw new Error('两侧资料隔离回执与原意图不同');pending.archived=true;return {archiveSha256:lifecycleDigest(pending.intent)};
 }
 if(kind==='pending-renderer'){
  const pending=state.pending;if(!pending?.archived||pending.renderer)throw new Error('界面处理前未确认两侧原文隔离');const reply=readRestorePendingReply(value),intent=pending.intent;
  if(reply.operationId!==transactionId||reply.activationId!==intent.activationId||reply.challenge!==intent.challenge||reply.archiveSha256!==lifecycleDigest(intent)||reply.originalSha256!==intent.files.find(f=>f.name==='original-renderer.json')!.sha256||reply.error||reply.cleared!==(intent.role==='candidate')||reply.resultSha256!==(intent.role==='candidate'?lifecycleDigest([]):intent.originalValuesSha256))throw new Error('界面待保存资料处理回执与原挑战不同');pending.renderer=reply;return reply;
 }
 if(kind==='pending-settled'){
  const pending=state.pending;if(!pending?.renderer||pending.settled)throw new Error('Main历史处理前未确认界面资料结果');const proof=readRestorePendingSettled(value),intent=pending.intent,original=intent.files.find(f=>f.name==='original-history.json')!.sha256;
  if(proof.archiveSha256!==lifecycleDigest(intent)||proof.rendererReplySha256!==lifecycleDigest(pending.renderer)||proof.historyBeforeSha256!==original||proof.historyReset!==(intent.role==='candidate')||proof.historyAfterSha256!==(proof.historyReset?lifecycleDigest({version:1,entries:[]}):original))throw new Error('Main历史处理回执与原隔离资料不同');pending.settled=proof;return proof;
 }
 if(kind==='hydration-intent'){
  const activation=state.activation,pending=state.pending?.settled;if(!activation?.proof||!pending||state.hydration)throw new Error('恢复状态意图缺少原可写和待保存结果');const intent=readRestoreHydrationIntent(value),boot=activation.request.role==='candidate'?state.candidateBoot:state.originalBoot;
  readRestoreHydrationRequest(intent.request,activation.proof,pending,activation.request.token);if(!boot?.proof||intent.request.role!==activation.request.role)throw new Error('恢复状态意图角色或原进程不同');state.hydration={intent,ready:null};return intent;
 }
 if(kind==='hydration-ready'){
  const hydration=state.hydration,pending=state.pending?.settled,activation=state.activation?.proof;if(!hydration||hydration.ready||!pending||!activation)throw new Error('恢复状态就绪缺少原意图或已重复');const ready=readRestoreHydrationReady(value,hydration.intent.request,pending);
  if(ready.library.pid!==activation.pid||ready.library.buildId!==activation.buildId)throw new Error('恢复状态回执改变原进程或构建');hydration.ready=ready;return ready;
 }
 if(kind==='renderer-intent'){
  const ready=state.hydration?.ready,pending=state.pending?.renderer,activation=state.activation;if(!ready||!pending?.resultSha256||!activation?.proof||state.renderer)throw new Error('界面准备意图缺少原 Main 状态或已重复');const intent=readRestoreRendererIntent(value),request=intent.request;
  if(request.operationId!==transactionId||request.activationId!==activation.request.activationId||request.hydrationSha256!==lifecycleDigest(ready)||request.snapshotSha256!==ready.mainSha256||lifecycleDigest(request.snapshot)!==ready.mainSha256||request.pendingValuesSha256!==pending.resultSha256||ready.library.buildId!=='aural-main-'+request.appVersion)throw new Error('界面重载意图与原恢复状态或构建不同');state.renderer={intent,ready:null};return intent;
 }
 if(kind==='renderer-ready'){
  const renderer=state.renderer;if(!renderer||renderer.ready)throw new Error('界面回执没有原重载意图或已重复');const ready=readRestoreRendererReady(value,renderer.intent),reply=ready.reply,request=renderer.intent.request;
  if(!reply.prepared||reply.error||reply.operationId!==transactionId||reply.activationId!==request.activationId||reply.challenge!==request.challenge||reply.documentToken!==request.documentToken||reply.documentEpoch!==request.documentEpoch||reply.appVersion!==request.appVersion||reply.requestSha256!==lifecycleDigest(request)||reply.snapshotSha256!==request.snapshotSha256||reply.pendingValuesSha256!==request.pendingValuesSha256)throw new Error('新界面回执与原挑战或状态不同');renderer.ready=ready;return ready;
 }
 if(kind==='normal-intent'){
  const activation=state.activation,hydration=state.hydration?.ready,renderer=state.renderer?.ready;if(!activation?.proof||!hydration||!renderer||state.normal)throw new Error('普通服务准备意图缺少三方恢复证明或已重复');const request=readRestoreNormalRequest(value,activation.proof,hydration,renderer,activation.request.token);
  if(request.role!==activation.request.role)throw new Error('普通服务准备改变原恢复角色');state.normal={request,proof:null};return request;
 }
 if(kind==='normal-prepared'){
  const normal=state.normal,activation=state.activation?.proof,hydration=state.hydration?.ready;if(!normal||normal.proof||!activation||!hydration)throw new Error('普通服务准备回执缺少原意图或已重复');const proof=readRestoreNormalProof(value,normal.request,activation,hydration.mainSha256,false);normal.proof=proof;return proof;
 }
 if(kind==='decision-sealed'){
  const normal=state.normal?.proof,activation=state.activation,hydration=state.hydration?.ready,pending=state.pending?.settled,renderer=state.renderer?.ready;if(state.commit||!normal||!activation?.proof||!hydration||!pending||!renderer)throw new Error('恢复完成决策缺少三方准备或已重复');const seal=readRestoreCommitSeal(value);
  if(seal.operationId!==transactionId||seal.activationId!==activation.request.activationId||seal.role!==activation.request.role||seal.libraryIdentity!==normal.libraryIdentity||seal.normalSha256!==lifecycleDigest(normal)||seal.manifestSha256!==lifecycleDigest(normal.manifest)||seal.hydrationSha256!==lifecycleDigest(hydration)||seal.pendingSha256!==lifecycleDigest(pending)||seal.rendererSha256!==lifecycleDigest(renderer))throw new Error('恢复完成决策与原角色、目录或三方准备不同');state.commit={seal,request:null,proof:null};return seal;
 }
 if(kind==='service-ready-intent'){
  const commit=state.commit,normal=state.normal?.proof,activation=state.activation;if(!commit||commit.request||!normal||!activation||!context.commitSealRecordSha256)throw new Error('服务就绪意图缺少原持久决策');const request=readRestoreServiceReadyRequest(value,commit.seal,normal,activation.request.token,context.commitSealRecordSha256);commit.request=request;return request;
 }
 if(kind==='service-ready-held'){
  const commit=state.commit,normal=state.normal?.proof;if(!commit?.request||commit.proof||!normal)throw new Error('服务就绪回执缺少原意图或已重复');const proof=readRestoreServiceReadyProof(value,commit.request,normal,false);commit.proof=proof;return proof;
 }
 if(kind==='library-release-intent'){
  const commit=state.commit;if(!commit?.proof||state.libraryRelease||!state.activation||!context.serviceReadyRecordSha256)throw new Error('曲库释放缺少原持久就绪证明或已登记');const request=readRestoreLibraryReleaseRequest(value,commit.seal,commit.proof,state.activation.request.token,context.serviceReadyRecordSha256);state.libraryRelease={request,proof:null};return request;
 }
 if(kind==='library-released'){
  const release=state.libraryRelease,ready=state.commit?.proof;if(!release||release.proof||!ready)throw new Error('曲库释放回执缺少原意图或已重复');const proof=readRestoreLibraryReleaseProof(value,release.request,ready,false);release.proof=proof;return proof;
 }
 if(kind==='main-release-intent'){
  const library=state.libraryRelease?.proof,seal=state.commit?.seal;if(!library||!seal||state.mainRelease)throw new Error('主程序资源释放前曲库尚未确认释放或已登记');const intent=readRestoreMainReleaseIntent(value,library,seal);state.mainRelease={intent,proof:null};return intent;
 }
 if(kind==='main-resources-released'){
  const release=state.mainRelease;if(!release||release.proof)throw new Error('主程序资源释放回执缺少原意图或已重复');const proof=readRestoreMainReleaseProof(value,release.intent);release.proof=proof;return proof;
 }
 if(kind==='application-intent'){
  const main=state.mainRelease?.proof,renderer=state.renderer?.ready,seal=state.commit?.seal,hydration=state.hydration?.ready;if(!main||!renderer||!seal||!hydration||state.application)throw new Error('恢复应用加载意图缺少原资源释放或新文档证明');const request=readRestoreAppRequest(value),reply=renderer.reply;
  if(request.operationId!==transactionId||request.completionId!==seal.completionId||request.documentId!==reply.documentId||request.documentToken!==reply.documentToken||request.documentEpoch!==reply.documentEpoch||request.appVersion!==reply.appVersion||request.mainReleaseSha256!==lifecycleDigest(main)||request.rendererReadySha256!==lifecycleDigest(renderer)||request.queueSha256!==lifecycleDigest(restoreAppQueue(hydration.library.snapshot.queue))||request.pendingValuesSha256!==reply.pendingValuesSha256)throw new Error('恢复应用加载改变原文档、队列或处理资料');state.application={request,ready:null};return request;
 }
 if(kind==='application-ready'){
  const application=state.application,renderer=state.renderer;if(!application||application.ready||!renderer)throw new Error('恢复应用回执缺少原加载意图或已重复');const ready=readRestoreAppReady(value,application.request,lifecycleDigest(application.request),renderer.intent);application.ready=ready;return ready;
 }
 if(kind==='finalization-intent'){
  const application=state.application;if(!application?.ready||state.finalization)throw new Error('恢复最终意图缺少原应用证明或已重复');const request=readRestoreFinalRequest(value);
  bindRestoreFinalRequest(request,application.request,application.ready,lifecycleDigest(application.ready),lifecycleDigest(application.ready.reply));state.finalization={request,proof:null};return request;
 }
 if(kind==='final-resources-held'){
  const final=state.finalization,history=state.pending?.settled;if(!final||final.proof||!history)throw new Error('恢复最终资源证明缺少原意图或历史结果');const proof=readRestoreFinalProof(value,final.request,lifecycleDigest(final.request),history.historyAfterSha256);final.proof=proof;return proof;
 }
 if(kind==='completed'){
  const seal=state.commit?.seal,ready=state.commit?.proof,final=state.finalization?.proof;if(!seal||!ready||!final||!context.finalRecordSha256)throw new Error('恢复完成证书缺少原最终资源实际记录');const completed=readRestoreCompleted(value,context.intent,seal,ready,final,context.finalRecordSha256);state.completed=completed;return completed;
 }
 if(state.activation)throw new Error('可写激活已开始，不能按旧只读清单移动或回滚，须恢复核对');
 if(kind==='move-intent'){
  settledMoves(state);const request=readDirectoryMoveRequest(value),expected=cutoverMoveRequest(context,request.operationId,request.action);
  if(JSON.stringify(request)!==JSON.stringify(expected)||state.moves.some(move=>move.request.operationId===request.operationId||move.request.action===request.action)||state.originalBoot)throw new Error('目录移动原身份、阶段或操作已重复');
  if(!state.rollbackReason){if(state.candidateBoot||!(request.action==='retire-original'&&!state.moves.length||request.action==='install-candidate'&&retired&&!installed))throw new Error('恢复目录正向切换顺序不同');}
  else{
   if(state.candidateBoot?.proof&&!state.dormantExited)throw new Error('候选只读服务尚未实际退出，不能回滚移动');
   if(!(request.action==='retire-candidate'&&installed&&!candidateRetired&&!originalRestored||request.action==='restore-original'&&retired&&!originalRestored&&(!installed||candidateRetired)))throw new Error('恢复目录回滚顺序不同');
  }
  state.moves.push({request,completion:null});return request;
 }
 if(kind==='move-reconciled'){
  if(state.activation)throw new Error('已经进入可写准备的曲库不能按旧移动清单补记');const v=fields(value,['move','audit']),audit=readMoveReconciliationAudit(v.audit),move=readRestoreMoveCompletion(v.move),pending=state.moves.at(-1);
  if(!pending||audit.review.transactionId!==transactionId||audit.review.operationId!==move.operationId||audit.review.action!==pending.request.action||audit.review.targetIdentity!==pending.request.sourceIdentity||audit.review.transactionSha256!==context.previousRecordSha256||audit.review.startupSha256!==audit.startupSha256||lifecycleDigest(audit.review)!==audit.reviewSha256||audit.review.requestSha256!==move.requestSha256||audit.review.exitSha256!==move.exitSha256||audit.review.filesSha256!==move.filesSha256)throw new Error('补记审核与原事务、切换、目录或已保存决定不同');
  const expected=cutoverMoveManifest(context,pending.request.action).files.filter(file=>file.path.startsWith('library/'));if(audit.review.files!==expected.length||audit.review.bytes!==expected.reduce((n,file)=>n+file.bytes,0))throw new Error('补记审核完整内容数量不同');
  readRestoreCutoverRecord('move-completed',move,context,state);return {move,audit};
 }
 if(kind==='move-completed'){
  const valueRead=readRestoreMoveCompletion(value),pending=state.moves.at(-1);if(!pending||pending.completion||pending.request.operationId!==valueRead.operationId||valueRead.filesSha256!==libraryManifestDigest(cutoverMoveManifest(context,pending.request.action)))throw new Error('目录移动完成与原意图或完整内容不同');pending.completion=valueRead;return valueRead;
 }
 if(kind==='rollback-intent'){
  settledMoves(state);const v=fields(value,['reason']);if(state.rollbackReason||state.originalBoot)throw new Error('整库回滚意图已登记');const read={reason:reason(v.reason)};state.rollbackReason=read.reason;return read;
 }
 if(kind==='boot-intent'){
  settledMoves(state);const v=fields(value,['role','request']),bootRole=role(v.role),request=readCatalogRestoreBootRequest(v.request),manifest=bootRole==='candidate'?context.candidateManifest:context.closed.manifest,identity=bootRole==='candidate'?context.candidate.libraryIdentity:context.intent.liveIdentity;
  if(request.operationId!==transactionId||request.libraryIdentity!==identity||JSON.stringify(request.manifest)!==JSON.stringify(manifest))throw new Error('恢复启动意图与原目录或完整清单不符');
  if(bootRole==='candidate'){if(state.rollbackReason||!installed||candidateRetired||state.candidateBoot)throw new Error('候选曲库启动顺序不同');state.candidateBoot={request,proof:null,failure:null};}
  else{if(!state.rollbackReason||state.originalBoot||retired&&!originalRestored||installed&&!candidateRetired||state.candidateBoot?.proof&&!state.dormantExited)throw new Error('原曲库回滚启动顺序不同');state.originalBoot={request,proof:null,failure:null};}
  return {role:bootRole,request};
 }
 if(kind==='boot-ready'||kind==='boot-failed'){
  const v=fields(value,kind==='boot-ready'?['role','proof']:['role','requestSha256','reason']),bootRole=role(v.role),boot=bootRole==='candidate'?state.candidateBoot:state.originalBoot;
  if(!boot||boot.proof||boot.failure||bootRole==='candidate'&&state.rollbackReason)throw new Error('恢复启动回执重复或原启动意图不存在');
  if(kind==='boot-ready'){const proof=readCatalogRestoreBootProof(v.proof,boot.request,{currentBuild:false});boot.proof=proof;return {role:bootRole,proof};}
  const requestSha256=restoreTransactionDigest(v.requestSha256);if(requestSha256!==lifecycleDigest(boot.request))throw new Error('恢复启动失败不属于原请求');const readReason=reason(v.reason);boot.failure=readReason;return {role:bootRole,requestSha256,reason:readReason};
 }
 if(kind==='dormant-closing'){
  const proof=state.candidateBoot?.proof;if(!state.rollbackReason||!proof||state.dormantClosing||state.originalBoot)throw new Error('候选服务回滚关闭顺序不同');const request=readCatalogServiceStopRequest(value);
  if(request.operationId!==transactionId||request.mode!=='dormant'||request.instanceId!==proof.instanceId||request.token!==proof.token||request.libraryIdentity!==proof.libraryIdentity||JSON.stringify(request.manifest)!==JSON.stringify(context.candidateManifest))throw new Error('回滚关闭并非原候选只读实例');state.dormantClosing=request;return request;
 }
 if(kind==='dormant-closed'){
  if(!state.dormantClosing||state.dormantClosed||state.dormantExited)throw new Error('候选数据库关闭回执顺序不同');const receipt=readCatalogServiceStopReceipt(value,state.dormantClosing);state.dormantClosed=receipt;return receipt;
 }
 if(kind!=='dormant-exited'||!state.dormantClosing||!state.dormantClosed||state.dormantExited)throw new Error('候选服务实际退出证明顺序不同');const proof=readCatalogServiceExitProof(value,state.dormantClosing);if(JSON.stringify(proof.receipt)!==JSON.stringify(state.dormantClosed))throw new Error('候选实际退出证明与持久关闭回执不同');state.dormantExited=proof;return proof;
}
