import {promises as fs} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readTagWritePlan,readTagWriteFileEvidence,tagWriteUuid,type TagWritePlan,type TagWriteFileEvidence} from '../shared/tag-write.js';
import {insideMediaRoot,mediaStat,sameMediaStat,type MediaStat} from './media-worker-protocol.js';
import {readFlacMetadataPrefix} from './flac-tag-worker.js';
import {rewriteFlacMetadata} from './flac-tag-adapter.js';
const chunkBytes=4*1024*1024;
const normal=(v:string)=>process.platform==='win32'?v.toLowerCase():v;
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const equal=(a:TagWriteFileEvidence,b:TagWriteFileEvidence)=>JSON.stringify(readTagWriteFileEvidence(a))===JSON.stringify(readTagWriteFileEvidence(b));
export interface FlacStageRequest {
 plan:TagWritePlan;source:TagWriteFileEvidence;rootPath:string;realRootPath:string;sourcePath:string;before:MediaStat;
 backupDir:string;backupArtifactId:string;tempArtifactId:string;
}
export interface FlacStageArtifacts {backupPath:string;temporaryPath:string;backup:TagWriteFileEvidence;temporary:TagWriteFileEvidence}
export interface FlacStageCallbacks {
 backupReady:(artifactId:string,evidence:TagWriteFileEvidence)=>Promise<void>;
 tempWritten:(artifactId:string,evidence:TagWriteFileEvidence)=>Promise<void>;
 progress?:(phase:'backup'|'temporary'|'verify',bytes:string,total:string)=>void;
}
async function write(handle:FileHandle,buffer:Buffer):Promise<void>{let at=0;while(at<buffer.length){const {bytesWritten}=await handle.write(buffer,at,buffer.length-at,null);if(!bytesWritten)throw new Error('标签工件写入不完整');at+=bytesWritten;}}
export async function hashFlacFile(handle:FileHandle,fileBytes:number,signal:AbortSignal,progress?:(bytes:number,total:number)=>void):Promise<TagWriteFileEvidence>{
 signal.throwIfAborted();const before=mediaStat(await handle.stat());if(before.size!==fileBytes)throw new Error('FLAC 大小已变化');
 const prefix=await readFlacMetadataPrefix(handle,fileBytes),full=createHash('sha256'),audio=createHash('sha256'),buffer=Buffer.alloc(chunkBytes);let at=0;
 while(at<fileBytes){signal.throwIfAborted();const wanted=Math.min(buffer.length,fileBytes-at),{bytesRead}=await handle.read(buffer,0,wanted,at);if(!bytesRead)throw new Error('FLAC 哈希读取不完整');const b=buffer.subarray(0,bytesRead);full.update(b);const from=Math.max(0,prefix.length-at);if(from<bytesRead)audio.update(b.subarray(from));at+=bytesRead;progress?.(at,fileBytes);}
 if(!sameMediaStat(before,mediaStat(await handle.stat())))throw new Error('FLAC 哈希读取期间变化');
 return readTagWriteFileEvidence({sha256:full.digest('hex'),audioSha256:audio.digest('hex'),metadataSha256:createHash('sha256').update(prefix).digest('hex'),byteLength:String(fileBytes),audioOffset:String(prefix.length),audioBytes:String(fileBytes-prefix.length)});
}
async function checkedDirectory(value:string):Promise<string>{
 if(!path.isAbsolute(value))throw new Error('标签工件目录必须为绝对路径');const stat=await fs.lstat(value),real=await fs.realpath(value);
 if(!stat.isDirectory()||stat.isSymbolicLink()||normal(real)!==normal(path.resolve(value)))throw new Error('标签工件目录不可确认');return real;
}
// Internal worker core, not a Renderer API. It only creates exclusive backup/temp
// artifacts. Replacement must be separately leased and format-certified.
export async function stageFlacTagArtifacts(input:FlacStageRequest,callbacks:FlacStageCallbacks,signal:AbortSignal):Promise<FlacStageArtifacts>{
 const plan=readTagWritePlan(input.plan),expected=readTagWriteFileEvidence(input.source);
 if(!tagWriteUuid(input.backupArtifactId)||!tagWriteUuid(input.tempArtifactId)||input.backupArtifactId===input.tempArtifactId||![input.rootPath,input.realRootPath,input.sourcePath,input.backupDir].every(v=>typeof v==='string'&&path.isAbsolute(v))||expected.metadataSha256!==plan.preview.sourceMetadataSha256||expected.byteLength!==plan.preview.sourceFileBytes||expected.audioOffset!==plan.preview.sourceAudioOffset||expected.audioBytes!==plan.preview.audioBytes)throw new Error('FLAC 暂存请求不属于冻结计划');
 signal.throwIfAborted();const root=await fs.realpath(input.rootPath);if(normal(root)!==normal(input.realRootPath)||!insideMediaRoot(normal(root),normal(await fs.realpath(input.sourcePath))))throw new Error('FLAC 来源越过授权目录');
 const initial=await fs.lstat(input.sourcePath);if(!initial.isFile()||initial.isSymbolicLink()||initial.nlink!==1||!sameMediaStat(input.before,mediaStat(initial)))throw new Error('FLAC 来源已变化或有多个硬链接');
 const parent=await checkedDirectory(path.dirname(input.sourcePath)),backupDir=await checkedDirectory(input.backupDir);
 const backupPath=path.join(backupDir,`${plan.jobId}-${input.backupArtifactId}.bak`),temporaryPath=path.join(parent,`.aural-${plan.jobId}-${input.tempArtifactId}.tmp`);
 for(const filename of [backupPath,temporaryPath]){try{await fs.lstat(filename);throw new Error('写回工件已存在，必须回读和恢复原操作');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 // Reserve estimates include the backup and the complete future FLAC file.
 // This is advisory space evidence; full-disk writes still fail and retain artifacts.
 const backupSpace=await fs.statfs(backupDir,{bigint:true}),tempSpace=await fs.statfs(parent,{bigint:true}),backupSize=BigInt(expected.byteLength),tempSize=BigInt(plan.preview.targetFileBytes);
 const sharedVolume=initial.dev===(await fs.stat(backupDir)).dev;
 if(backupSpace.bavail*backupSpace.bsize<(sharedVolume?backupSize+tempSize:backupSize)||tempSpace.bavail*tempSpace.bsize<(sharedVolume?backupSize+tempSize:tempSize))throw new Error('备份与临时文件空间不足');
 const source=await fs.open(input.sourcePath,'r');
 let lastProgress=performance.now()-250;
 const report=(phase:'backup'|'temporary'|'verify',at:number,total:number)=>{const now=performance.now();if(now-lastProgress>=250||at===total){lastProgress=now;callbacks.progress?.(phase,String(at),String(total));}};
 const verify=(at:number,total:number)=>report('verify',at,total);
 try{
  const checkSource=async()=>{signal.throwIfAborted();const handleStat=await source.stat(),named=await fs.lstat(input.sourcePath);if(!handleStat.isFile()||!named.isFile()||named.isSymbolicLink()||named.nlink!==1||!sameMediaStat(input.before,mediaStat(handleStat))||!sameMediaStat(input.before,mediaStat(named))||normal(await fs.realpath(input.rootPath))!==normal(root)||!insideMediaRoot(normal(root),normal(await fs.realpath(input.sourcePath)))||normal(await fs.realpath(path.dirname(input.sourcePath)))!==normal(parent)||normal(await fs.realpath(input.backupDir))!==normal(backupDir))throw new Error('FLAC 来源或目录在暂存期间变化');};
  await checkSource();const actual=await hashFlacFile(source,Number(expected.byteLength),signal,verify);if(!equal(actual,expected))throw new Error('FLAC 原始全文件或音频哈希改变');
  const prefix=await readFlacMetadataPrefix(source,Number(expected.byteLength)),rewrite=rewriteFlacMetadata(prefix,expected.audioBytes,plan.changes);
  if(canonical(rewrite.preview)!==canonical(plan.preview))throw new Error('FLAC 暂存与冻结差异不符');
  const buffer=Buffer.alloc(chunkBytes);
  const copy=async(target:FileHandle,start:number,end:number,phase:'backup'|'temporary')=>{let at=start;while(at<end){signal.throwIfAborted();const {bytesRead}=await source.read(buffer,0,Math.min(buffer.length,end-at),at);if(!bytesRead)throw new Error('FLAC 暂存源读取不完整');await write(target,buffer.subarray(0,bytesRead));at+=bytesRead;report(phase,at-start,end-start);}signal.throwIfAborted();await target.sync();};
  const checkArtifact=async(filename:string,handle:FileHandle)=>{const named=await fs.lstat(filename),opened=await handle.stat();if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1||!sameMediaStat(mediaStat(named),mediaStat(opened))||normal(await fs.realpath(filename))!==normal(path.resolve(filename)))throw new Error('FLAC 工件路径或文件绑定已变化');};
  const backupHandle=await fs.open(backupPath,'wx+',0o600);let backup:TagWriteFileEvidence;
  try{await copy(backupHandle,0,Number(expected.byteLength),'backup');backup=await hashFlacFile(backupHandle,Number(expected.byteLength),signal,verify);if(!equal(backup,expected))throw new Error('FLAC 备份回读校验失败');await checkArtifact(backupPath,backupHandle);}finally{await backupHandle.close();}
  await checkSource();if(!equal(await hashFlacFile(source,Number(expected.byteLength),signal,verify),expected))throw new Error('FLAC 备份后原文件改变');
  await callbacks.backupReady(input.backupArtifactId,backup);signal.throwIfAborted();await checkSource();
  const tempHandle=await fs.open(temporaryPath,'wx+',0o600);let temporary:TagWriteFileEvidence;
  try{await write(tempHandle,rewrite.prefix);await copy(tempHandle,Number(expected.audioOffset),Number(expected.byteLength),'temporary');temporary=await hashFlacFile(tempHandle,Number(plan.preview.targetFileBytes),signal,verify);
   const fresh=await readFlacMetadataPrefix(tempHandle,Number(plan.preview.targetFileBytes)),roundtrip=rewriteFlacMetadata(fresh,expected.audioBytes,plan.changes);
   if(roundtrip.preview.changed||temporary.audioSha256!==expected.audioSha256||temporary.audioBytes!==expected.audioBytes||temporary.metadataSha256!==plan.preview.targetMetadataSha256||temporary.byteLength!==plan.preview.targetFileBytes)throw new Error('FLAC 临时文件标签或音频回读失败');
   await checkArtifact(temporaryPath,tempHandle);
  }finally{await tempHandle.close();}
  await checkSource();if(!equal(await hashFlacFile(source,Number(expected.byteLength),signal,verify),expected))throw new Error('FLAC 暂存后原文件改变');
  await callbacks.tempWritten(input.tempArtifactId,temporary);signal.throwIfAborted();return {backupPath,temporaryPath,backup,temporary};
 }finally{await source.close();} // No deletion: partial files are recovery evidence.
}
