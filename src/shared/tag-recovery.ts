import {tagWriteKeys,tagWriteUuid,tagWriteHash,readTagWriteFileEvidence,type TagWriteFileEvidence} from './tag-write.js';
export const TAG_INSPECTION_VERSION=1;
export const TAG_ARTIFACT_ROLES=['original','backup','temporary'] as const;
export type TagArtifactRole=typeof TAG_ARTIFACT_ROLES[number];
export interface TagPhysicalIdentity {volume:string;fileId:string;creation:string;modified:string;changed:string;bytes:string}
export interface TagArtifactInspection<R extends TagArtifactRole|'victim'=TagArtifactRole> {role:R;state:'present'|'missing'|'busy'|'unreadable';identity:TagPhysicalIdentity|null;sha256:string|null;flac:TagWriteFileEvidence|null;reason:string}
export interface TagInspectionRequest {version:1;kind:'inspect';inspectionId:string;sourceRoot:string;backupRoot:string;files:Array<{role:TagArtifactRole;path:string}>}
export type TagInspectionMessage={version:1;inspectionId:string;sequence:number}&(
 {kind:'progress';role:TagArtifactRole;bytes:string;total:string}|
 {kind:'done';files:TagArtifactInspection[];roots:TagPhysicalIdentity[];exclusiveRead:true}|
 {kind:'error';message:string});
