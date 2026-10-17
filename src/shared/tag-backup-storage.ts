import {tagWriteKeys,tagWriteUuid} from './tag-write.js';

export const TAG_BACKUP_DEFAULT_DAYS=30;
export const TAG_BACKUP_DEFAULT_BYTES='10737418240';
export interface TagBackupPolicy {revision:number;keepDays:number;maxBytes:string}
export interface TagBackupPolicyRequest {commandId:string;baseRevision:number;keepDays:number;maxBytes:string}
export interface TagBackupPolicyReply {status:'saved'|'conflict';policy:TagBackupPolicy;message:string}
export type TagBackupFilter='all'|'candidates'|'protected'|'unmanaged';
export type TagBackupDisposition='candidate'|'protected'|'unmanaged'|'unreadable';
export interface TagBackupEntry {
 name:string;jobId:string|null;title:string;bytes:string|null;modifiedAt:number|null;
 disposition:TagBackupDisposition;reason:string;
}
export interface TagBackupStorageRequest {snapshotId?:string;offset?:number;filter?:TagBackupFilter}
export interface TagBackupStoragePage {
 snapshotId:string;observedAt:number;policy:TagBackupPolicy;complete:boolean;message:string;
 summary:{entries:number;knownBackups:number;candidates:number;protected:number;unmanaged:number;unreadable:number;knownBytes:string;candidateBytes:string;otherFileBytes:string;overBudgetBytes:string;availableBytes:string|null};
 items:TagBackupEntry[];nextOffset:number|null;filter:TagBackupFilter;
 // Inventory is an observation, never a file-deletion grant.
 cleanupReady:boolean;
}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER;
export function readTagBackupPolicy(v:unknown):TagBackupPolicy {
 if(!tagWriteKeys(v,['revision','keepDays','maxBytes'])||!safe(v.revision)||!Number.isInteger(v.keepDays)||Number(v.keepDays)<1||Number(v.keepDays)>36500||typeof v.maxBytes!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(v.maxBytes)||BigInt(v.maxBytes)>1125899906842624n)throw new Error('备份保留设置无效');
 return {revision:v.revision,keepDays:Number(v.keepDays),maxBytes:v.maxBytes};
}
export function readTagBackupPolicyRequest(v:unknown):TagBackupPolicyRequest {
 if(!tagWriteKeys(v,['commandId','baseRevision','keepDays','maxBytes'])||!tagWriteUuid(v.commandId))throw new Error('备份保留操作无效');
 const p=readTagBackupPolicy({revision:v.baseRevision,keepDays:v.keepDays,maxBytes:v.maxBytes});
 return {commandId:v.commandId.toLowerCase(),baseRevision:p.revision,keepDays:p.keepDays,maxBytes:p.maxBytes};
}
export function readTagBackupStorageRequest(v:unknown):Required<Pick<TagBackupStorageRequest,'offset'|'filter'>>&Pick<TagBackupStorageRequest,'snapshotId'> {
 if(v===undefined)v={};
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['snapshotId','offset','filter'].includes(k)))throw new Error('备份空间查询无效');
 const q=v as TagBackupStorageRequest;
 if(q.snapshotId!==undefined&&!tagWriteUuid(q.snapshotId)||q.offset!==undefined&&(!safe(q.offset)||q.offset>65536)||q.filter!==undefined&&!['all','candidates','protected','unmanaged'].includes(q.filter)||!q.snapshotId&&q.offset)throw new Error('备份空间分页无效');
 return {snapshotId:q.snapshotId?.toLowerCase(),offset:q.offset??0,filter:q.filter??'all'};
}
