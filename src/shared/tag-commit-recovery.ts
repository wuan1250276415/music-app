import {tagWriteKeys,tagWriteHash,tagWriteInteger,readTagWriteFileEvidence} from './tag-write.js';
import {readTagPhysicalIdentity,readTagArtifactInspection,type TagPhysicalIdentity,type TagArtifactInspection} from './tag-recovery.js';
import {readTagCommitBinding,tagCommitCanonical,type TagCommitBinding,type TagCommitJournalSnapshot} from './tag-commit-journal.js';
import type {TagCommitPhase} from './tag-commit.js';

export const TAG_COMMIT_INSPECTION_VERSION=2;
export const TAG_COMMIT_ARTIFACT_ROLES=['original','backup','temporary','victim'] as const;
export type TagCommitArtifactRole=typeof TAG_COMMIT_ARTIFACT_ROLES[number];
export interface TagCommitInspectionRequest {version:2;kind:'inspect-commit';inspectionId:string;sourceRoot:string;backupRoot:string;files:Array<{role:TagCommitArtifactRole;path:string}>}
export interface TagCommitInspectionResult {files:TagArtifactInspection<TagCommitArtifactRole>[];roots:TagPhysicalIdentity[];parent:TagPhysicalIdentity;exclusiveRead:true}
export type TagCommitInspectionMessage={version:2;inspectionId:string;sequence:number}&(
 {kind:'progress';role:TagCommitArtifactRole;bytes:string;total:string}|
 {kind:'done'}&TagCommitInspectionResult|
 {kind:'error';message:string});
export type TagCommitRecoveryClassification='unchanged-staged'|'victim-moved'|'replacement-observed'|'restore-available'|'recovery-required'|'binding-unavailable'|'journal-unconfirmed';
export interface TagCommitRecoveryReport {classification:TagCommitRecoveryClassification;journal:'matched'|'fs-ahead'|'unconfirmed';phase:TagCommitPhase|null;journalEvidence:{revision:number;sha256:string}|null;stagingJournalSha256:string|null;reason:string;actual:TagCommitInspectionResult}
export interface TagCommitRecoveryView {id:string;operationId:string;state:'running'|'completed'|'cancelled'|'failed'|'interrupted';createdAt:string;updatedAt:string;exitConfirmed:boolean;phase:TagCommitArtifactRole|null;bytes:string;total:string;error:string;report:TagCommitRecoveryReport|null}

