import {promises as fs} from 'node:fs';
import {fileObservation} from '../platform/file-observation.js';
import {probeWatchRoot,sameWatchAnchor} from '../platform/file-watcher.js';
import {mediaStat,sameMediaStat,insideMediaRoot} from './media-worker-protocol.js';
import {hashFlacFile,stageFlacTagArtifacts} from './flac-tag-staging.js';
import {readTagWorkerStart,readTagWorkerAck,tagWorkerFrame,TAG_WORKER_FRAME_LIMIT,type TagWorkerMessage,type TagWorkerStart,type TagWorkerStage} from './tag-write-worker-protocol.js';
import type {TagWriteFileEvidence} from '../shared/tag-write.js';

const abort=new AbortController(),decoder=new TextDecoder('utf-8',{fatal:true});let pending=Buffer.alloc(0),start:TagWorkerStart|null=null,sequence=0,ended=false;
let acknowledge:{sequence:number;resolve:()=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}|null=null;
function stop(e:Error):void {abort.abort(e);if(acknowledge){clearTimeout(acknowledge.timer);acknowledge.reject(e);acknowledge=null;}}
async function send(body:Record<string,unknown>):Promise<void> {
 if(!start)throw new Error('标签暂存尚未开始');const frame=tagWorkerFrame({version:1,executionId:start.executionId,sequence:++sequence,...body});
 await new Promise<void>((resolve,reject)=>process.stdout.write(frame,error=>error?reject(error):resolve()));
}
async function stage(stage:TagWorkerStage,evidence:TagWriteFileEvidence):Promise<void> {
 abort.signal.throwIfAborted();
 const ack=new Promise<void>((resolve,reject)=>{const next=sequence+1,timer=setTimeout(()=>{const error=new Error('阶段日志保存确认超时');stop(error);},30000);acknowledge={sequence:next,resolve,reject,timer};});
 try{await Promise.all([send({kind:'stage',stage,evidence}),ack]);abort.signal.throwIfAborted();}catch(e){stop(e instanceof Error?e:new Error(String(e)));throw e;}
}
let lastProgress=performance.now()-250;
function progress(phase:string,bytes:string,total:string):void {const now=performance.now();if(now-lastProgress<250&&bytes!==total)return;lastProgress=now;void send({kind:'progress',phase,bytes,total}).catch(e=>stop(e));}
async function run(request:TagWorkerStart):Promise<void> {
 try{
  const {binding:b}=request,anchor=await probeWatchRoot(b.rootPath);if(!sameWatchAnchor(anchor,b.rootAnchor)||!insideMediaRoot(b.realRootPath,await fs.realpath(b.fullPath)))throw new Error('标签暂存目录与冻结来源不符');
  const named=await fs.lstat(b.fullPath,{bigint:true});if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1n||fileObservation(named)!==b.fileObservation)throw new Error('标签暂存源文件与扫描观察不符');
  const handle=await fs.open(b.fullPath,'r');let source:TagWriteFileEvidence;
  try{if(!sameMediaStat(b.before,mediaStat(await handle.stat())))throw new Error('标签暂存源文件已变化');source=await hashFlacFile(handle,b.before.size,abort.signal,(n,total)=>progress('source',String(n),String(total)));}
  finally{await handle.close();}
  await stage('validated',source);
  const result=await stageFlacTagArtifacts({plan:request.plan,source,rootPath:b.rootPath,realRootPath:b.realRootPath,sourcePath:b.fullPath,before:b.before,backupDir:request.backupDir,backupArtifactId:request.backupArtifactId,tempArtifactId:request.tempArtifactId},{backupReady:(_id,value)=>stage('backup_ready',value),tempWritten:(_id,value)=>stage('temp_written',value),progress},abort.signal);
  if(!sameWatchAnchor(await probeWatchRoot(b.rootPath),b.rootAnchor)||fileObservation(await fs.lstat(b.fullPath,{bigint:true}))!==b.fileObservation)throw new Error('标签暂存结束时来源变化');
  await send({kind:'done',source,backup:result.backup,temporary:result.temporary});ended=true;process.stdin.destroy();process.exitCode=0;
 }catch(e){stop(e instanceof Error?e:new Error(String(e)));try{await send({kind:'error',message:String(e instanceof Error?e.message:e).slice(0,512)||'标签暂存失败'});}catch{}ended=true;process.stdin.destroy();process.exitCode=1;}
}
process.stdin.on('data',(chunk:Buffer)=>{
 if(ended){stop(new Error('标签暂存结束后收到消息'));return;}
 try{
  if(pending.length+chunk.length>TAG_WORKER_FRAME_LIMIT+4)throw new Error('标签暂存输入超过预算');pending=Buffer.concat([pending,chunk]);
  while(pending.length>=4){const size=pending.readUInt32LE();if(!size||size>(start?4096:TAG_WORKER_FRAME_LIMIT))throw new Error('标签暂存帧大小无效');if(pending.length<size+4)break;
   const value=JSON.parse(decoder.decode(pending.subarray(4,size+4)));pending=pending.subarray(size+4);
   if(!start){start=readTagWorkerStart(value);void run(start);}
   else {const ack=readTagWorkerAck(value);if(!acknowledge||ack.executionId!==start.executionId||ack.sequence!==acknowledge.sequence)throw new Error('标签暂存阶段确认顺序无效');const current=acknowledge;acknowledge=null;clearTimeout(current.timer);current.resolve();}
  }
 }catch(e){stop(e instanceof Error?e:new Error(String(e)));if(!start){process.exitCode=1;process.stdin.destroy();}}
});
process.stdin.on('end',()=>{if(!ended)stop(new Error('标签暂存输入已关闭'));});process.stdin.on('error',e=>stop(e));process.stdout.on('error',e=>stop(e));
