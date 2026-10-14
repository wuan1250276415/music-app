import {tagWriteKeys,tagWriteUuid,tagWriteHash,tagWriteInteger,readTagWriteFileEvidence} from './tag-write.js';
import {readTagPhysicalIdentity,readTagArtifactInspection,assertTagRecoverySnapshotEqual,TAG_ARTIFACT_ROLES,type TagPhysicalIdentity,type TagArtifactInspection,type TagInspectionResult} from './tag-recovery.js';
import {readTagOriginPolicy,type TagOriginPolicy} from './tag-origin-policy.js';
import {TAG_WRITE_CERTIFICATES} from './tag-write-certification.js';

export const TAG_COMMIT_PHASES=['locked','intent','victim_moved','replaced','verified'] as const;
export type TagCommitPhase=typeof TAG_COMMIT_PHASES[number];
export type TagCommitRole='original'|'backup'|'temporary'|'victim'|'destination';
export interface TagCommitRequest {version:1;kind:'commit';operationId:string;jobId:string;leaseId:string;leaseRevision:number;certificateId:string;sourceRoot:string;backupRoot:string;files:Array<{role:typeof TAG_ARTIFACT_ROLES[number];path:string}>;expected:TagInspectionResult;victimArtifactId:string}
export interface TagCommitPolicy {origin?:TagOriginPolicy;creation:string;lastAccess:string;attributes:number;security:{ownerSha256:string;groupSha256:string;daclSha256:string|null;present:boolean;protected:boolean};streams:'unnamed-only';lastWrite:'staged-file-time';audit:'not-certified'}
export interface TagCommitProof {files:Array<Omit<TagArtifactInspection,'role'>&{role:TagCommitRole}>;roots:TagPhysicalIdentity[];parent:TagPhysicalIdentity;policy:TagCommitPolicy|null;leaseId:string;leaseRevision:number;certificateId:string;victimArtifactId:string}
export type TagCommitMessage={version:1;operationId:string;sequence:number}&(
 {kind:'progress';role:TagCommitRole;bytes:string;total:string}|
 {kind:'stage';phase:TagCommitPhase;proof:TagCommitProof}|
 {kind:'done';proof:TagCommitProof}|
 {kind:'error';message:string});