export function readTagCommitInspectionResult(v:unknown):TagCommitInspectionResult {
 if(!tagWriteKeys(v,['files','roots','parent','exclusiveRead'])||v.exclusiveRead!==true||!Array.isArray(v.files)||v.files.length!==4||!Array.isArray(v.roots)||v.roots.length!==2)throw new Error('四工件核对快照结构无效');
 v.files.forEach((f,i)=>readTagArtifactInspection(f,TAG_COMMIT_ARTIFACT_ROLES[i]));v.roots.forEach(readTagPhysicalIdentity);readTagPhysicalIdentity(v.parent);return v as unknown as TagCommitInspectionResult;
}
export function readTagCommitInspectionMessage(v:unknown,id:string,last:number):TagCommitInspectionMessage {
 if(!v||typeof v!=='object')throw new Error('四工件核对消息无效');const r=v as Record<string,unknown>,common=['version','inspectionId','sequence','kind'];
 if(r.version!==2||r.inspectionId!==id||r.sequence!==last+1||!Number.isSafeInteger(r.sequence)||Number(r.sequence)>131072)throw new Error('四工件核对消息身份或顺序无效');
 if(r.kind==='progress'){
  if(!tagWriteKeys(r,[...common,'role','bytes','total'])||!TAG_COMMIT_ARTIFACT_ROLES.includes(r.role as TagCommitArtifactRole)||!tagWriteInteger(r.bytes)||!tagWriteInteger(r.total)||BigInt(r.total)>68719476736n||BigInt(r.bytes)>BigInt(r.total))throw new Error('四工件核对进度无效');
 }else if(r.kind==='error'){
  if(!tagWriteKeys(r,[...common,'message'])||typeof r.message!=='string'||!r.message||r.message.length>512)throw new Error('四工件核对错误回执无效');
 }else if(r.kind==='done'){
  if(!tagWriteKeys(r,[...common,'files','roots','parent','exclusiveRead']))throw new Error('四工件核对最终回执无效');readTagCommitInspectionResult({files:r.files,roots:r.roots,parent:r.parent,exclusiveRead:r.exclusiveRead});
 }else throw new Error('未知四工件核对消息');return r as unknown as TagCommitInspectionMessage;
}
export function readTagCommitRecoveryReport(v:unknown):TagCommitRecoveryReport {
 const phases=['locked','intent','victim_moved','replaced','verified'];
 if(!tagWriteKeys(v,['classification','journal','phase','journalEvidence','stagingJournalSha256','reason','actual'])||!['unchanged-staged','victim-moved','replacement-observed','restore-available','recovery-required','binding-unavailable','journal-unconfirmed'].includes(String(v.classification))||!['matched','fs-ahead','unconfirmed'].includes(String(v.journal))||typeof v.reason!=='string'||!v.reason||v.reason.length>1024)throw new Error('四工件恢复报告无效');
 readTagCommitInspectionResult(v.actual);
 if(v.journal==='unconfirmed'){
  if(v.journalEvidence!==null||v.stagingJournalSha256!==null||v.phase!==null||!['binding-unavailable','journal-unconfirmed'].includes(String(v.classification)))throw new Error('未确认日志不能带有已验证恢复分类');
 }else {
  if(!tagWriteKeys(v.journalEvidence,['revision','sha256'])||!Number.isSafeInteger(v.journalEvidence.revision)||Number(v.journalEvidence.revision)<0||Number(v.journalEvidence.revision)>5||!tagWriteHash(v.journalEvidence.sha256)||!tagWriteHash(v.stagingJournalSha256)||v.phase!==(phases[Number(v.journalEvidence.revision)-1]??null)||['binding-unavailable','journal-unconfirmed'].includes(String(v.classification)))throw new Error('四工件恢复日志证据无效');
 }
 return v as unknown as TagCommitRecoveryReport;
}
const sameObject=(a:TagPhysicalIdentity,b:TagPhysicalIdentity)=>a.volume===b.volume&&a.fileId===b.fileId;
const sameDirectory=(a:TagPhysicalIdentity,b:TagPhysicalIdentity)=>sameObject(a,b)&&a.creation===b.creation;
const sameFile=(a:TagArtifactInspection<TagCommitArtifactRole>,b:TagArtifactInspection)=>a.state==='present'&&a.reason===''&&a.identity!==null&&b.identity!==null&&sameObject(a.identity,b.identity)&&a.identity.bytes===b.identity.bytes&&a.flac!==null&&tagCommitCanonical(readTagWriteFileEvidence(a.flac))===tagCommitCanonical(readTagWriteFileEvidence(b.flac));

// A read-only snapshot explains files; it never authorizes restore/release or
// marks the metadata/library committed. Native actions must acquire fresh locks.
export function classifyTagCommitRecovery(value:TagCommitInspectionResult,bindingValue:TagCommitBinding,journal:TagCommitJournalSnapshot):TagCommitRecoveryClassification {
 const actual=readTagCommitInspectionResult(value),binding=readTagCommitBinding(bindingValue);
 if(tagCommitCanonical(binding)!==tagCommitCanonical(journal.binding)||actual.files.some(f=>f.state==='busy'||f.state==='unreadable'))return 'recovery-required';
 if(actual.roots.some((root,i)=>!sameDirectory(root,binding.request.expected.roots[i]))||journal.stages[0]&&!sameDirectory(actual.parent,journal.stages[0].proof.parent))return 'recovery-required';
 const [original,backup,temp,victim]=actual.files,[source,expectedBackup,target]=binding.request.expected.files;
 if(!sameFile(backup,expectedBackup))return 'recovery-required';
 const sourceOriginal=sameFile(original,source),sourceVictim=sameFile(victim,source),targetTemp=sameFile(temp,target),targetOriginal=sameFile(original,target);
 const phase=journal.revision;
 if(phase<2&&(!sourceOriginal||!targetTemp||victim.state!=='missing')||phase>=3&&!sourceVictim||phase>=4&&(!targetOriginal||temp.state!=='missing'))return 'recovery-required';
 if(sourceOriginal&&targetTemp&&victim.state==='missing'&&phase<=2)return 'unchanged-staged';
 if(original.state==='missing'&&sourceVictim&&targetTemp&&phase>=2&&phase<=3)return 'victim-moved';
 if(targetOriginal&&sourceVictim&&temp.state==='missing'&&phase>=3)return 'replacement-observed';
 // Incomplete layouts still need a separately confirmed native restore. Any
 // unexpected present artifact prevents even declaring a restore candidate.
 if(original.state==='missing'&&(victim.state==='missing'||sourceVictim)&&(temp.state==='missing'||targetTemp))return 'restore-available';
 return 'recovery-required';
}
