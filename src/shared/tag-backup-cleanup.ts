import {tagWriteKeys,tagWriteUuid,tagWriteHash,tagWriteInteger,readTagWriteFileEvidence,type TagWriteFileEvidence} from './tag-write.js';
import {readTagPhysicalIdentity,readTagArtifactInspection,type TagPhysicalIdentity,type TagArtifactInspection} from './tag-recovery.js';
import {tagCommitCanonical} from './tag-commit-journal.js';

export interface TagBackupPhysicalProof {
 root:TagPhysicalIdentity;
 // The verified file observed under an exclusive handle before deletion.
 backup:TagArtifactInspection<'backup'>;
 removed:boolean;
}
export interface TagBackupNativeRequest {
 version:1;kind:'inspect-backup'|'delete-backup';operationId:string;jobId:string;backupArtifactId:string;
 backupRoot:string;source:TagWriteFileEvidence;expected:TagBackupPhysicalProof|null;
}
export const TAG_BACKUP_DELETE_PHASES=['checked','delete_ready','deleted'] as const;
export type TagBackupDeletePhase=typeof TAG_BACKUP_DELETE_PHASES[number];
export type TagBackupNativeMessage={version:1;operationId:string;sequence:number}&(
 {kind:'progress';role:'backup';bytes:string;total:string}|
 {kind:'stage';phase:TagBackupDeletePhase;proof:TagBackupPhysicalProof}|
 {kind:'done';proof:TagBackupPhysicalProof}|{kind:'error';message:string});
