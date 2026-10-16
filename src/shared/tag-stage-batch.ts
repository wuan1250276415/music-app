import {tagWriteKeys,tagWriteUuid} from './tag-write.js';
import type {TagWriteCancelRequest} from './tag-write-ui.js';
export type TagStageBatchStatus='ready'|'queued'|'running'|'pausing'|'paused'|'cancelling'|'cancelled'|'completed'|'attention'|'interrupted';
export type TagStageBatchItemStatus='pending'|'active'|'staged'|'failed'|'blocked'|'skipped'|'cancelled';
export interface TagStageBatch {id:string;title:string;revision:number;status:TagStageBatchStatus;total:number;counts:Record<TagStageBatchItemStatus,number>;activeOrdinal:number|null;message:string;createdAt:number;updatedAt:number}
export interface TagStageBatchPage {items:TagStageBatch[];nextCursor:number|null}
export type TagStageBatchCommandReply={status:'saved'|'conflict'|'rejected';batch:TagStageBatch;message:string};
export interface TagStageBatchItem {ordinal:number;jobId:string;itemId:string;fileId:string;title:string;path:string;status:TagStageBatchItemStatus;attempts:number;message:string;jobState:string;stageState:string|null}
export interface TagStageBatchItems {batch:TagStageBatch;items:TagStageBatchItem[];nextCursor:number|null}
export interface TagStageBatchCreate {commandId:string;title:string;jobIds:string[];confirmed:true}
export type TagStageBatchCommand={commandId:string;batchId:string;baseRevision:number}&({action:'start'|'pause'|'cancel'}|{action:'retry'|'skip';ordinal:number});
export interface TagStageBatchClaim {batchId:string;owner:string;epoch:number;ordinal:number;request:TagWriteCancelRequest}
export interface TagStageBatchDrive {claim:TagStageBatchClaim|null;waiting:boolean}
const integer=(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER-1):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
export function readTagStageBatchCreate(value:unknown):TagStageBatchCreate {
 if(!tagWriteKeys(value,['commandId','title','jobIds','confirmed'])||!tagWriteUuid(value.commandId)||typeof value.title!=='string'||!value.title.trim()||value.title.length>120||/[\x00-\x1f\x7f]/.test(value.title)||value.confirmed!==true||!Array.isArray(value.jobIds)||value.jobIds.length<1||value.jobIds.length>100||!value.jobIds.every(tagWriteUuid))throw new Error('请选择1–100个已审核标签任务并确认备份批次');
 const jobIds=value.jobIds.map(id=>id.toLowerCase());if(new Set(jobIds).size!==jobIds.length)throw new Error('同一标签任务不能重复加入批次');return {commandId:value.commandId.toLowerCase(),title:value.title.trim(),jobIds,confirmed:true};
}
export function readTagStageBatchCommand(value:unknown):TagStageBatchCommand {
 const action=(value as {action?:unknown}|null)?.action,item=action==='retry'||action==='skip';
 if(!tagWriteKeys(value,['commandId','batchId','baseRevision','action',...(item?['ordinal']:[])])||!tagWriteUuid(value.commandId)||!tagWriteUuid(value.batchId)||!integer(value.baseRevision)||!['start','pause','cancel','retry','skip'].includes(String(action))||item&&!integer(value.ordinal,0,99))throw new Error('标签批次操作无效');
 return {commandId:value.commandId.toLowerCase(),batchId:value.batchId.toLowerCase(),baseRevision:value.baseRevision,action,...(item?{ordinal:value.ordinal}:{})} as TagStageBatchCommand;
}
export function readTagStageBatchClaim(value:unknown):TagStageBatchClaim {
 if(!tagWriteKeys(value,['batchId','owner','epoch','ordinal','request'])||![value.batchId,value.owner].every(tagWriteUuid)||!integer(value.epoch,1)||!integer(value.ordinal,0,99)||!tagWriteKeys(value.request,['commandId','jobId','baseRevision'])||![value.request.commandId,value.request.jobId].every(tagWriteUuid)||!integer(value.request.baseRevision))throw new Error('后台标签批次的处理身份无效');return structuredClone(value) as unknown as TagStageBatchClaim;
}
