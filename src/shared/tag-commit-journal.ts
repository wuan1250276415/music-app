import {tagWriteKeys,tagWriteUuid,tagWriteHash,readTagWritePlan,readTagWriteFileEvidence,type TagWritePlan} from './tag-write.js';
import {readTagCommitRequest,readTagCommitMessage,type TagCommitRequest,type TagCommitMessage,type TagCommitProof} from './tag-commit.js';
export interface TagCommitStart {commandId:string;jobId:string;baseRevision:number;certificateId:string;confirmed:true}
export interface TagCommitBinding {version:1;executionId:string;stagingJournalSha256:string;plan:TagWritePlan;request:TagCommitRequest}
export type TagCommitStageMessage=Extract<TagCommitMessage,{kind:'stage'}>;
export interface TagCommitJournalSnapshot {binding:TagCommitBinding;revision:number;sha256:string;hashes:string[];stages:TagCommitStageMessage[]}
export interface TagCommitView {id:string;state:'reserved'|'running'|'native_verified'|'recovery_required'|'committed'|'reconciled';phase:string;bytes:string;total:string;exitConfirmed:boolean;reason:string}
export const tagCommitCanonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export function readTagCommitStart(v:unknown):TagCommitStart {if(!tagWriteKeys(v,['commandId','jobId','baseRevision','certificateId','confirmed'])||!tagWriteUuid(v.commandId)||!tagWriteUuid(v.jobId)||!Number.isSafeInteger(v.baseRevision)||Number(v.baseRevision)<0||!tagWriteHash(v.certificateId)||v.confirmed!==true)throw new Error('文件提交请求无效，请先确认此文件的标签差异');return {commandId:v.commandId.toLowerCase(),jobId:v.jobId.toLowerCase(),baseRevision:Number(v.baseRevision),certificateId:v.certificateId,confirmed:true};}
export function readTagCommitBinding(v:unknown):TagCommitBinding {
 if(!tagWriteKeys(v,['version','executionId','stagingJournalSha256','plan','request'])||v.version!==1||!tagWriteUuid(v.executionId)||!tagWriteHash(v.stagingJournalSha256))throw new Error('提交日志初始绑定无效');
 const plan=readTagWritePlan(v.plan),request=readTagCommitRequest(v.request,false);
 if(plan.jobId!==request.jobId||plan.certificateId!==request.certificateId)throw new Error('提交认证计划与实际请求不符');
 const [source,backup,target]=request.expected.files.map(f=>readTagWriteFileEvidence(f.flac)),preview=plan.preview;
 if(tagCommitCanonical(source)!==tagCommitCanonical(backup)||source.metadataSha256!==preview.sourceMetadataSha256||source.byteLength!==preview.sourceFileBytes||source.audioOffset!==preview.sourceAudioOffset||source.audioBytes!==preview.audioBytes||target.metadataSha256!==preview.targetMetadataSha256||target.byteLength!==preview.targetFileBytes||target.audioOffset!==preview.targetAudioOffset||target.audioSha256!==source.audioSha256||target.audioBytes!==source.audioBytes)throw new Error('提交日志的源文件、备份或目标不属于冻结差异');
 return {version:1,executionId:v.executionId,stagingJournalSha256:v.stagingJournalSha256,plan,request};
}
export function readTagCommitStage(v:unknown,binding:TagCommitBinding,stages:TagCommitStageMessage[]):TagCommitStageMessage {
 if(!v||typeof v!=='object'||!Number.isSafeInteger((v as {sequence:unknown}).sequence)||Number((v as {sequence:unknown}).sequence)<1||Number((v as {sequence:unknown}).sequence)<=(stages.at(-1)?.sequence??0))throw new Error('提交日志阶段顺序无效');
 const sequence=Number((v as {sequence:number}).sequence),stage=readTagCommitMessage(v,binding.request,sequence-1,stages.length);if(stage.kind!=='stage')throw new Error('提交日志只接受关键阶段');
 const first=stages[0],intent=stages[1];if(first&&['volume','fileId','creation'].some(key=>stage.proof.parent[key as keyof typeof stage.proof.parent]!==first.proof.parent[key as keyof typeof first.proof.parent]))throw new Error('提交阶段的固定父目录不一致');
 if(intent&&tagCommitCanonical(stage.proof.policy)!==tagCommitCanonical(intent.proof.policy))throw new Error('提交阶段权限与时间政策变化');return stage;
}
export function readTagCommitFinalProof(v:unknown,binding:TagCommitBinding,stages:TagCommitStageMessage[]):TagCommitProof {
 const final=stages.at(-1);if(stages.length!==5||final?.phase!=='verified'||tagCommitCanonical(v)!==tagCommitCanonical(final.proof))throw new Error('提交退出结果与最终持久阶段不符');return final.proof;
}