export type TagBackupNativeStage=Extract<TagBackupNativeMessage,{kind:'stage'}>;
export interface TagBackupCleanupBinding {
 version:1;catalogOrigin:string;executionId:string;jobRevision:number;policyRevision:number;
 stagingJournalSha256:string;request:TagBackupNativeRequest;
}
export interface TagBackupCleanupJournalSnapshot {
 binding:TagBackupCleanupBinding;revision:number;sha256:string;hashes:string[];stages:TagBackupNativeStage[];
}
export function readTagBackupCleanupBinding(v:unknown):TagBackupCleanupBinding {
 if(!tagWriteKeys(v,['version','catalogOrigin','executionId','jobRevision','policyRevision','stagingJournalSha256','request'])||v.version!==1||![v.catalogOrigin,v.executionId].every(tagWriteUuid)||![v.jobRevision,v.policyRevision].every(n=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<Number.MAX_SAFE_INTEGER)||!tagWriteHash(v.stagingJournalSha256))throw new Error('备份清理日志初始绑定无效');
 return {version:1,catalogOrigin:String(v.catalogOrigin).toLowerCase(),executionId:String(v.executionId).toLowerCase(),jobRevision:Number(v.jobRevision),policyRevision:Number(v.policyRevision),stagingJournalSha256:v.stagingJournalSha256,request:readTagBackupNativeRequest(v.request)};
}
export function readTagBackupCleanupStage(v:unknown,binding:TagBackupCleanupBinding,previous:TagBackupNativeStage[]):TagBackupNativeStage {
 const sequence=(v as {sequence?:unknown}|null)?.sequence,last=previous.at(-1);
 if(!Number.isSafeInteger(sequence)||Number(sequence)<1||Number(sequence)>131072||last&&Number(sequence)<=last.sequence)throw new Error('备份清理日志阶段顺序无效');
 const message=readTagBackupNativeMessage(v,binding.request,Number(sequence)-1,previous.length);
 if(message.kind!=='stage')throw new Error('备份清理日志不能保存其他消息作为阶段');
 if(last&&tagCommitCanonical({...last.proof,removed:false})!==tagCommitCanonical({...message.proof,removed:false}))throw new Error('备份清理日志的原文件证据发生变化');
 return message;
}
export function readTagBackupPhysicalProof(v:unknown):TagBackupPhysicalProof {
 if(!tagWriteKeys(v,['root','backup','removed'])||typeof v.removed!=='boolean')throw new Error('备份核对证据无效');
 const root=readTagPhysicalIdentity(v.root),backup=readTagArtifactInspection(v.backup,'backup');
 if(backup.state!=='present'||!backup.flac||!backup.identity||backup.reason!=='')throw new Error('备份尚未取得完整独立文件证据');
 return {root,backup,removed:v.removed};
}
export function readTagBackupNativeRequest(v:unknown):TagBackupNativeRequest {
 if(!tagWriteKeys(v,['version','kind','operationId','jobId','backupArtifactId','backupRoot','source','expected'])||v.version!==1||!['inspect-backup','delete-backup'].includes(String(v.kind))||![v.operationId,v.jobId,v.backupArtifactId].every(tagWriteUuid)||typeof v.backupRoot!=='string'||v.backupRoot.length<3||v.backupRoot.length>32767||v.backupRoot.includes('\0'))throw new Error('备份清理原生请求无效');
 const source=readTagWriteFileEvidence(v.source),expected=v.expected===null?null:readTagBackupPhysicalProof(v.expected);
 if(v.kind==='inspect-backup'&&expected!==null||v.kind==='delete-backup'&&(!expected||expected.removed||tagCommitCanonical(expected.backup.flac)!==tagCommitCanonical(source)))throw new Error('备份删除缺少原核对依据或与原备份内容不同');
 return {version:1,kind:v.kind as TagBackupNativeRequest['kind'],operationId:String(v.operationId).toLowerCase(),jobId:String(v.jobId).toLowerCase(),backupArtifactId:String(v.backupArtifactId).toLowerCase(),backupRoot:v.backupRoot,source,expected};
}
function proofFor(value:unknown,request:TagBackupNativeRequest,removed:boolean):TagBackupPhysicalProof {
 const proof=readTagBackupPhysicalProof(value);
 if(proof.removed!==removed||tagCommitCanonical(proof.backup.flac)!==tagCommitCanonical(request.source))throw new Error('备份内容与冻结来源证据不同');
 if(request.expected){
  const expected=request.expected;
  if(['volume','fileId','creation'].some(key=>proof.root[key as keyof TagPhysicalIdentity]!==expected.root[key as keyof TagPhysicalIdentity])||tagCommitCanonical(proof.backup)!==tagCommitCanonical(expected.backup))throw new Error('备份文件或目录身份已变化');
 }
 return proof;
}
export function readTagBackupNativeMessage(v:unknown,request:TagBackupNativeRequest,last:number,phases:number):TagBackupNativeMessage {
 if(!v||typeof v!=='object')throw new Error('备份清理回执无效');const r=v as Record<string,unknown>,base=['version','operationId','sequence','kind'];
 if(r.version!==1||r.operationId!==request.operationId||r.sequence!==last+1||!Number.isSafeInteger(r.sequence)||Number(r.sequence)>131072)throw new Error('备份清理回执身份或顺序无效');
 if(r.kind==='progress'){
  if(!tagWriteKeys(r,[...base,'role','bytes','total'])||r.role!=='backup'||!tagWriteInteger(r.bytes)||!tagWriteInteger(r.total)||r.total!==request.source.byteLength||BigInt(r.bytes)>BigInt(r.total))throw new Error('备份清理进度无效');
 }else if(r.kind==='stage'){
  if(!tagWriteKeys(r,[...base,'phase','proof'])||r.phase!==TAG_BACKUP_DELETE_PHASES[phases]||request.kind==='inspect-backup'&&phases!==0)throw new Error('备份清理阶段跳跃或重复');
  proofFor(r.proof,request,r.phase==='deleted');
 }else if(r.kind==='done'){
  if(!tagWriteKeys(r,[...base,'proof'])||phases!==(request.kind==='delete-backup'?3:1))throw new Error('备份清理尚未取得全部持久回执');
  proofFor(r.proof,request,request.kind==='delete-backup');
 }else if(r.kind==='error'){
  if(!tagWriteKeys(r,[...base,'message'])||typeof r.message!=='string'||!r.message||r.message.length>512)throw new Error('备份清理错误回执无效');
 }else throw new Error('未知备份清理消息');
 return r as unknown as TagBackupNativeMessage;
}
export function tagBackupReceiptHash(v:unknown):string {
 if(!tagWriteHash(v))throw new Error('备份清理阶段尚未取得持久回执');return v;
}
