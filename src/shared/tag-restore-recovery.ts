import {tagWriteKeys,tagWriteUuid,tagWriteHash,tagWriteInteger} from './tag-write.js';
import {readTagPhysicalIdentity,readTagArtifactInspection,type TagPhysicalIdentity} from './tag-recovery.js';
import {TAG_RESTORE_ROLES,TAG_RESTORE_PHASES,type TagRestoreRole,type TagRestoreArtifact,type TagRestorePhase} from './tag-restore.js';
import {readTagRestoreBinding,readTagRestoreStage,type TagRestoreBinding,type TagRestoreJournalSnapshot} from './tag-restore-journal.js';
import {tagCommitCanonical} from './tag-commit-journal.js';

export interface TagRestoreInspectionRequest {version:3;kind:'inspect-restore';inspectionId:string;sourceRoot:string;backupRoot:string;files:Array<{role:TagRestoreRole;path:string}>}
export interface TagRestoreInspectionResult {files:TagRestoreArtifact[];roots:TagPhysicalIdentity[];parent:TagPhysicalIdentity;exclusiveRead:true}
export type TagRestoreInspectionMessage={version:3;inspectionId:string;sequence:number}&(
 {kind:'progress';role:TagRestoreRole;bytes:string;total:string}|{kind:'done'}&TagRestoreInspectionResult|{kind:'error';message:string});
export type TagRestoreRecoveryClassification='unchanged-before-restore'|'source-prepared'|'copy-unconfirmed'|'target-displaced'|'restored-source'|'recovery-required'|'binding-unavailable'|'journal-unconfirmed'|'unstarted-restore';
export interface TagRestoreRecoveryReport {classification:TagRestoreRecoveryClassification;journal:'matched'|'fs-ahead'|'unconfirmed'|'absent';phase:TagRestorePhase|null;journalEvidence:{revision:number;sha256:string}|null;commitJournalSha256:string|null;stagingJournalSha256:string|null;reason:string;actual:TagRestoreInspectionResult}
export interface TagRestoreRecoveryView {id:string;operationId:string;state:'running'|'completed'|'cancelled'|'failed'|'interrupted';createdAt:string;updatedAt:string;exitConfirmed:boolean;phase:TagRestoreRole|null;bytes:string;total:string;error:string;report:TagRestoreRecoveryReport|null}