export type TagInspectionResult=Pick<Extract<TagInspectionMessage,{kind:'done'}>,'files'|'roots'|'exclusiveRead'>;
export type TagRecoveryClassification='unchanged'|'staged'|'restore-available'|'recovery-required'|'source-baseline-unavailable'|'journal-unconfirmed';
export interface TagRecoveryReport {classification:TagRecoveryClassification;journal:'matched'|'fs-ahead'|'unconfirmed';reason:string;actual:TagInspectionResult}
export interface TagRecoveryView {id:string;state:'running'|'completed'|'cancelled'|'failed'|'interrupted';createdAt:string;updatedAt:string;exitConfirmed:boolean;phase:TagArtifactRole|null;bytes:string;total:string;error:string;report:TagRecoveryReport|null}
export interface TagRecoveryCancelRequest {commandId:string;inspectionId:string}
export interface TagRecoveryActionRequest {commandId:string;jobId:string;baseRevision:number;inspectionId:string;action:'cancel-unchanged'|'keep-current';confirmed:true}
export interface TagRecoveryActionCancelRequest {commandId:string;actionId:string}
export interface TagRecoveryActionView {id:string;action:TagRecoveryActionRequest['action'];state:'running'|'completed'|'cancelled'|'failed'|'interrupted';createdAt:string;updatedAt:string;phase:TagArtifactRole|null;bytes:string;total:string;reason:string;scan:{commandId:string;jobId:string|null;state:'waiting'|'queued'|'running'|'cancelling'|'succeeded'|'failed'|'cancelled'|'interrupted'|'file-unavailable'|'file-ready'|'directory-changed'}|null}
const integer=(v:unknown,max=18446744073709551615n):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=max;
export function readTagPhysicalIdentity(v:unknown):TagPhysicalIdentity {
 if(!tagWriteKeys(v,['volume','fileId','creation','modified','changed','bytes'])||typeof v.fileId!=='string'||!/^[0-9a-f]{32}$/.test(v.fileId)||!['volume','creation','modified','changed','bytes'].every(k=>integer(v[k])))throw new Error('文件物理身份回执无效');
 return v as unknown as TagPhysicalIdentity;
}
export function readTagArtifactInspection<R extends TagArtifactRole|'victim'>(v:unknown,role:R):TagArtifactInspection<R> {
 if(!tagWriteKeys(v,['role','state','identity','sha256','flac','reason'])||v.role!==role||!['present','missing','busy','unreadable'].includes(String(v.state))||typeof v.reason!=='string'||v.reason.length>512)throw new Error('文件核对回执无效');
 if(v.state!=='present'){if(v.identity!==null||v.sha256!==null||v.flac!==null)throw new Error('不可读取工件不能带完整文件证据');}
 else {const id=readTagPhysicalIdentity(v.identity);if(!tagWriteHash(v.sha256)||BigInt(id.bytes)>68719476736n)throw new Error('完整文件摘要无效');if(v.flac!==null){const f=readTagWriteFileEvidence(v.flac);if(f.sha256!==v.sha256||f.byteLength!==id.bytes)throw new Error('FLAC 与完整工件证据不符');}}
 return v as unknown as TagArtifactInspection<R>;
}
export function readTagInspectionMessage(v:unknown,id:string,last:number):TagInspectionMessage {
 if(!v||typeof v!=='object')throw new Error('文件核对消息无效');const r=v as Record<string,unknown>;
 if(r.version!==1||r.inspectionId!==id||r.sequence!==last+1||!Number.isSafeInteger(r.sequence)||Number(r.sequence)>131072)throw new Error('文件核对消息身份或顺序无效');
 const common=['version','inspectionId','sequence','kind'];
 if(r.kind==='progress') {if(!tagWriteKeys(r,[...common,'role','bytes','total'])||!TAG_ARTIFACT_ROLES.includes(r.role as TagArtifactRole)||!integer(r.bytes,68719476736n)||!integer(r.total,68719476736n)||BigInt(r.bytes)>BigInt(r.total))throw new Error('文件核对进度无效');}
 else if(r.kind==='error'){if(!tagWriteKeys(r,[...common,'message'])||typeof r.message!=='string'||!r.message||r.message.length>512)throw new Error('文件核对错误回执无效');}
 else if(r.kind==='done'){
  if(!tagWriteKeys(r,[...common,'files','roots','exclusiveRead'])||r.exclusiveRead!==true||!Array.isArray(r.files)||r.files.length!==3||!Array.isArray(r.roots)||r.roots.length!==2)throw new Error('文件核对最终回执无效');
  r.files.forEach((f,i)=>readTagArtifactInspection(f,TAG_ARTIFACT_ROLES[i]));r.roots.forEach(readTagPhysicalIdentity);
 }else throw new Error('未知文件核对消息');
 return r as unknown as TagInspectionMessage;
}
export function readTagRecoveryCancel(v:unknown):TagRecoveryCancelRequest {if(!tagWriteKeys(v,['commandId','inspectionId'])||!tagWriteUuid(v.commandId)||!tagWriteUuid(v.inspectionId))throw new Error('取消文件核对请求无效');return {commandId:v.commandId.toLowerCase(),inspectionId:v.inspectionId.toLowerCase()};}
export function readTagRecoveryAction(v:unknown):TagRecoveryActionRequest {
 if(!tagWriteKeys(v,['commandId','jobId','baseRevision','inspectionId','action','confirmed'])||!tagWriteUuid(v.commandId)||!tagWriteUuid(v.jobId)||!tagWriteUuid(v.inspectionId)||!Number.isSafeInteger(v.baseRevision)||Number(v.baseRevision)<0||!['cancel-unchanged','keep-current'].includes(String(v.action))||v.confirmed!==true)throw new Error('恢复处理请求无效，请先确认保留当前文件并取消标签任务');
 return {commandId:v.commandId.toLowerCase(),jobId:v.jobId.toLowerCase(),baseRevision:Number(v.baseRevision),inspectionId:v.inspectionId.toLowerCase(),action:v.action as TagRecoveryActionRequest['action'],confirmed:true};
}
export function readTagRecoveryActionCancel(v:unknown):TagRecoveryActionCancelRequest {if(!tagWriteKeys(v,['commandId','actionId'])||!tagWriteUuid(v.commandId)||!tagWriteUuid(v.actionId))throw new Error('停止恢复处理请求无效');return {commandId:v.commandId.toLowerCase(),actionId:v.actionId.toLowerCase()};}
export function assertTagRecoveryActionAllowed(request:TagRecoveryActionRequest,report:TagRecoveryReport):void {
 const original=readTagArtifactInspection(report.actual.files[0],'original');
 if(original.state!=='present'||!original.flac)throw new Error('当前原文件未能读取或未确认 FLAC，不能解除恢复占用');
 if(request.action==='cancel-unchanged'&&(!['unchanged','staged'].includes(report.classification)||!['matched','fs-ahead'].includes(report.journal)))throw new Error('未取得原文件与已验证来源一致的证据，请重新核对或显式选择保留当前文件');
}
export function assertTagRecoverySnapshotEqual(before:TagInspectionResult,after:TagInspectionResult):void {
 if(before.exclusiveRead!==true||after.exclusiveRead!==true||before.files.length!==3||after.files.length!==3||before.roots.length!==2||after.roots.length!==2)throw new Error('恢复文件快照结构无效');
 const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
 TAG_ARTIFACT_ROLES.forEach((role,i)=>{const a=readTagArtifactInspection(before.files[i],role),b=readTagArtifactInspection(after.files[i],role);if(canonical(a)!==canonical(b))throw new Error('文件或工件已变化，请重新核对后再处理');});
 before.roots.forEach((root,i)=>{const a=readTagPhysicalIdentity(root),b=readTagPhysicalIdentity(after.roots[i]);if(a.volume!==b.volume||a.fileId!==b.fileId||a.creation!==b.creation)throw new Error('核对后目录物理身份已变化');});
}
