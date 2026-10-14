import {tagWriteKeys,tagWriteUuid,tagWriteHash} from './tag-write.js';
import {readTagCommitBinding,tagCommitCanonical,type TagCommitBinding} from './tag-commit-journal.js';
import {readTagRestoreRequest,readTagRestoreMessage,assertTagRestoreTransition,type TagRestoreRequest,type TagRestoreMode,type TagRestoreMessage,type TagRestoreProof} from './tag-restore.js';

export interface TagRestoreStart {commandId:string;jobId:string;baseRevision:number;inspectionId:string;certificateId:string;mode:TagRestoreMode;confirmed:true}
export interface TagRestoreCancel {commandId:string;operationId:string}
export interface TagRestoreBinding {version:1;start:TagRestoreStart;commit:TagCommitBinding;commitJournalRevision:number;commitJournalStatus:'matched'|'fs-ahead';request:TagRestoreRequest}
export type TagRestoreStage=Extract<TagRestoreMessage,{kind:'stage'}>;
export interface TagRestoreJournalSnapshot {binding:TagRestoreBinding;revision:number;sha256:string;hashes:string[];stages:TagRestoreStage[]}
export interface TagRestoreView {id:string;mode:TagRestoreMode;state:'reserved'|'running'|'native_restored'|'recovery_required';phase:string;bytes:string;total:string;exitConfirmed:boolean;reason:string}
export function readTagRestoreStart(value:unknown):TagRestoreStart {
 if(!tagWriteKeys(value,['commandId','jobId','baseRevision','inspectionId','certificateId','mode','confirmed'])||![value.commandId,value.jobId,value.inspectionId].every(tagWriteUuid)||!Number.isSafeInteger(value.baseRevision)||Number(value.baseRevision)<0||!tagWriteHash(value.certificateId)||!['victim','backup'].includes(String(value.mode))||value.confirmed!==true)throw new Error('恢复请求无效，请先确认恢复原来源并保留现有目标');
 return {commandId:String(value.commandId).toLowerCase(),jobId:String(value.jobId).toLowerCase(),baseRevision:Number(value.baseRevision),inspectionId:String(value.inspectionId).toLowerCase(),certificateId:String(value.certificateId),mode:value.mode as TagRestoreMode,confirmed:true};
}
export function readTagRestoreCancel(value:unknown):TagRestoreCancel {if(!tagWriteKeys(value,['commandId','operationId'])||![value.commandId,value.operationId].every(tagWriteUuid))throw new Error('停止恢复请求无效');return {commandId:String(value.commandId).toLowerCase(),operationId:String(value.operationId).toLowerCase()};}
export function readTagRestoreBinding(value:unknown):TagRestoreBinding {
 if(!tagWriteKeys(value,['version','start','commit','commitJournalRevision','commitJournalStatus','request'])||value.version!==1||!Number.isSafeInteger(value.commitJournalRevision)||Number(value.commitJournalRevision)<0||Number(value.commitJournalRevision)>5||!['matched','fs-ahead'].includes(String(value.commitJournalStatus)))throw new Error('恢复日志绑定无效');
 const start=readTagRestoreStart(value.start),commit=readTagCommitBinding(value.commit),request=readTagRestoreRequest(value.request,false);
 if(request.operationId!==start.commandId||request.jobId!==start.jobId||request.commitOperationId!==commit.request.operationId||request.mode!==start.mode||request.certificateId!==start.certificateId||request.leaseId!==commit.request.leaseId||request.leaseRevision!==commit.request.leaseRevision+1||request.victimArtifactId!==commit.request.victimArtifactId||request.sourceRoot!==commit.request.sourceRoot||request.backupRoot!==commit.request.backupRoot||request.stagingJournalSha256!==commit.stagingJournalSha256||tagCommitCanonical(request.baseline)!==tagCommitCanonical(commit.request.expected)||tagCommitCanonical(request.files.slice(0,3))!==tagCommitCanonical(commit.request.files))throw new Error('恢复绑定不属于原提交、审核及新的租约修订');
 return {version:1,start,commit,commitJournalRevision:Number(value.commitJournalRevision),commitJournalStatus:value.commitJournalStatus as TagRestoreBinding['commitJournalStatus'],request};
}
export function readTagRestoreStage(value:unknown,binding:TagRestoreBinding,stages:TagRestoreStage[]):TagRestoreStage {
 if(!value||typeof value!=='object'||!Number.isSafeInteger((value as {sequence:unknown}).sequence)||Number((value as {sequence:unknown}).sequence)<1||Number((value as {sequence:unknown}).sequence)<=(stages.at(-1)?.sequence??0))throw new Error('恢复阶段序列无效');
 const sequence=Number((value as {sequence:number}).sequence),message=readTagRestoreMessage(value,binding.request,sequence-1,stages.length);if(message.kind!=='stage')throw new Error('恢复日志只接受关键阶段证明');assertTagRestoreTransition(message.proof,binding.request,message.phase,stages.map(stage=>stage.proof));return message;
}
export function readTagRestoreFinalProof(value:unknown,binding:TagRestoreBinding,stages:TagRestoreStage[]):TagRestoreProof {
 const final=stages.at(-1);if(stages.length!==6||final?.phase!=='verified'||tagCommitCanonical(value)!==tagCommitCanonical(final.proof))throw new Error('恢复实际退出结果与持久阶段不符');readTagRestoreStage(final,binding,stages.slice(0,-1));return final.proof;
}
