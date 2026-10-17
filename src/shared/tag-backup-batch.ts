import {tagWriteKeys,tagWriteUuid} from './tag-write.js';

export type TagBackupBatchState='ready'|'running'|'pausing'|'paused'|'cancelling'|'cancelled'|'completed'|'attention'|'interrupted';
export type TagBackupBatchItemState='pending'|'inspecting'|'removing'|'removed'|'blocked'|'skipped';
export interface TagBackupSchedule {revision:number;enabled:boolean;effective:boolean;reason:string}
export interface TagBackupScheduleRequest {commandId:string;baseRevision:number;enabled:boolean}
export interface TagBackupBasis {jobId:string;jobRevision:number;executionId:string;backupArtifactId:string;stagingJournalSha256:string;bytes:string;title:string}
export interface TagBackupBatchItem {ordinal:number;basis:TagBackupBasis;state:TagBackupBatchItemState;inspectId:string;removeId:string;message:string}
export interface TagBackupBatch {
 id:string;revision:number;state:TagBackupBatchState;source:'manual'|'automatic';policyRevision:number;total:number;bytes:string;
 counts:Record<TagBackupBatchItemState,number>;activeOrdinal:number|null;message:string;createdAt:number;updatedAt:number;
}
export interface TagBackupBatchPage {items:TagBackupBatch[];nextCursor:number|null}
export interface TagBackupBatchItems {batch:TagBackupBatch;items:TagBackupBatchItem[];nextOffset:number|null}
export type TagBackupBatchCommand={commandId:string;batchId:string;baseRevision:number}&({action:'start';confirmed:true}|{action:'pause'|'cancel'}|{action:'skip';ordinal:number});
export const backupInteger=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<Number.MAX_SAFE_INTEGER-1;
export function readTagBackupSchedule(v:unknown):TagBackupScheduleRequest {
 if(!tagWriteKeys(v,['commandId','baseRevision','enabled'])||!tagWriteUuid(v.commandId)||!backupInteger(v.baseRevision)||typeof v.enabled!=='boolean')throw new Error('自动备份清理设置无效');
 return {commandId:v.commandId.toLowerCase(),baseRevision:v.baseRevision,enabled:v.enabled};
}
export function readTagBackupBatchCommand(v:unknown):TagBackupBatchCommand {
 const action=(v as {action?:unknown}|null)?.action,extra=action==='start'?['confirmed']:action==='skip'?['ordinal']:[];
 if(!tagWriteKeys(v,['commandId','batchId','baseRevision','action',...extra])||!tagWriteUuid(v.commandId)||!tagWriteUuid(v.batchId)||!backupInteger(v.baseRevision)||!['start','pause','cancel','skip'].includes(String(action))||action==='start'&&v.confirmed!==true||action==='skip'&&(!backupInteger(v.ordinal)||Number(v.ordinal)>99))throw new Error('备份清理批次操作无效');
 return {...v,commandId:v.commandId.toLowerCase(),batchId:v.batchId.toLowerCase()} as TagBackupBatchCommand;
}
export function readTagBackupBasis(v:unknown):TagBackupBasis {
 if(!tagWriteKeys(v,['jobId','jobRevision','executionId','backupArtifactId','stagingJournalSha256','bytes','title'])||![v.jobId,v.executionId,v.backupArtifactId].every(tagWriteUuid)||!backupInteger(v.jobRevision)||typeof v.stagingJournalSha256!=='string'||!/^[a-f0-9]{64}$/.test(v.stagingJournalSha256)||typeof v.bytes!=='string'||!/^[1-9][0-9]{0,15}$/.test(v.bytes)||typeof v.title!=='string'||v.title.length>512)throw new Error('备份批次固定范围无效');
 return v as unknown as TagBackupBasis;
}