export function assertTagCommitCertified(id:string):void {const catalog:ReadonlyArray<{id:string}>=TAG_WRITE_CERTIFICATES;if(!tagWriteHash(id)||!catalog.some(c=>c.id===id))throw new Error('此格式和文件系统提交路径尚未认证，不允许替换原文件');}
export function readTagCommitRequest(v:unknown,requireCertification=true):TagCommitRequest {
 if(!tagWriteKeys(v,['version','kind','operationId','jobId','leaseId','leaseRevision','certificateId','sourceRoot','backupRoot','files','expected','victimArtifactId'])||v.version!==1||v.kind!=='commit'||![v.operationId,v.jobId,v.leaseId,v.victimArtifactId].every(tagWriteUuid)||!Number.isSafeInteger(v.leaseRevision)||Number(v.leaseRevision)<1||typeof v.certificateId!=='string'||!Array.isArray(v.files)||v.files.length!==3)throw new Error('原生文件提交身份无效');
 if(!tagWriteHash(v.certificateId))throw new Error('提交认证身份无效');if(requireCertification)assertTagCommitCertified(v.certificateId);
 for(const p of [v.sourceRoot,v.backupRoot,...v.files.map((f,i)=>{if(!tagWriteKeys(f,['role','path'])||f.role!==TAG_ARTIFACT_ROLES[i])throw new Error('提交文件角色无效');return f.path;})])if(typeof p!=='string'||!p.length||p.length>32767||p.includes('\0'))throw new Error('提交路径无效');
 if(!tagWriteKeys(v.expected,['files','roots','exclusiveRead']))throw new Error('提交核对基准无效');const expected=v.expected as unknown as TagInspectionResult;assertTagRecoverySnapshotEqual(expected,expected);
 if(expected.files.some(f=>f.state!=='present'||!f.flac||f.reason!==''))throw new Error('提交需要三个实际可读且已确认的 FLAC 工件');
 return structuredClone(v) as unknown as TagCommitRequest;
}
function policy(v:unknown):TagCommitPolicy {
 if(!tagWriteKeys(v,['creation','lastAccess','attributes','security','streams','lastWrite','audit',...(v&&typeof v==='object'&&'origin' in v?['origin']:[])])||!tagWriteInteger(v.creation)||!tagWriteInteger(v.lastAccess)||!Number.isSafeInteger(v.attributes)||Number(v.attributes)<0||Number(v.attributes)>4294967295||v.streams!=='unnamed-only'||v.lastWrite!=='staged-file-time'||v.audit!=='not-certified'||!tagWriteKeys(v.security,['ownerSha256','groupSha256','daclSha256','present','protected'])||!tagWriteHash(v.security.ownerSha256)||!tagWriteHash(v.security.groupSha256)||v.security.daclSha256!==null&&!tagWriteHash(v.security.daclSha256)||typeof v.security.present!=='boolean'||typeof v.security.protected!=='boolean')throw new Error('提交权限与时间策略无效');if('origin' in v){const o=readTagOriginPolicy(v.origin);if(o.creation!==v.creation||o.lastAccess!==v.lastAccess||o.attributes!==v.attributes||JSON.stringify(o.security,Object.keys(o.security).sort())!==JSON.stringify(v.security,Object.keys(o.security).sort()))throw new Error('提交原权限存档与策略不符');}return v as unknown as TagCommitPolicy;
}
function proof(v:unknown,request:TagCommitRequest,phase:TagCommitPhase):TagCommitProof {
 if(!tagWriteKeys(v,['files','roots','parent','policy','leaseId','leaseRevision','certificateId','victimArtifactId'])||v.leaseId!==request.leaseId||v.leaseRevision!==request.leaseRevision||v.certificateId!==request.certificateId||v.victimArtifactId!==request.victimArtifactId||!Array.isArray(v.files)||v.files.length!==3||!Array.isArray(v.roots)||v.roots.length!==2)throw new Error('提交文件证据身份无效');
 const moved=TAG_COMMIT_PHASES.indexOf(phase)>=2,replaced=TAG_COMMIT_PHASES.indexOf(phase)>=3,roles:TagCommitRole[]=[moved?'victim':'original','backup',replaced?'destination':'temporary'];
 v.files.forEach((file,i)=>{if(!file||typeof file!=='object'||(file as {role:unknown}).role!==roles[i])throw new Error('提交文件证据角色无效');const f=readTagArtifactInspection({...file,role:TAG_ARTIFACT_ROLES[i]},TAG_ARTIFACT_ROLES[i]),before=request.expected.files[i];
  if(f.state!=='present'||!f.flac||f.reason!==''||JSON.stringify(readTagWriteFileEvidence(f.flac))!==JSON.stringify(readTagWriteFileEvidence(before.flac))||!f.identity||!before.identity||['volume','fileId','bytes'].some(key=>f.identity![key as keyof TagPhysicalIdentity]!==before.identity![key as keyof TagPhysicalIdentity]))throw new Error('提交内容或实际物理身份与冻结工件不符');
 });
 v.roots.forEach((r,i)=>{const id=readTagPhysicalIdentity(r),before=request.expected.roots[i];if(['volume','fileId','creation'].some(key=>id[key as keyof TagPhysicalIdentity]!==before[key as keyof TagPhysicalIdentity]))throw new Error('提交目录身份变化');});readTagPhysicalIdentity(v.parent);
 if(phase==='locked'){if(v.policy!==null)throw new Error('提交锁定阶段尚未更改属性');assertTagRecoverySnapshotEqual(request.expected,{files:v.files as TagArtifactInspection[],roots:v.roots as TagPhysicalIdentity[],exclusiveRead:true});}
 else {const p=policy(v.policy);if(p.origin&&p.origin.modified!==request.expected.files[0].identity!.modified)throw new Error('原权限存档修改时间与原提交来源不符');const destination=(v.files[2] as TagArtifactInspection).identity!;if(destination.creation!==p.creation||p.creation!==request.expected.files[0].identity!.creation)throw new Error('目标创建时间没有按策略保留');}
 return v as unknown as TagCommitProof;
}
export function readTagCommitMessage(v:unknown,request:TagCommitRequest,last:number,phases:number):TagCommitMessage {
 if(!v||typeof v!=='object')throw new Error('提交回执无效');const r=v as Record<string,unknown>,base=['version','operationId','sequence','kind'];if(r.version!==1||r.operationId!==request.operationId||r.sequence!==last+1||!Number.isSafeInteger(r.sequence)||Number(r.sequence)>131072)throw new Error('提交回执顺序无效');
 if(r.kind==='progress'){if(!tagWriteKeys(r,[...base,'role','bytes','total'])||!['original','backup','temporary','victim','destination'].includes(String(r.role))||!tagWriteInteger(r.bytes)||!tagWriteInteger(r.total)||BigInt(r.total)>68719476736n||BigInt(r.bytes)>BigInt(r.total))throw new Error('提交进度无效');}
 else if(r.kind==='stage'){if(!tagWriteKeys(r,[...base,'phase','proof'])||r.phase!==TAG_COMMIT_PHASES[phases])throw new Error('提交阶段跳跃或重复');proof(r.proof,request,TAG_COMMIT_PHASES[phases]);}
 else if(r.kind==='done'){if(!tagWriteKeys(r,[...base,'proof'])||phases!==5)throw new Error('提交尚未确认全部阶段');proof(r.proof,request,'verified');}
 else if(r.kind==='error'){if(!tagWriteKeys(r,[...base,'message'])||typeof r.message!=='string'||!r.message||r.message.length>512)throw new Error('提交错误回执无效');}else throw new Error('未知提交回执');
 return r as unknown as TagCommitMessage;
}
