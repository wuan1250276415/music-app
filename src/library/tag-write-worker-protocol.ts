import path from 'node:path';
import {readTagWritePlan,readTagWriteFileEvidence,tagWriteKeys,tagWriteUuid,tagWriteHash,tagWriteInteger,type TagWritePlan,type TagWriteFileEvidence} from '../shared/tag-write.js';
import {insideMediaRoot,type MediaStat} from './media-worker-protocol.js';
import type {WatchAnchor} from '../shared/library-watch.js';
export const TAG_WORKER_VERSION=1 as const;
export const TAG_WORKER_FRAME_LIMIT=524288;
export type TagWorkerPhase='source'|'backup'|'temporary'|'verify';
export type TagWorkerStage='validated'|'backup_ready'|'temp_written';
export interface TagWorkerStart {
 version:1;kind:'start';executionId:string;plan:TagWritePlan;leaseId:string;leaseRevision:number;
 binding:{rootPath:string;realRootPath:string;rootAnchor:WatchAnchor;fullPath:string;relativePath:string;before:MediaStat;fileObservation:string};
 backupDir:string;backupArtifactId:string;tempArtifactId:string;
}
export type TagWorkerMessage={version:1;executionId:string;sequence:number}&(
 {kind:'progress';phase:TagWorkerPhase;bytes:string;total:string}|{kind:'stage';stage:TagWorkerStage;evidence:TagWriteFileEvidence}|
 {kind:'done';source:TagWriteFileEvidence;backup:TagWriteFileEvidence;temporary:TagWriteFileEvidence}|{kind:'error';message:string}
);
export interface TagWorkerAck {version:1;kind:'ack';executionId:string;sequence:number}
const integer=(v:unknown,min=0)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<Number.MAX_SAFE_INTEGER;
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!v.includes('\0');
export function readTagWorkerStart(value:unknown):TagWorkerStart {
 if(!tagWriteKeys(value,['version','kind','executionId','plan','leaseId','leaseRevision','binding','backupDir','backupArtifactId','tempArtifactId'])||value.version!==1||value.kind!=='start'||!tagWriteUuid(value.executionId)||!tagWriteUuid(value.leaseId)||!integer(value.leaseRevision,1)||!tagWriteUuid(value.backupArtifactId)||!tagWriteUuid(value.tempArtifactId)||value.backupArtifactId===value.tempArtifactId||!text(value.backupDir,32768)||!path.isAbsolute(value.backupDir))throw new Error('标签暂存请求身份无效');
 const plan=readTagWritePlan(value.plan);if(plan.certificateId!==null)throw new Error('暂存进程不接受文件替换认证或执行原文件替换');
 const b=value.binding;if(!tagWriteKeys(b,['rootPath','realRootPath','rootAnchor','fullPath','relativePath','before','fileObservation'])||!tagWriteHash(b.fileObservation))throw new Error('标签暂存来源绑定无效');
 for(const k of ['rootPath','realRootPath','fullPath'])if(!text(b[k],32768)||!path.isAbsolute(b[k] as string))throw new Error('标签暂存来源路径无效');
 if(!text(b.relativePath,32768)||path.isAbsolute(b.relativePath)||!insideMediaRoot(b.rootPath as string,b.fullPath as string)||path.resolve(b.rootPath as string,b.relativePath)!==path.resolve(b.fullPath as string))throw new Error('标签暂存来源越过授权范围');
 if(!tagWriteKeys(b.before,['size','mtimeMs','ctimeMs','dev','ino'])||!Object.values(b.before).every(v=>typeof v==='number'&&Number.isFinite(v))||!integer(b.before.size,1)||String(b.before.size)!==plan.preview.sourceFileBytes)throw new Error('标签暂存文件观察无效');
 const a=b.rootAnchor;if(!tagWriteKeys(a,['realPath','dev','ino'])||!text(a.realPath,32768)||!path.isAbsolute(a.realPath)||!['dev','ino'].every(k=>typeof a[k]==='string'&&/^\d{1,30}$/.test(a[k] as string))||path.resolve(a.realPath).toLowerCase()!==path.resolve(b.realRootPath as string).toLowerCase())throw new Error('标签暂存目录锚点无效');
 return {...structuredClone(value),plan} as unknown as TagWorkerStart;
}
export function readTagWorkerMessage(value:unknown,executionId:string,previous:number):TagWorkerMessage {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('标签暂存回执无效');const r=value as Record<string,unknown>;
 if(r.version!==1||r.executionId!==executionId||!integer(r.sequence,1)||r.sequence!==previous+1||typeof r.kind!=='string')throw new Error('标签暂存回执身份或顺序无效');
 const base=['version','executionId','sequence','kind'];
 if(r.kind==='progress'){
  if(!tagWriteKeys(r,[...base,'phase','bytes','total'])||!['source','backup','temporary','verify'].includes(String(r.phase))||!tagWriteInteger(r.bytes)||!tagWriteInteger(r.total)||BigInt(r.total)===0n||BigInt(r.bytes)>BigInt(r.total)||BigInt(r.total)>64n*1024n*1024n*1024n)throw new Error('标签暂存进度无效');
 }else if(r.kind==='stage'){
  if(!tagWriteKeys(r,[...base,'stage','evidence'])||!['validated','backup_ready','temp_written'].includes(String(r.stage)))throw new Error('标签暂存阶段无效');readTagWriteFileEvidence(r.evidence);
 }else if(r.kind==='done'){
  if(!tagWriteKeys(r,[...base,'source','backup','temporary']))throw new Error('标签暂存最终回执无效');for(const key of ['source','backup','temporary'])readTagWriteFileEvidence(r[key]);
 }else if(r.kind==='error'){
  if(!tagWriteKeys(r,[...base,'message'])||!text(r.message,512))throw new Error('标签暂存错误回执无效');
 }else throw new Error('标签暂存回执类型无效');return structuredClone(r) as unknown as TagWorkerMessage;
}
export function readTagWorkerAck(value:unknown):TagWorkerAck {
 if(!tagWriteKeys(value,['version','kind','executionId','sequence'])||value.version!==1||value.kind!=='ack'||!tagWriteUuid(value.executionId)||!integer(value.sequence,1))throw new Error('标签暂存确认回执无效');return structuredClone(value) as unknown as TagWorkerAck;
}
export function tagWorkerFrame(value:unknown,max=TAG_WORKER_FRAME_LIMIT):Buffer {const bytes=Buffer.from(JSON.stringify(value),'utf8');if(!bytes.length||bytes.length>max)throw new Error('标签暂存消息超过预算');const frame=Buffer.allocUnsafe(bytes.length+4);frame.writeUInt32LE(bytes.length);bytes.copy(frame,4);return frame;}
