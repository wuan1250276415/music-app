import {tagWriteKeys,tagWriteUuid,tagWriteHash,tagWriteInteger} from './tag-write.js';
import {readTagPhysicalIdentity,readTagArtifactInspection,assertTagRecoverySnapshotEqual,type TagPhysicalIdentity,type TagArtifactInspection,type TagInspectionResult} from './tag-recovery.js';
import {readTagCommitInspectionResult,TAG_COMMIT_ARTIFACT_ROLES,type TagCommitInspectionResult} from './tag-commit-recovery.js';
import {readTagOriginPolicy,type TagOriginPolicy} from './tag-origin-policy.js';
import {TAG_RESTORE_CERTIFICATES} from './tag-restore-certification.js';

export const TAG_RESTORE_PHASES=['locked','prepared','intent','displaced','restored','verified'] as const;
export const TAG_RESTORE_ROLES=[...TAG_COMMIT_ARTIFACT_ROLES,'replacement','displaced'] as const;
export type TagRestoreMode='victim'|'backup';
export type TagRestorePhase=typeof TAG_RESTORE_PHASES[number];
export type TagRestoreRole=typeof TAG_RESTORE_ROLES[number];
export type TagRestoreArtifact=Omit<TagArtifactInspection,'role'>&{role:TagRestoreRole};
export interface TagRestoreRequest {
 version:1|2;origin?:TagOriginPolicy;kind:'restore';operationId:string;commitOperationId:string;jobId:string;leaseId:string;leaseRevision:number;certificateId:string;mode:TagRestoreMode;
 sourceRoot:string;backupRoot:string;files:Array<{role:typeof TAG_COMMIT_ARTIFACT_ROLES[number];path:string}>;expected:TagCommitInspectionResult;baseline:TagInspectionResult;
 victimArtifactId:string;replacementArtifactId:string;displacedArtifactId:string;commitJournalSha256:string;stagingJournalSha256:string;
}
export interface TagRestorePolicy {
 origin?:TagOriginPolicy;source:TagRestoreMode;creation:string;modified:string;lastAccess:string;attributes:number;
 security:{ownerSha256:string;groupSha256:string;daclSha256:string|null;present:boolean;protected:boolean};
 permissions:'restoration-source-dacl'|'original-source-dacl';streams:'unnamed-only';audit:'not-certified';
}
export interface TagRestoreProof {
 files:TagRestoreArtifact[];roots:TagPhysicalIdentity[];parent:TagPhysicalIdentity;policy:TagRestorePolicy|null;
 leaseId:string;leaseRevision:number;certificateId:string;mode:TagRestoreMode;commitOperationId:string;victimArtifactId:string;replacementArtifactId:string;displacedArtifactId:string;commitJournalSha256:string;stagingJournalSha256:string;
}
export type TagRestoreMessage={version:1|2;operationId:string;sequence:number}&(
 {kind:'progress';role:TagRestoreRole;bytes:string;total:string}|
 {kind:'stage';phase:TagRestorePhase;proof:TagRestoreProof}|
 {kind:'done';proof:TagRestoreProof}|{kind:'error';message:string});
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v);
const sameObject=(a:TagPhysicalIdentity,b:TagPhysicalIdentity)=>a.volume===b.volume&&a.fileId===b.fileId&&a.bytes===b.bytes;
const sameDirectory=(a:TagPhysicalIdentity,b:TagPhysicalIdentity)=>a.volume===b.volume&&a.fileId===b.fileId&&a.creation===b.creation;
const sameContent=(a:TagRestoreArtifact,b:Omit<TagRestoreArtifact,'role'>)=>a.state==='present'&&a.reason===''&&a.flac!==null&&canonical(a.flac)===canonical(b.flac);
const sameFile=(a:TagRestoreArtifact,b:Omit<TagRestoreArtifact,'role'>)=>sameContent(a,b)&&a.identity!==null&&b.identity!==null&&sameObject(a.identity,b.identity);
const normalize=(name:string)=>name.replace(/\//g,'\\').replace(/\\+$/,'').toLowerCase();
const parent=(name:string)=>name.slice(0,name.lastIndexOf('\\'));
const contained=(root:string,name:string)=>name.startsWith(`${root}\\`);
const artifactName=(name:string,prefix:string,suffix:string)=>name.startsWith(prefix)&&name.endsWith(suffix)&&tagWriteUuid(name.slice(prefix.length,-suffix.length));

export function assertTagRestoreCertified(id:string,mode:TagRestoreMode,version:1|2=2):void {
 const catalog:ReadonlyArray<{id:string;mode:TagRestoreMode;adapter:string}>=TAG_RESTORE_CERTIFICATES;
 if(!tagWriteHash(id)||!catalog.some(c=>c.id===id&&c.mode===mode&&c.adapter===`aural-flac-restore-v${version}`))throw new Error('此文件恢复方式尚未认证，不允许移动或恢复原文件');
}
export function readTagRestoreRequest(value:unknown,requireCertification=true):TagRestoreRequest {
 const names=['version','kind','operationId','commitOperationId','jobId','leaseId','leaseRevision','certificateId','mode','sourceRoot','backupRoot','files','expected','baseline','victimArtifactId','replacementArtifactId','displacedArtifactId','commitJournalSha256','stagingJournalSha256'];
 const version=value&&typeof value==='object'?(value as {version:unknown}).version:null;
 if(!tagWriteKeys(value,[...names,...(version===2?['origin']:[])])||(value.version!==1&&value.version!==2)||value.kind!=='restore'||![value.operationId,value.commitOperationId,value.jobId,value.leaseId,value.victimArtifactId,value.replacementArtifactId,value.displacedArtifactId].every(tagWriteUuid)||!Number.isSafeInteger(value.leaseRevision)||Number(value.leaseRevision)<1||!['victim','backup'].includes(String(value.mode))||![value.certificateId,value.commitJournalSha256,value.stagingJournalSha256].every(tagWriteHash)||new Set([value.victimArtifactId,value.replacementArtifactId,value.displacedArtifactId]).size!==3||value.operationId===value.commitOperationId||!Array.isArray(value.files)||value.files.length!==4)throw new Error('原生恢复身份或冻结日志无效');
 const mode=value.mode as TagRestoreMode;if(requireCertification)assertTagRestoreCertified(String(value.certificateId),mode,value.version as 1|2);
 const paths=[value.sourceRoot,value.backupRoot,...value.files.map((file,i)=>{if(!tagWriteKeys(file,['role','path'])||file.role!==TAG_COMMIT_ARTIFACT_ROLES[i])throw new Error('恢复文件角色无效');return file.path;})];
 if(paths.some(p=>typeof p!=='string'||!p.length||p.length>32767||p.includes('\0')||!/^[a-z]:[\\/]/i.test(p)||p.slice(2).includes(':')||/[\\/]\.\.?([\\/]|$)/.test(p)))throw new Error('恢复要求固定本地授权路径');
 const [sourceRoot,backupRoot,original,backup,temporary,victim]=paths.map(p=>normalize(String(p))),directory=parent(original),prefix=`.aural-${String(value.jobId).toLowerCase()}-`;
 if(new Set([original,backup,temporary,victim]).size!==4||!original.endsWith('.flac')||!contained(sourceRoot,original)||!contained(sourceRoot,temporary)||!contained(sourceRoot,victim)||parent(temporary)!==directory||parent(victim)!==directory||parent(backup)!==backupRoot||victim!==`${directory}\\${prefix}${String(value.victimArtifactId).toLowerCase()}.victim`||!artifactName(temporary.slice(directory.length+1),prefix,'.tmp')||!artifactName(backup.slice(backupRoot.length+1),`${String(value.jobId).toLowerCase()}-`,'.bak'))throw new Error('恢复工件布局无效');
 if(!tagWriteKeys(value.baseline,['files','roots','exclusiveRead']))throw new Error('恢复缺少原提交来源基准');
 const baseline=value.baseline as unknown as TagInspectionResult;assertTagRecoverySnapshotEqual(baseline,baseline);const actual=readTagCommitInspectionResult(value.expected),[source,sourceBackup,target]=baseline.files;
 if(baseline.files.some(f=>f.state!=='present'||f.reason!==''||!f.flac)||canonical(source.flac)!==canonical(sourceBackup.flac)||source.sha256===target.sha256||source.flac!.audioSha256!==target.flac!.audioSha256||source.flac!.audioBytes!==target.flac!.audioBytes||actual.roots.some((root,i)=>!sameDirectory(root,baseline.roots[i]))||actual.files.some(f=>!['present','missing'].includes(f.state))||!sameFile(actual.files[1],sourceBackup)||actual.files[0].state==='present'&&!sameFile(actual.files[0],target)||actual.files[2].state==='present'&&!sameFile(actual.files[2],target)||actual.files[3].state==='present'&&!sameFile(actual.files[3],source)||actual.files[0].state==='present'&&actual.files[2].state==='present'||mode==='victim'&&!sameFile(actual.files[3],source))throw new Error('恢复工件存在未知身份、内容或缺少有效来源');
 if(value.version===2){const o=readTagOriginPolicy(value.origin);if(o.creation!==source.identity!.creation||o.modified!==source.identity!.modified||!o.security.present)throw new Error('新恢复请求缺少可执行且属于原来源的权限存档');}
 const result=structuredClone(value) as unknown as TagRestoreRequest;for(const key of ['operationId','commitOperationId','jobId','leaseId','victimArtifactId','replacementArtifactId','displacedArtifactId'] as const)result[key]=result[key].toLowerCase();return result;
}
function readPolicy(value:unknown,request:TagRestoreRequest):TagRestorePolicy {
 if(!tagWriteKeys(value,['source','creation','modified','lastAccess','attributes','security','permissions','streams','audit',...(request.version===2?['origin']:[])])||value.source!==request.mode||![value.creation,value.modified,value.lastAccess].every(tagWriteInteger)||!Number.isSafeInteger(value.attributes)||Number(value.attributes)<0||Number(value.attributes)>4294967295||value.permissions!==(request.version===2?'original-source-dacl':'restoration-source-dacl')||value.streams!=='unnamed-only'||value.audit!=='not-certified'||!tagWriteKeys(value.security,['ownerSha256','groupSha256','daclSha256','present','protected'])||![value.security.ownerSha256,value.security.groupSha256].every(tagWriteHash)||value.security.daclSha256!==null&&!tagWriteHash(value.security.daclSha256)||typeof value.security.present!=='boolean'||typeof value.security.protected!=='boolean'||value.creation!==request.baseline.files[0].identity!.creation||value.modified!==request.baseline.files[0].identity!.modified)throw new Error('恢复时间与来源权限策略无效');
 if(request.version===2){const o=readTagOriginPolicy(value.origin);if(canonical(o)!==canonical(request.origin)||['creation','modified','lastAccess','attributes','security'].some(k=>canonical(value[k])!==canonical(o[k as keyof TagOriginPolicy])))throw new Error('恢复策略不属于提交前原权限存档');}
 return value as unknown as TagRestorePolicy;
}
export function readTagRestoreProof(value:unknown,request:TagRestoreRequest,phase:TagRestorePhase):TagRestoreProof {
 const names=['files','roots','parent','policy','leaseId','leaseRevision','certificateId','mode','commitOperationId','victimArtifactId','replacementArtifactId','displacedArtifactId','commitJournalSha256','stagingJournalSha256'];
 if(!tagWriteKeys(value,names)||!Array.isArray(value.files)||value.files.length!==6||!Array.isArray(value.roots)||value.roots.length!==2||names.slice(4).some(key=>value[key]!==request[key as keyof TagRestoreRequest]))throw new Error('恢复证明绑定无效');
 const files=value.files.map((file,i)=>{if(!file||typeof file!=='object'||(file as {role:unknown}).role!==TAG_RESTORE_ROLES[i])throw new Error('恢复证明角色无效');return {...readTagArtifactInspection({...file,role:'original'},'original'),role:TAG_RESTORE_ROLES[i]} as TagRestoreArtifact;});
 const stage=TAG_RESTORE_PHASES.indexOf(phase);if(stage<0||files.some(f=>!['present','missing'].includes(f.state)))throw new Error('恢复证明阶段或文件状态无效');
 value.roots.forEach((root,i)=>{if(!sameDirectory(readTagPhysicalIdentity(root),request.expected.roots[i]))throw new Error('恢复授权目录变化');});if(!sameDirectory(readTagPhysicalIdentity(value.parent),request.expected.parent))throw new Error('恢复源父目录变化');
 const [original,backup,temporary,victim,replacement,displaced]=files,[source,,target]=request.baseline.files;
 if(!sameFile(backup,request.expected.files[1])||canonical(temporary)!==canonical(request.expected.files[2]))throw new Error('恢复期间备份或临时文件变化');
 if(stage===0){if(value.policy!==null||files.slice(0,4).some((f,i)=>canonical(f)!==canonical(request.expected.files[i]))||replacement.state!=='missing'||displaced.state!=='missing')throw new Error('恢复锁定证明与核对基准不符');}
 else {
  const policy=readPolicy(value.policy,request),chosen=request.mode==='victim'?victim:replacement,destination=stage>=4?original:chosen;
  if(!sameContent(destination,source)||!destination.identity||destination.identity.creation!==policy.creation||destination.identity.modified!==policy.modified||request.mode==='victim'&&!sameFile(destination,request.expected.files[3]))throw new Error('恢复实际来源或时间不符合冻结文件');
  if(request.mode==='backup'&&(destination.identity.volume!==request.expected.parent.volume||destination.identity.fileId===request.expected.files[1].identity!.fileId&&destination.identity.volume===request.expected.files[1].identity!.volume||request.baseline.files.some(f=>f.identity&&sameObject(destination.identity!,f.identity))))throw new Error('备份恢复没有独立的新物理文件');
  if(stage<3){if(canonical(original)!==canonical(request.expected.files[0])||displaced.state!=='missing')throw new Error('恢复意图前原文件变化');}
  else if(request.expected.files[0].state==='present'){if(!sameFile(displaced,target))throw new Error('已有目标没有完整保留');}
  else if(displaced.state!=='missing')throw new Error('原路径本来缺失，不应出现被移走文件');
  if(stage===3&&original.state!=='missing')throw new Error('恢复来源移动前原路径必须为空');
  if(stage>=4){if(request.mode==='victim'&&victim.state!=='missing'||request.mode==='backup'&&replacement.state!=='missing')throw new Error('恢复后的来源名称不符');}
  if(request.mode==='victim'&&replacement.state!=='missing')throw new Error('旧文件恢复不能创建备份副本');
  if(request.mode==='backup'&&canonical(victim)!==canonical(request.expected.files[3]))throw new Error('备份恢复更改了保留旧文件');
 }
 return value as unknown as TagRestoreProof;
}
export function assertTagRestoreTransition(proof:TagRestoreProof,request:TagRestoreRequest,phase:TagRestorePhase,previous:TagRestoreProof[]):void {
 readTagRestoreProof(proof,request,phase);const index=TAG_RESTORE_PHASES.indexOf(phase);if(previous.length!==index)throw new Error('恢复证明链存在阶段缺口');
 if(index<2)return;const before=previous.at(-1)!;if(canonical(proof.policy)!==canonical(before.policy))throw new Error('恢复策略在阶段之间变化');
 const chosen=(value:TagRestoreProof,stage:number)=>value.files[stage>=4?0:request.mode==='victim'?3:4];
 if(!sameObject(chosen(proof,index).identity!,chosen(before,index-1).identity!))throw new Error('恢复来源物理身份在阶段之间变化');
}
export function readTagRestoreMessage(value:unknown,request:TagRestoreRequest,last:number,phases:number):TagRestoreMessage {
 if(!value||typeof value!=='object')throw new Error('恢复回执无效');const r=value as Record<string,unknown>,base=['version','operationId','sequence','kind'];
 if(r.version!==request.version||r.operationId!==request.operationId||r.sequence!==last+1||!Number.isSafeInteger(r.sequence)||Number(r.sequence)>131072)throw new Error('恢复回执身份或顺序无效');
 if(r.kind==='progress'){if(!tagWriteKeys(r,[...base,'role','bytes','total'])||!TAG_RESTORE_ROLES.includes(r.role as TagRestoreRole)||!tagWriteInteger(r.bytes)||!tagWriteInteger(r.total)||BigInt(r.total)>68719476736n||BigInt(r.bytes)>BigInt(r.total))throw new Error('恢复进度无效');}
 else if(r.kind==='stage'){if(!tagWriteKeys(r,[...base,'phase','proof'])||r.phase!==TAG_RESTORE_PHASES[phases])throw new Error('恢复阶段跳跃或重复');readTagRestoreProof(r.proof,request,TAG_RESTORE_PHASES[phases]);}
 else if(r.kind==='done'){if(!tagWriteKeys(r,[...base,'proof'])||phases!==TAG_RESTORE_PHASES.length)throw new Error('恢复阶段尚未全部确认');readTagRestoreProof(r.proof,request,'verified');}
 else if(r.kind==='error'){if(!tagWriteKeys(r,[...base,'message'])||typeof r.message!=='string'||!r.message||r.message.length>512)throw new Error('恢复错误回执无效');}else throw new Error('未知恢复回执');
 return r as unknown as TagRestoreMessage;
}