export function readTagRestoreInspectionRequest(value:unknown):TagRestoreInspectionRequest {
 if(!tagWriteKeys(value,['version','kind','inspectionId','sourceRoot','backupRoot','files'])||value.version!==3||value.kind!=='inspect-restore'||!tagWriteUuid(value.inspectionId)||!Array.isArray(value.files)||value.files.length!==6)throw new Error('六文件核对绑定无效');
 const paths=[value.sourceRoot,value.backupRoot,...value.files.map((f,i)=>{if(!tagWriteKeys(f,['role','path'])||f.role!==TAG_RESTORE_ROLES[i])throw new Error('六文件核对角色无效');return f.path;})];
 if(paths.some(p=>typeof p!=='string'||!p.length||p.length>32767||p.includes('\0')||!/^[a-z]:[\\/]/i.test(p)||p.slice(2).includes(':')||/[\\/]\.\.?([\\/]|$)/.test(p)))throw new Error('六文件核对要求固定本机路径');
 const [sourceRoot,backupRoot,...files]=paths.map(p=>String(p).replace(/\//g,'\\').replace(/\\+$/,'').toLowerCase()),parent=(p:string)=>p.slice(0,p.lastIndexOf('\\')),directory=parent(files[0]);
 if(new Set(files).size!==6||!files[0].endsWith('.flac')||files.some((f,i)=>!f.startsWith(`${i===1?backupRoot:sourceRoot}\\`)||parent(f)!==(i===1?backupRoot:directory)))throw new Error('六文件核对路径布局无效');
 return value as unknown as TagRestoreInspectionRequest;
}
export function readTagRestoreInspectionResult(value:unknown):TagRestoreInspectionResult {
 if(!tagWriteKeys(value,['files','roots','parent','exclusiveRead'])||value.exclusiveRead!==true||!Array.isArray(value.files)||value.files.length!==6||!Array.isArray(value.roots)||value.roots.length!==2)throw new Error('六文件核对快照无效');
 value.files.forEach((f,i)=>{if(!f||typeof f!=='object'||(f as {role:unknown}).role!==TAG_RESTORE_ROLES[i])throw new Error('六文件核对角色无效');readTagArtifactInspection({...f,role:'original'},'original');});
 value.roots.forEach(readTagPhysicalIdentity);readTagPhysicalIdentity(value.parent);return value as unknown as TagRestoreInspectionResult;
}
export function readTagRestoreInspectionMessage(value:unknown,id:string,last:number):TagRestoreInspectionMessage {
 if(!value||typeof value!=='object')throw new Error('六文件核对消息无效');const r=value as Record<string,unknown>,base=['version','inspectionId','sequence','kind'];
 if(r.version!==3||r.inspectionId!==id||r.sequence!==last+1||!Number.isSafeInteger(r.sequence)||Number(r.sequence)>131072)throw new Error('六文件核对消息身份或顺序无效');
 if(r.kind==='progress'){if(!tagWriteKeys(r,[...base,'role','bytes','total'])||!TAG_RESTORE_ROLES.includes(r.role as TagRestoreRole)||!tagWriteInteger(r.bytes)||!tagWriteInteger(r.total)||BigInt(r.total)>68719476736n||BigInt(r.bytes)>BigInt(r.total))throw new Error('六文件核对进度无效');}
 else if(r.kind==='done'){if(!tagWriteKeys(r,[...base,'files','roots','parent','exclusiveRead']))throw new Error('六文件最终核对消息无效');readTagRestoreInspectionResult({files:r.files,roots:r.roots,parent:r.parent,exclusiveRead:r.exclusiveRead});}
 else if(r.kind==='error'){if(!tagWriteKeys(r,[...base,'message'])||typeof r.message!=='string'||!r.message||r.message.length>512)throw new Error('六文件核对错误回执无效');}else throw new Error('未知六文件核对消息');return r as unknown as TagRestoreInspectionMessage;
}
export function readTagRestoreRecoveryReport(value:unknown):TagRestoreRecoveryReport {
 if(!tagWriteKeys(value,['classification','journal','phase','journalEvidence','commitJournalSha256','stagingJournalSha256','reason','actual'])||!['unchanged-before-restore','source-prepared','copy-unconfirmed','target-displaced','restored-source','recovery-required','binding-unavailable','journal-unconfirmed','unstarted-restore'].includes(String(value.classification))||!['matched','fs-ahead','unconfirmed','absent'].includes(String(value.journal))||typeof value.reason!=='string'||!value.reason||value.reason.length>1024)throw new Error('六文件恢复报告无效');
 readTagRestoreInspectionResult(value.actual);
 if(value.journal==='absent'){if(value.classification!=='unstarted-restore'||value.journalEvidence!==null||value.phase!==null||![value.commitJournalSha256,value.stagingJournalSha256].every(tagWriteHash))throw new Error('未开始恢复报告缺少原提交与暂存依据');}
 else if(value.journal==='unconfirmed'){if(value.journalEvidence!==null||value.commitJournalSha256!==null||value.stagingJournalSha256!==null||value.phase!==null||!['binding-unavailable','journal-unconfirmed'].includes(String(value.classification)))throw new Error('未核对恢复日志不能带已确认分类');}
 else if(!tagWriteKeys(value.journalEvidence,['revision','sha256'])||!Number.isSafeInteger(value.journalEvidence.revision)||Number(value.journalEvidence.revision)<0||Number(value.journalEvidence.revision)>6||![value.journalEvidence.sha256,value.commitJournalSha256,value.stagingJournalSha256].every(tagWriteHash)||value.phase!==(TAG_RESTORE_PHASES[Number(value.journalEvidence.revision)-1]??null)||['binding-unavailable','journal-unconfirmed','unstarted-restore'].includes(String(value.classification)))throw new Error('六文件恢复日志证据无效');
 return value as unknown as TagRestoreRecoveryReport;
}
const sameDirectory=(a:TagPhysicalIdentity,b:TagPhysicalIdentity)=>a.volume===b.volume&&a.fileId===b.fileId&&a.creation===b.creation;
const sameContent=(a:TagRestoreArtifact,b:{flac:TagRestoreArtifact['flac']})=>a.state==='present'&&a.reason===''&&a.flac!==null&&tagCommitCanonical(a.flac)===tagCommitCanonical(b.flac);
const sameFile=(a:TagRestoreArtifact,b:Omit<TagRestoreArtifact,'role'>)=>sameContent(a,b)&&a.identity!==null&&b.identity!==null&&a.identity.volume===b.identity.volume&&a.identity.fileId===b.identity.fileId&&a.identity.bytes===b.identity.bytes&&a.identity.creation===b.identity.creation&&a.identity.modified===b.identity.modified;
const sameArtifact=(a:TagRestoreArtifact,b:Omit<TagRestoreArtifact,'role'>)=>a.state==='missing'&&b.state==='missing'||sameFile(a,b);

export function assertTagRestoreInspectionEqual(before:TagRestoreInspectionResult,after:TagRestoreInspectionResult):void {
 readTagRestoreInspectionResult(before);readTagRestoreInspectionResult(after);
 if(before.files.some((f,i)=>tagCommitCanonical(f)!==tagCommitCanonical(after.files[i]))||before.roots.some((r,i)=>!sameDirectory(r,after.roots[i]))||!sameDirectory(before.parent,after.parent))throw new Error('六文件或授权目录已变化，请重新核对');
}
// A historical snapshot never permits moves, library writes, or read-gate release.
export function classifyTagRestoreRecovery(value:TagRestoreInspectionResult,bindingValue:TagRestoreBinding,journal:TagRestoreJournalSnapshot):TagRestoreRecoveryClassification {
 const actual=readTagRestoreInspectionResult(value),binding=readTagRestoreBinding(bindingValue),request=binding.request;
 if(tagCommitCanonical(binding)!==tagCommitCanonical(journal.binding)||journal.revision!==journal.stages.length||journal.revision<0||journal.revision>6||journal.hashes.length!==journal.revision+1||journal.hashes.some(h=>!tagWriteHash(h))||journal.sha256!==journal.hashes.at(-1))throw new Error('六文件分类缺少完整恢复日志');
 journal.stages.forEach((stage,i)=>readTagRestoreStage(stage,binding,journal.stages.slice(0,i)));
 if(actual.files.some(f=>!['present','missing'].includes(f.state))||actual.roots.some((r,i)=>!sameDirectory(r,request.expected.roots[i]))||!sameDirectory(actual.parent,request.expected.parent))return 'recovery-required';
 const [original,backup,temporary,victim,replacement,displaced]=actual.files,[source]=request.baseline.files,expected=request.expected.files,revision=journal.revision;
 if(!sameFile(backup,expected[1])||!sameArtifact(temporary,expected[2])||request.mode==='backup'&&!sameArtifact(victim,expected[3])||request.mode==='victim'&&replacement.state!=='missing')return 'recovery-required';
 const prepared=journal.stages[1]?.proof.files[request.mode==='victim'?3:4],candidate=request.mode==='victim'?victim:replacement;
 // Commit applies the original creation-time policy to the target. Its observed
 // destination identity, not the earlier temporary-file timestamps, is frozen here.
 const displacedMatches=expected[0].state==='missing'?displaced.state==='missing':sameFile(displaced,expected[0]);
 const originalBefore=sameArtifact(original,expected[0]),victimBefore=sameArtifact(victim,expected[3]);
 if(revision>=4&&sameContent(original,source)&&original.identity?.creation===source.identity?.creation&&original.identity?.modified===source.identity?.modified&&prepared&&sameFile(original,prepared)&&displacedMatches&&(request.mode==='victim'?victim.state==='missing':replacement.state==='missing'))return 'restored-source';
 if(revision>=3&&revision<=4&&original.state==='missing'&&prepared&&sameFile(candidate,prepared)&&displacedMatches)return 'target-displaced';
 if(revision<=3&&originalBefore&&victimBefore&&displaced.state==='missing'){
  if(revision>=2&&prepared&&sameFile(candidate,prepared))return 'source-prepared';
  if(revision<=1&&request.mode==='backup'&&replacement.state==='present')return 'copy-unconfirmed';
  if(revision<=1&&replacement.state==='missing')return 'unchanged-before-restore';
 }
 return 'recovery-required';
}
