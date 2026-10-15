import type {MetadataWorkflowClaim} from './metadata-workflow';
import type {MetadataBatchReviewLease} from './metadata-batch-review';
import {readBatchReviewItems} from './metadata-batch-review';
import {workflowId} from './metadata-workflow';
export type RecognitionState='queued'|'running'|'stopping'|'review'|'paused'|'interrupted'|'failed'|'done'|'cancelled';
export type RecognitionPhase='unprocessed'|'decoding'|'lookup'|'ready'|'empty'|'failed'|'interrupted'|'handled';
export const RECOGNITION_CODES=['none','paused','cancelled','preview-lost','source-changed','source-unavailable','source-disabled','auth-required','rate-limited','timeout','decode-failed','lookup-failed','no-match','scope-unavailable','capacity','internal'] as const;
export type RecognitionCode=typeof RECOGNITION_CODES[number];
export const recognitionCodeText:Record<RecognitionCode,string>={none:'',paused:'用户暂停',cancelled:'用户取消', 'preview-lost':'临时关联已过期或丢失，需要重新识别','source-changed':'曲目或音频来源已变化','source-unavailable':'音频来源离线、不可读或已移除','source-disabled':'识别数据源已暂停','auth-required':'需要有效的AcoustID应用访问密钥','rate-limited':'数据源限流，请稍后继续',timeout:'读取或查询超过期限','decode-failed':'无法生成当前音频片段的指纹','lookup-failed':'关联服务查询失败','no-match':'没有返回录音关联','scope-unavailable':'审核页已被关闭或替代',capacity:'预览容量不足，请先处理已有审核页',internal:'后台识别失败，请重新读取任务'};
export interface MetadataRecognition {mode:'page'|'library';retrying:boolean;progress:{total:number;visited:number;retained:number;failed:number;retryRemaining:number};jobId:string;revision:number;generation:number;state:RecognitionState;total:number;counts:Partial<Record<RecognitionPhase,number>>;code:RecognitionCode;updatedAt:number}
export type MetadataRecognitionCommand={commandId:string;jobId:string;revision:number;action:'start'|'start-library'|'pause'|'resume'|'cancel'|'retry-failed';itemIds?:string[]};
export interface MetadataRecognitionOpen {claim:MetadataWorkflowClaim;lease:MetadataBatchReviewLease;preparedItemIds:string[];errors:Array<{itemId:string;code:RecognitionCode}>}
export function readRecognitionCommand(v:unknown):MetadataRecognitionCommand{
 if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('无效后台识别命令');const r=v as Record<string,unknown>,selected=r.action==='retry-failed'&&Object.hasOwn(r,'itemIds');
 if(Object.keys(r).length!==(selected?5:4)||Object.keys(r).some(k=>!['commandId','jobId','revision','action',...(selected?['itemIds']:[])].includes(k))||!Number.isSafeInteger(r.revision)||Number(r.revision)<0||!['start','start-library','pause','resume','cancel','retry-failed'].includes(String(r.action)))throw new Error('后台识别修订或操作无效');
 return {commandId:workflowId(r.commandId),jobId:workflowId(r.jobId),revision:Number(r.revision),action:r.action as MetadataRecognitionCommand['action'],...(selected?{itemIds:readBatchReviewItems(r.itemIds).sort()}: {})};
}
export interface RecognitionIssueRequest {jobId:string;after:number;scope:'failed'|'all'}
export interface RecognitionIssue {itemId:string;ordinal:number;phase:RecognitionPhase;attempts:number;code:RecognitionCode;retryPending:boolean;retryable:boolean;title:string;path:string|null}
export interface RecognitionIssuePage {jobId:string;scope:'failed'|'all';items:RecognitionIssue[];nextCursor:number|null}
export function readRecognitionIssueRequest(v:unknown):RecognitionIssueRequest {
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==3||Object.keys(v).some(key=>!['jobId','after','scope'].includes(key)))throw new Error('无效识别明细范围');const r=v as Record<string,unknown>;
 if(!Number.isSafeInteger(r.after)||Number(r.after)<-1||Number(r.after)>999999||!['failed','all'].includes(String(r.scope)))throw new Error('无效识别明细分页');return {jobId:workflowId(r.jobId),after:Number(r.after),scope:r.scope as 'failed'|'all'};
}
export function readRecognitionResultRequest(v:unknown):{jobId:string;claimToken:string;itemId:string}{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==3||Object.keys(v).some(k=>!['jobId','claimToken','itemId'].includes(k)))throw new Error('无效后台关联读取');const r=v as Record<string,unknown>;if(typeof r.itemId!=='string'||!r.itemId||r.itemId.length>128||/[\u0000-\u001f\u007f]/.test(r.itemId))throw new Error('无效后台识别曲目');return {jobId:workflowId(r.jobId),claimToken:workflowId(r.claimToken),itemId:r.itemId};}
