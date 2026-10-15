import {readBatchReviewItems} from './metadata-batch-review';
import type {LibraryItem} from './contracts';
export type MetadataWorkflowStatus='ready'|'paused'|'completed'|'cancelled'|'interrupted';
export type MetadataWorkflowRowStatus='pending'|'reviewing'|'planned'|'skipped'|'failed';
export interface MetadataWorkflow {id:string;title:string;createdAt:number;updatedAt:number;revision:number;status:MetadataWorkflowStatus;total:number;counts:Partial<Record<MetadataWorkflowRowStatus,number>>;claimExpiresAt:number|null}
export interface MetadataWorkflowClaim {jobId:string;claimToken:string;expiresAt:number;items:LibraryItem[]}
export interface MetadataWorkflowResult {job:MetadataWorkflow;claim:MetadataWorkflowClaim|null;replayed?:boolean}
export type MetadataWorkflowCommand={commandId:string;action:'start';title:string}|{commandId:string;action:'pause'|'resume'|'cancel'|'retry'|'claim';jobId:string;revision:number}|{commandId:string;action:'release'|'skip';jobId:string;revision:number;claimToken:string};
export interface MetadataWorkflowOrigin {jobId:string;claimToken:string}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function workflowId(v:unknown):string{if(typeof v!=='string'||!uuid.test(v))throw new Error('无效元数据任务身份');return v;}
export function workflowOrigin(v:unknown):MetadataWorkflowOrigin{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==2)throw new Error('无效任务审核页来源');const r=v as Record<string,unknown>;return {jobId:workflowId(r.jobId),claimToken:workflowId(r.claimToken)};}
export function readMetadataWorkflowCommand(v:unknown):MetadataWorkflowCommand{
 if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('无效元数据任务操作');const r=v as Record<string,unknown>,commandId=workflowId(r.commandId);
 if(r.action==='start'){if(Object.keys(r).some(k=>!['commandId','action','title'].includes(k))||typeof r.title!=='string'||!r.title.trim()||r.title.length>160||/[\u0000-\u001f\u007f]/.test(r.title))throw new Error('任务名称无效');return {commandId,action:'start',title:r.title.trim()};}
 if(!['pause','resume','cancel','retry','claim','release','skip'].includes(String(r.action))||!Number.isSafeInteger(r.revision)||Number(r.revision)<0||Object.keys(r).some(k=>!['commandId','action','jobId','revision',...(['release','skip'].includes(String(r.action))?['claimToken']:[])].includes(k)))throw new Error('任务操作或修订无效');return {commandId,action:r.action,jobId:workflowId(r.jobId),revision:r.revision,...(['release','skip'].includes(String(r.action))?{claimToken:workflowId(r.claimToken)}:{})} as MetadataWorkflowCommand;
}

export function readWorkflowReview(v:unknown):{itemIds:string[];workflow:MetadataWorkflowOrigin}{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==2)throw new Error('无效任务预览范围');const r=v as Record<string,unknown>;return {itemIds:readBatchReviewItems(r.itemIds),workflow:workflowOrigin(r.workflow)};}
