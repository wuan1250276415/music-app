import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {stageCatalogBackupFile,inventoryCatalogBackupTree} from '../platform/catalog-backup-file.js';
import {inspectRestoreReview} from './catalog-restore-review.js';
import {CatalogRestoreCompatibilityInspector} from './catalog-restore-compatibility.js';
import type {CatalogRestoreCompatibility} from '../shared/catalog-restore-compatibility.js';
import {fileObservation} from '../platform/file-observation.js';
import {backupUuid,readRendererPendingSnapshot,CATALOG_BACKUP_PENDING_BYTES} from '../shared/catalog-backup.js';
import {RESTORE_FRAME_BYTES,readRestoreFile,readRestoreIdentity,readRestorePrepared,type CatalogRestorePrepared,type RestoreWorkerFrame,type RestoreFileEvidence} from '../shared/catalog-restore.js';
type Port={on:(event:'message',listener:(event:{data:unknown})=>void)=>void;postMessage:(v:RestoreWorkerFrame)=>void};
const port=(process as typeof process&{parentPort?:Port}).parentPort;if(!port)throw new Error('恢复须由独立受监督进程启动');
let started=false,operationId='',sequence=0;const abort=new AbortController();let ack:{sequence:number;resolve:()=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}|null=null;
const identity=(s:{dev:bigint;ino:bigint;birthtimeNs:bigint})=>`${s.dev}:${s.ino}:${s.birthtimeNs}`;
function send(v:RestoreWorkerFrame):void{if(Buffer.byteLength(JSON.stringify(v))>RESTORE_FRAME_BYTES)throw new Error('恢复消息超过预算');port!.postMessage(v);}
async function evidence(filename:string):Promise<RestoreFileEvidence>{const s=await fs.lstat(filename,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n)throw new Error('恢复来源不是普通单链接文件');return readRestoreFile({identity:identity(s),observation:fileObservation(s),bytes:Number(s.size)});}
async function run(v:Record<string,unknown>):Promise<void>{
 if((v.mode!=='stage'&&v.mode!=='check')||typeof v.parent!=='string'||!path.isAbsolute(v.parent))throw new Error('恢复进程启动参数无效');operationId=backupUuid(v.operationId);const parentIdentity=readRestoreIdentity(v.parentIdentity),parent=await fs.lstat(v.parent,{bigint:true});
 if(!parent.isDirectory()||parent.isSymbolicLink()||identity(parent)!==parentIdentity)throw new Error('恢复暂存父目录与登记不符');
 const options={signal:abort.signal,progress:(p:{phase:string;bytes:number;total:number})=>{const phase=p.phase==='hashing'?'inspecting':p.phase;if(phase==='verifying'||phase==='staging'||phase==='inspecting')send({operationId,sequence:sequence++,kind:'progress',phase,bytes:p.bytes,total:p.total});}};
 const inspector=new CatalogRestoreCompatibilityInspector();let compatibility:CatalogRestoreCompatibility|undefined;let prepared:CatalogRestorePrepared;
 if(v.mode==='stage'){
  if(Object.keys(v).length!==7||typeof v.filename!=='string'||!path.isAbsolute(v.filename))throw new Error('恢复提取参数无效');const expected=readRestoreFile(v.source);if(JSON.stringify(await evidence(v.filename))!==JSON.stringify(expected))throw new Error('恢复来源与原登记不符');
  const staged=await stageCatalogBackupFile(v.filename,v.parent,{...options,inspectDatabase:(filename,manifest)=>{send({operationId,sequence:sequence++,kind:'progress',phase:'inspecting',bytes:0,total:manifest.files.find(f=>f.role==='database')!.bytes});compatibility=inspector.inspect(filename,manifest,abort.signal);}});abort.signal.throwIfAborted();
  if(JSON.stringify(await evidence(v.filename))!==JSON.stringify(expected))throw new Error('恢复来源在校验期间变化');const stageStat=await fs.lstat(staged.stagePath,{bigint:true});if(!stageStat.isDirectory()||stageStat.isSymbolicLink())throw new Error('恢复暂存不是普通目录');prepared={...staged,operationId,stageIdentity:identity(stageStat),source:expected};
 }else{
  if(Object.keys(v).length!==6)throw new Error('恢复暂存核对参数无效');prepared=readRestorePrepared(v.prepared);if(prepared.operationId!==operationId||path.dirname(prepared.stagePath)!==v.parent)throw new Error('恢复暂存核对来源无效');
  const before=await fs.lstat(prepared.stagePath,{bigint:true});if(!before.isDirectory()||before.isSymbolicLink()||identity(before)!==prepared.stageIdentity)throw new Error('恢复暂存目录身份已变化');
  abort.signal.throwIfAborted();compatibility=inspector.inspect(path.join(prepared.stagePath,'library','library.db'),prepared.manifest,abort.signal);abort.signal.throwIfAborted();

 }
 abort.signal.throwIfAborted();send({operationId,sequence:sequence++,kind:'progress',phase:'inspecting',bytes:prepared.bytes,total:prepared.bytes});
 if(!compatibility)throw new Error('恢复兼容性检查没有完成报告');
 abort.signal.throwIfAborted();
 if(identity(await fs.lstat(prepared.stagePath,{bigint:true}))!==prepared.stageIdentity||identity(await fs.lstat(v.parent,{bigint:true}))!==parentIdentity)throw new Error('恢复暂存或父目录在核对期间变化');
 const pendingPath=path.join(prepared.stagePath,'state','renderer-pending.json'),pendingStat=await fs.lstat(pendingPath,{bigint:true});if(!pendingStat.isFile()||pendingStat.isSymbolicLink()||pendingStat.nlink!==1n||pendingStat.size>BigInt(CATALOG_BACKUP_PENDING_BYTES))throw new Error('恢复待核对资料类型无效');
 const pendingHandle=await fs.open(pendingPath,'r');let pendingValues:number;let pendingKeys:string[];
 try{
  if(fileObservation(await pendingHandle.stat({bigint:true}))!==fileObservation(pendingStat))throw new Error('恢复待核对资料在打开期间变化');
  const raw=Buffer.alloc(Number(pendingStat.size));let at=0;while(at<raw.length){const read=await pendingHandle.read(raw,at,raw.length-at,at);if(!read.bytesRead)throw new Error('恢复待核对资料截断');at+=read.bytesRead;}
  const expectedPending=prepared.manifest.files.find(f=>f.path==='state/renderer-pending.json')!;
  if(createHash('sha256').update(raw).digest('hex')!==expectedPending.sha256||raw.length!==expectedPending.bytes||fileObservation(await pendingHandle.stat({bigint:true}))!==fileObservation(pendingStat)||fileObservation(await fs.lstat(pendingPath,{bigint:true}))!==fileObservation(pendingStat))throw new Error('恢复待核对资料与已校验清单不符');
  const pending=readRendererPendingSnapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));pendingValues=pending.values.length;pendingKeys=pending.values.map(value=>value.key);
 }finally{await pendingHandle.close();}
 const review=await inspectRestoreReview(path.join(prepared.stagePath,'library','library.db'),prepared.manifest,pendingKeys,abort.signal);
 const files=await inventoryCatalogBackupTree(prepared.stagePath,options);abort.signal.throwIfAborted();if(JSON.stringify(files)!==JSON.stringify(prepared.manifest.files)||identity(await fs.lstat(prepared.stagePath,{bigint:true}))!==prepared.stageIdentity||identity(await fs.lstat(v.parent,{bigint:true}))!==parentIdentity)throw new Error('审核后的恢复暂存与原完整清单不符');
 const frame:RestoreWorkerFrame={operationId,sequence:sequence++,kind:'done',result:prepared,pendingValues,compatibility,review};
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{ack=null;reject(new Error('恢复暂存回执未确认'));},15000);ack={sequence:frame.sequence,resolve,reject,timer};send(frame);});process.exit(0);
}
port.on('message',event=>{const v=event.data as Record<string,unknown>;if(!v||typeof v!=='object'||Array.isArray(v))return;
 if(!started&&v.kind==='begin'){started=true;void run(v).catch(error=>{try{send({operationId,sequence:sequence++,kind:'error',message:String(error instanceof Error?error.message:error).slice(0,1024)||'恢复暂存失败'});}finally{process.exit(1);}});}
 else if(v.kind==='ack'&&Object.keys(v).length===3&&v.operationId===operationId&&v.sequence===ack?.sequence&&ack){const a=ack;ack=null;clearTimeout(a.timer);a.resolve();}
 else if(v.kind==='cancel'&&Object.keys(v).length===2&&v.operationId===operationId){abort.abort(new Error('恢复预览已取消'));if(ack){const a=ack;ack=null;clearTimeout(a.timer);a.reject(new Error('恢复预览已取消'));}}
});
