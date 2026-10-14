import {readTagFieldChanges,tagWriteKeys,tagWriteUuid,tagWriteHash,type TagFieldChange,type TagWriteField,type FlacTagPreview} from './tag-write.js';

export const TAG_FIELD_LABELS:Record<TagWriteField,string>={title:'歌曲名称',artists:'歌手',album:'专辑',albumArtists:'专辑歌手',genres:'风格',date:'发行日期',trackNumber:'曲序',discNumber:'碟序',comment:'备注',copyright:'版权声明',isrc:'ISRC'};
export interface TagWriteContext {
 itemId:string;fileId:string;title:string;fingerprint:string;contentRevision:number;eligible:boolean;reason:string;
 fields:Array<{field:TagWriteField;values:string[];libraryAllowed:boolean;reason:string;rightsFingerprint:string}>;
 executionReady:false;
}
export interface TagWriteDraft {requestId:string;itemId:string;fingerprint:string;fields:Array<TagFieldChange&{origin:'manual'|'library'}>;manualConfirmed:boolean}
export interface TagWritePreview {token:string;expiresAt:number;context:TagWriteContext;draft:TagWriteDraft;preview:FlacTagPreview}
export interface TagWritePrepareRequest {commandId:string;token:string}
export interface TagWriteCancelRequest {commandId:string;jobId:string;baseRevision:number}
export type TagWriteStageRequest=TagWriteCancelRequest;
export type TagWriteJobState='prepared'|'running'|'cancelled'|'failed'|'recovery_required'|'completed';
export interface TagWriteJob {id:string;itemId:string;fileId:string;title:string;state:TagWriteJobState;revision:number;createdAt:string;updatedAt:string;preview:FlacTagPreview;reason:string;staging?:{executionId:string;state:'starting'|'planned'|'validated'|'backup_ready'|'temp_written'|'staged'|'recovery_required';phase:string;bytes:string;total:string};recovery?:import('./tag-recovery.js').TagRecoveryView;recoveryAction?:import('./tag-recovery.js').TagRecoveryActionView;nativeRestoreReprobe?:import('./tag-restore-reprobe.js').TagRestoreReprobeView;nativeRestoreRecovery?:import('./tag-restore-recovery.js').TagRestoreRecoveryView;nativeRestore?:import('./tag-restore-journal.js').TagRestoreView;nativeCommit?:import('./tag-commit-journal.js').TagCommitView;nativeRecovery?:import('./tag-commit-recovery.js').TagCommitRecoveryView;nativeReprobe?:import('./tag-commit-reprobe.js').TagCommitReprobeView}
export interface TagWriteJobPage {jobs:TagWriteJob[];nextCursor:string|null;executionReady:false}

export function readTagWriteDraft(value:unknown):TagWriteDraft {
 if(!tagWriteKeys(value,['requestId','itemId','fingerprint','fields','manualConfirmed'])||!tagWriteUuid(value.requestId)||!tagWriteUuid(value.itemId)||!tagWriteHash(value.fingerprint)||typeof value.manualConfirmed!=='boolean'||!Array.isArray(value.fields))throw new Error('标签预览请求无效');
 for(const field of value.fields)if(!tagWriteKeys(field,['field','values','origin'])||field.origin!=='manual'&&field.origin!=='library')throw new Error('标签字段来源无效');
 const rawFields=value.fields;
 const changes=readTagFieldChanges(rawFields.map(f=>({field:f.field,values:f.values})));
 const fields=changes.map((change,i)=>({...change,origin:rawFields[i].origin as 'manual'|'library'}));
 if(fields.some(f=>f.origin==='manual')&&!value.manualConfirmed)throw new Error('请确认手工输入字段可用于本地文件标签');
 return {requestId:value.requestId.toLowerCase(),itemId:value.itemId.toLowerCase(),fingerprint:value.fingerprint,fields,manualConfirmed:value.manualConfirmed};
}
export function readTagWritePrepareRequest(value:unknown):TagWritePrepareRequest {
 if(!tagWriteKeys(value,['commandId','token'])||!tagWriteUuid(value.commandId)||!tagWriteUuid(value.token))throw new Error('保存标签任务请求无效');
 return {commandId:value.commandId.toLowerCase(),token:value.token.toLowerCase()};
}
export function readTagWriteCancelRequest(value:unknown):TagWriteCancelRequest {
 if(!tagWriteKeys(value,['commandId','jobId','baseRevision'])||!tagWriteUuid(value.commandId)||!tagWriteUuid(value.jobId)||!Number.isSafeInteger(value.baseRevision)||Number(value.baseRevision)<0)throw new Error('取消标签任务请求无效');
 return {commandId:value.commandId.toLowerCase(),jobId:value.jobId.toLowerCase(),baseRevision:Number(value.baseRevision)};
}
