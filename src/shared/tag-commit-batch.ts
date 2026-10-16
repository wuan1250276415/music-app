import {tagWriteKeys,tagWriteUuid,tagWriteHash} from './tag-write.js';
import type {TagStageBatchStatus,TagStageBatchCommand} from './tag-stage-batch.js';
import type {TagCommitStart} from './tag-commit-journal.js';
import type {TagWriteCancelRequest} from './tag-write-ui.js';
import type {TagCommitReprobeRequest} from './tag-commit-reprobe.js';
export type TagCommitBatchItemStatus='pending'|'active'|'completed'|'failed'|'blocked'|'skipped'|'cancelled';
export interface TagCommitBatch {id:string;title:string;revision:number;status:TagStageBatchStatus;total:number;counts:Record<TagCommitBatchItemStatus,number>;activeOrdinal:number|null;message:string;createdAt:number;updatedAt:number}
export interface TagCommitBatchCreate {commandId:string;title:string;jobIds:string[];certificateId:string;confirmed:true}
export type TagCommitBatchCommand=TagStageBatchCommand;
export interface TagCommitBatchItem {ordinal:number;jobId:string;itemId:string;fileId:string;title:string;path:string;status:TagCommitBatchItemStatus;message:string;jobState:string}
export interface TagCommitBatchItems {batch:TagCommitBatch;items:TagCommitBatchItem[];nextCursor:number|null}
export interface TagCommitBatchPage {items:TagCommitBatch[];nextCursor:number|null}
export interface TagCommitBatchReply {status:'saved'|'conflict'|'rejected';batch:TagCommitBatch;message:string}
export type TagCommitBatchStep={phase:'commit';request:TagCommitStart}|{phase:'inspect';request:TagWriteCancelRequest}|{phase:'reprobe';request:TagCommitReprobeRequest};
export type TagCommitBatchClaim={batchId:string;owner:string;epoch:number;ordinal:number}&TagCommitBatchStep;
export interface TagCommitBatchDrive {claim:TagCommitBatchClaim|null;waiting:boolean}
export function readTagCommitBatchCreate(v:unknown):TagCommitBatchCreate {
 if(!tagWriteKeys(v,['commandId','title','jobIds','certificateId','confirmed'])||!tagWriteUuid(v.commandId)||!tagWriteHash(v.certificateId)||v.confirmed!==true||typeof v.title!=='string'||!v.title.trim()||v.title.length>120||/[\x00-\x1f\x7f]/.test(v.title)||!Array.isArray(v.jobIds)||v.jobIds.length<1||v.jobIds.length>100||!v.jobIds.every(tagWriteUuid))throw new Error('请选择1–100个已暂存任务，并确认逐首写入、核对和更新曲库');
 const jobIds=v.jobIds.map(id=>id.toLowerCase());if(new Set(jobIds).size!==jobIds.length)throw new Error('写入批次不能重复选择任务');return {commandId:v.commandId.toLowerCase(),title:v.title.trim(),jobIds,certificateId:v.certificateId,confirmed:true};
}
