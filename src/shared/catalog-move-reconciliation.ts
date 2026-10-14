import {backupUuid} from './catalog-backup.js';
import {readRestoreIdentity} from './catalog-restore.js';
import {DIRECTORY_MOVE_ACTIONS,type DirectoryMoveAction} from './catalog-directory-move.js';
import {restoreTransactionFields as fields,restoreTransactionDigest as digest,restoreTransactionDate as date,restoreTransactionCount as count} from './catalog-restore-transaction.js';

export const MOVE_RECONCILIATION_POLICY='confirm-recorded-exit-without-directory-move' as const;
export type RecordedMoveReview={version:1;transactionId:string;operationId:string;action:DirectoryMoveAction;transactionSha256:string;startupSha256:string;requestSha256:string;exitSha256:string;filesSha256:string;targetIdentity:string;files:number;bytes:number;inspectedAt:string;policy:typeof MOVE_RECONCILIATION_POLICY};
export type RecordedMoveConfirmation={version:1;transactionId:string;operationId:string;requestId:string;reviewSha256:string;acceptRecordedMove:true};
export type MoveReconciliationAudit={version:1;requestId:string;instanceId:string;mainPid:number;mainBuildId:string;review:RecordedMoveReview;reviewSha256:string;startupSha256:string;acceptedAt:string;policy:typeof MOVE_RECONCILIATION_POLICY};
export function readRecordedMoveReview(value:unknown):RecordedMoveReview{
 const v=fields(value,['version','transactionId','operationId','action','transactionSha256','startupSha256','requestSha256','exitSha256','filesSha256','targetIdentity','files','bytes','inspectedAt','policy']);
 if(v.version!==1||v.policy!==MOVE_RECONCILIATION_POLICY||typeof v.action!=='string'||!DIRECTORY_MOVE_ACTIONS.includes(v.action as DirectoryMoveAction))throw new Error('切换回执审核范围无效');
 return {version:1,transactionId:backupUuid(v.transactionId),operationId:backupUuid(v.operationId),action:v.action as DirectoryMoveAction,transactionSha256:digest(v.transactionSha256),startupSha256:digest(v.startupSha256),requestSha256:digest(v.requestSha256),exitSha256:digest(v.exitSha256),filesSha256:digest(v.filesSha256),targetIdentity:readRestoreIdentity(v.targetIdentity),files:count(v.files,8192),bytes:count(v.bytes),inspectedAt:date(v.inspectedAt),policy:MOVE_RECONCILIATION_POLICY};
}
export function readRecordedMoveConfirmation(value:unknown):RecordedMoveConfirmation{
 const v=fields(value,['version','transactionId','operationId','requestId','reviewSha256','acceptRecordedMove']);if(v.version!==1||v.acceptRecordedMove!==true)throw new Error('切换回执确认无效');
 return {version:1,transactionId:backupUuid(v.transactionId),operationId:backupUuid(v.operationId),requestId:backupUuid(v.requestId),reviewSha256:digest(v.reviewSha256),acceptRecordedMove:true};
}
export function readMoveReconciliationAudit(value:unknown):MoveReconciliationAudit{
 const v=fields(value,['version','requestId','instanceId','mainPid','mainBuildId','review','reviewSha256','startupSha256','acceptedAt','policy']);
 if(v.version!==1||v.policy!==MOVE_RECONCILIATION_POLICY||typeof v.mainBuildId!=='string'||v.mainBuildId.length>64||!/^aural-main-\d+\.\d+\.\d+$/.test(v.mainBuildId)||count(v.mainPid,2147483647)<1)throw new Error('切换回执处理归属无效');
 return {version:1,requestId:backupUuid(v.requestId),instanceId:backupUuid(v.instanceId),mainPid:v.mainPid as number,mainBuildId:v.mainBuildId,review:readRecordedMoveReview(v.review),reviewSha256:digest(v.reviewSha256),startupSha256:digest(v.startupSha256),acceptedAt:date(v.acceptedAt),policy:MOVE_RECONCILIATION_POLICY};
}
// Rechecking content changes inspectedAt, so compare every other bound value.
export function recordedMoveReviewBasis(value:RecordedMoveReview):Omit<RecordedMoveReview,'inspectedAt'>{const {inspectedAt,...basis}=readRecordedMoveReview(value);return basis;}
