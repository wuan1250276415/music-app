import {AUDIO_EXTENSIONS} from '../shared/media-formats.js';
import {FileReadGate} from './file-read-gate.js';
import {probeWatchRoot,sameWatchAnchor} from '../platform/file-watcher.js';
import {promises as fs,type Stats} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as waitStable} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {fileObservation,FILE_STABLE_MS,validFileObservation} from './file-observation.js';
import type {FileHandle} from 'node:fs/promises';
import type {LibraryDatabase} from './database.js';
import {ScanCancelled,type ScanEntry,type ScanInventoryEntry} from './scan-jobs.js';
import {MediaParser,MediaWorkerUnavailable,MediaWorkerExitUnconfirmed} from './media-worker-client.js';
import {mediaStat,MediaBoundaryError} from './media-worker-protocol.js';
import type {ParsedFile} from './database.js';
import {resolveCueReference,type CueEntry} from './cue.js';
import {embeddedCueView} from './flac-cue-text.js';
import type {ScanJob,ScanJobCommand,ScanJobResult,ScanState} from '../shared/contracts.js';

const extensions=new Set<string>(AUDIO_EXTENSIONS.map(ext=>`.${ext}`));
class ScanBoundaryError extends Error{}
class ScanMaintenanceInterrupted extends Error{}
const normalizePath=(value:string)=>process.platform==='win32'?value.toLocaleLowerCase():value;
function inside(root:string,value:string):boolean{const rel=path.relative(root,value);return rel===''||!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${path.sep}`);}
function sameStat(a:Stats,b:Stats):boolean{return a.isFile()&&b.isFile()&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.dev===b.dev&&a.ino===b.ino;}

const delayTurn=()=>new Promise<void>(resolve=>setImmediate(resolve));
export class ScanManager{
 private readonly mediaReads=new FileReadGate();
 quiesceFile(filename:string,owner:string):Promise<void>{return this.mediaReads.quiesce(filename,owner);}
 releaseFile(filename:string,owner:string):void{this.mediaReads.release(filename,owner);}
 releaseRecoveredFile(filename:string,owner:string):void{this.mediaReads.releaseRecovered(filename,owner);}
 private readonly owner=randomUUID();
 private readonly sampleEpoch=Date.now();private readonly sampleOrigin=performance.now();
 private sampleTime():number{return Math.trunc(this.sampleEpoch+performance.now()-this.sampleOrigin);}
 private busy=false;
 private halted=false;
 private maintenanceOwner:string|null=null;private flight:Promise<void>|null=null;
 async beginMaintenance(owner:string):Promise<void>{
  if(!owner||this.maintenanceOwner&&this.maintenanceOwner!==owner)throw new Error('扫描维护身份不符');this.maintenanceOwner=owner;
  this.active?.controller.abort(new ScanMaintenanceInterrupted('曲库维护暂停扫描'));await this.flight;
  await this.mediaReads.quiesceAll(owner);if(this.busy||this.active||this.halted)throw new Error('扫描或媒体监督尚未确认退出，不能建立快照');
 }
 endMaintenance(owner:string):void{if(this.maintenanceOwner!==owner||this.busy||this.active||this.halted)throw new Error('扫描维护尚未完成或身份不符');this.mediaReads.releaseAll(owner);this.maintenanceOwner=null;this.pump();}
 private lastEmit=0;
 private active:{id:string;controller:AbortController}|null=null;
 private waiters=new Map<string,Array<()=>void>>();
 private readonly parser:MediaParser;
 constructor(private readonly db:LibraryDatabase,private readonly publish:(state:ScanState)=>void,private readonly changed:(id:string,final:boolean)=>void,mediaWorkerPath?:string|MediaParser){this.parser=mediaWorkerPath instanceof MediaParser?mediaWorkerPath:new MediaParser(mediaWorkerPath);}
 recover():void{this.db.scanJobs.recover();this.pump();}
 command(value:ScanJobCommand,authorizedRealPath?:string):ScanJobResult{
  let result:ScanJobResult;
  try{result=this.db.scanJobs.command(value,authorizedRealPath);}catch(e){return {status:'rejected',job:null,error:e instanceof Error?e.message:String(e)};}
  if(result.job){const current=this.db.scanJobs.get(result.job.id);if(current.status==='cancelling'&&this.active?.id===current.id)this.active.controller.abort(new ScanCancelled());this.emit(current.id,false,true);}
  if(result.job&&['succeeded','failed','cancelled','interrupted'].includes(this.db.scanJobs.get(result.job.id).status)){for(const resolve of this.waiters.get(result.job.id)??[])resolve();this.waiters.delete(result.job.id);}
  this.pump();return result;
 }
 async wait(id:string):Promise<void>{const current=this.db.scanJobs.get(id);if(['succeeded','failed','cancelled','interrupted'].includes(current.status))return;await new Promise<void>(resolve=>{const callbacks=this.waiters.get(id)??[];callbacks.push(resolve);this.waiters.set(id,callbacks);});}
 private emit(id:string,final=false,force=false):void{
  if(!final&&!force&&Date.now()-this.lastEmit<250)return;this.lastEmit=Date.now();
  const j=this.db.scanJobs.get(id),phase:ScanState['phase']=j.status==='succeeded'?'complete':j.status==='failed'?'failed':j.status==='cancelled'?'cancelled':j.status==='interrupted'?'interrupted':j.status==='queued'?'queued':'running';
  try{this.publish({rootId:j.rootId,path:j.path,jobId:j.id,phase,stage:j.pass>=1?`verification-${j.phase}`:j.phase,scanned:j.scanned,imported:j.imported,errors:j.errors,message:j.message});this.changed(id,final);}catch{/* Checkpoints and completion must survive a closed notification channel. */}
 }
 private pump():void{if(this.busy||this.halted||this.maintenanceOwner)return;this.busy=true;const work=this.runQueue().finally(()=>{this.busy=false;if(this.flight===work)this.flight=null;if(!this.halted&&!this.maintenanceOwner&&this.db.scanJobs.next())this.pump();});this.flight=work;void work.catch(()=>{this.halted=true;});}
 private async runQueue():Promise<void>{
  for(let id=this.db.scanJobs.next();id;id=this.db.scanJobs.next()){
   if(this.maintenanceOwner)return;
   const controller=new AbortController();this.active={id,controller};let claimed=false;
   try{
    this.db.scanJobs.claim(id,this.owner);claimed=true;
    const heartbeat=setInterval(()=>{try{this.db.scanJobs.heartbeat(id!,this.owner);}catch(e){controller.abort(e);}},10000);
    try{await this.run(id,controller.signal);}finally{clearInterval(heartbeat);}
   }catch(e){
    if(e instanceof MediaWorkerExitUnconfirmed){this.halted=true;if(claimed)this.db.scanJobs.workerFault(id,this.owner,e.message);return;}
    if(claimed){if(controller.signal.reason instanceof ScanMaintenanceInterrupted)this.db.scanJobs.interruptForMaintenance(id,this.owner);else{const cancelled=controller.signal.aborted&&controller.signal.reason instanceof ScanCancelled||e instanceof ScanCancelled;this.db.scanJobs.finish(id,this.owner,cancelled?'cancelled':'failed',cancelled?'取消已确认，检查点保留':e instanceof Error?e.message:String(e),e instanceof ScanBoundaryError||(e as NodeJS.ErrnoException)?.code==='ENOENT');}}
    else this.db.scanJobs.failQueued(id,e instanceof Error?e.message:String(e));
   }finally{this.active=null;this.emit(id,!this.halted,true);if(!this.halted){for(const resolve of this.waiters.get(id)??[])resolve();this.waiters.delete(id);}}
   await delayTurn();
  }
 }
 private async rootPath(id:string,signal:AbortSignal):Promise<string>{
  signal.throwIfAborted();const c=this.db.scanJobs.context(id);let real:string;
  try{const stat=await fs.stat(c.path);if(!stat.isDirectory())throw new Error('不是目录');real=normalizePath(await fs.realpath(c.path));}catch(e){throw new ScanBoundaryError(`授权音乐目录不可用：${e instanceof Error?e.message:String(e)}`);}
  if(c.realPath!==null&&c.realPath!==real)throw new ScanBoundaryError('授权根目录目标已变化，已停止扫描');
  const root=this.db.getRoot(c.rootId);if(!root)throw new ScanBoundaryError('授权音乐目录已移除');this.db.restorePolicy.assertRoot(root);
  const watch=this.db.libraryWatch.load(root);
  if(watch.launch?.jobId===id&&!sameWatchAnchor(watch.launch.anchor,await probeWatchRoot(c.path)))throw new ScanBoundaryError('自动扫描根目录身份已变化，未执行缺失对账');
  signal.throwIfAborted();this.db.scanJobs.bind(id,this.owner,real);return real;
 }
 private async trustedPath(id:string,relative:string,kind:'file'|'directory'):Promise<string>{
  const c=this.db.scanJobs.context(id),full=path.resolve(c.path,relative);if(!inside(c.path,full))throw new ScanBoundaryError('扫描清单越过授权根目录');
  const stat=await fs.lstat(full);if(stat.isSymbolicLink()&&relative!==''||kind==='directory'&&!stat.isDirectory()||kind==='file'&&!stat.isFile())throw new Error('不跟随符号链接或非预期文件类型');
  const real=normalizePath(await fs.realpath(full));if(c.realPath===null||!inside(c.realPath,real))throw new ScanBoundaryError('读取目标越过授权根目录');return full;
 }
 private async run(id:string,signal:AbortSignal):Promise<void>{
  await this.rootPath(id,signal);let initial=this.db.scanJobs.get(id);
  // A suspended verification pass must get a fresh inventory and generation, never finalize its old partial view.
  if(initial.attempts>1&&initial.pass>=1)this.db.scanJobs.verification(id,this.owner);
  this.emit(id,false,true);
  for(;;){
   signal.throwIfAborted();const job=this.db.scanJobs.get(id);
   if(job.phase==='enumerating'){
    let entry:ScanEntry|null;while((entry=this.db.scanJobs.pending(id,'directory'))){await this.enumerate(id,entry,signal);this.emit(id);await delayTurn();}
    await this.retainedInventory(id,signal);
    this.db.scanJobs.phase(id,this.owner,'media');this.emit(id,false,true);
   }else if(job.phase==='media'){
    let entry:ScanEntry|null,checked=0;while((entry=this.db.scanJobs.pending(id,'audio'))){await this.media(id,entry,signal);if(++checked%20===0)this.emit(id);await delayTurn();}
    this.db.scanJobs.phase(id,this.owner,'cue');this.emit(id,false,true);
   }else if(job.phase==='cue'){
    let entry:ScanEntry|null;while((entry=this.db.scanJobs.pending(id,'cue'))){await this.cue(id,entry,signal);this.emit(id);await delayTurn();}
    if(job.pass===0){this.db.scanJobs.verification(id,this.owner);this.emit(id,false,true);}else this.db.scanJobs.phase(id,this.owner,'finalizing');
   }else{
    await this.rootPath(id,signal);signal.throwIfAborted();const final=this.db.scanJobs.get(id);
    this.db.scanJobs.finish(id,this.owner,final.unsafe?'failed':'succeeded',final.unsafe?'部分范围读取失败，保留旧记录，不判定文件缺失':final.errors?'扫描完成，异常文件保留在任务记录':'扫描与缺失对账完成');return;
   }
  }
 }
 private async retainedInventory(id:string,signal:AbortSignal):Promise<void>{
  const c=this.db.scanJobs.context(id);let after='';
  for(;;){
   signal.throwIfAborted();const batch=this.db.cueSources.retainedSources(c.rootId,after);if(!batch.length)return;
   const entries:ScanInventoryEntry[]=[];
   for(const source of batch){const full=path.resolve(c.path,source.relativePath);if(!source.relativePath||path.isAbsolute(source.relativePath)||!inside(c.path,full)||full===c.path)throw new ScanBoundaryError('历史CUE来源锚点越过当前目录');if(!this.db.scanJobs.containsCue(id,source.relativePath))entries.push({path:source.relativePath,kind:'cue'});}
   if(entries.length)this.db.scanJobs.add(id,this.owner,entries);after=batch.at(-1)!.id;this.emit(id);await delayTurn();
  }
 }
 private async absentCuePath(id:string,relative:string,signal:AbortSignal):Promise<boolean>{
  await this.rootPath(id,signal);const c=this.db.scanJobs.context(id),full=path.resolve(c.path,relative);
  if(!relative||path.isAbsolute(relative)||!inside(c.path,full)||full===c.path)throw new ScanBoundaryError('缺失CUE锚点越过当前目录');
  const parts=path.relative(c.path,full).split(path.sep);let current=c.path;
  for(let index=0;index<parts.length;index++){
   signal.throwIfAborted();current=path.join(current,parts[index]);
   let stat:Stats;try{stat=await fs.lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;}
   if(stat.isSymbolicLink()||index<parts.length-1&&!stat.isDirectory())throw new Error('缺失CUE锚点含链接或非目录路径');
   const real=normalizePath(await fs.realpath(current));if(c.realPath===null||!inside(c.realPath,real))throw new ScanBoundaryError('缺失CUE锚点越过实际授权目录');
  }
  return false;
 }
 private async enumerate(id:string,entry:ScanEntry,signal:AbortSignal):Promise<void>{
  try{
   const folder=await this.trustedPath(id,entry.relative_path,'directory'),root=this.db.scanJobs.context(id).path,dir=await fs.opendir(folder);let batch:ScanInventoryEntry[]= [],visited=0;
   try{for await(const child of dir){signal.throwIfAborted();if(child.isSymbolicLink())continue;const relative=path.relative(root,path.join(folder,child.name)),ext=path.extname(child.name).toLowerCase(),kind=child.isDirectory()?'directory':child.isFile()&&ext==='.cue'?'cue':child.isFile()&&extensions.has(ext)?'audio':null;if(kind){
     const sample:ScanInventoryEntry={path:relative,kind};
     if(kind!=='directory'&&!this.db.filePolicy.ignored(this.db.scanJobs.context(id).rootId,relative)){try{const target=await this.trustedPath(id,relative,'file');signal.throwIfAborted();sample.observation=fileObservation(await fs.lstat(target,{bigint:true}));sample.observedAt=this.sampleTime();}catch(e){signal.throwIfAborted();if(e instanceof ScanBoundaryError)throw e;/* Keep a pending entry so its own read can preserve old records. */}}
     batch.push(sample);
    }if(batch.length===256||++visited%1024===0){this.db.scanJobs.add(id,this.owner,batch);batch=[];await delayTurn();}}}finally{/* for-await closes the directory on completion, cancellation and error. */}
   if(batch.length)this.db.scanJobs.add(id,this.owner,batch);await this.trustedPath(id,entry.relative_path,'directory');this.db.scanJobs.checkpoint(id,this.owner,entry,{imported:0});
  }catch(e){signal.throwIfAborted();if(e instanceof ScanBoundaryError)throw e;this.db.scanJobs.checkpoint(id,this.owner,entry,{imported:0,message:e instanceof Error?e.message:String(e),unsafe:true});}
 }
 private async stable(id:string,entry:ScanEntry,handle:FileHandle,signal:AbortSignal):Promise<string>{
  signal.throwIfAborted();const stamp=fileObservation(await handle.stat({bigint:true}));signal.throwIfAborted();
  if(entry.observation_hash!==null&&(!validFileObservation(entry.observation_hash)||!Number.isSafeInteger(entry.observed_at)||entry.observed_at!<0))throw new Error('扫描稳定观察检查点无效');
  if(entry.observation_hash!==null&&entry.observation_hash!==stamp)throw new Error('文件自目录枚举后已变化，保留旧资料等待新一轮核对');
  const now=this.sampleTime();
  if(entry.observation_hash===null||entry.observed_at===null||entry.observed_at>now)this.db.scanJobs.observe(id,this.owner,entry,stamp,now);
  const remaining=Math.min(FILE_STABLE_MS,Math.max(0,FILE_STABLE_MS-(this.sampleTime()-entry.observed_at!)));
  if(remaining){this.emit(id,false,true);await waitStable(remaining,undefined,{signal});}
  signal.throwIfAborted();if(fileObservation(await handle.stat({bigint:true}))!==stamp)throw new Error('文件尚未稳定，保留旧资料等待下次读取');
  return stamp;
 }
 private async media(id:string,entry:ScanEntry,signal:AbortSignal):Promise<void>{
  const c=this.db.scanJobs.context(id),filename=path.resolve(c.path,entry.relative_path);
  try{await this.mediaReads.run(filename,()=>this.mediaRegistered(id,entry,signal));}
  catch(e){signal.throwIfAborted();if(e instanceof MediaWorkerExitUnconfirmed||e instanceof MediaWorkerUnavailable||e instanceof ScanBoundaryError)throw e;const existing=this.db.fileSnapshot(c.rootId,entry.relative_path);this.db.scanJobs.checkpoint(id,this.owner,entry,{imported:0,message:String(e instanceof Error?e.message:e)},()=>{if(existing)this.db.protectFile(existing.id,c.generation!);});}
 }
 private async mediaRegistered(id:string,entry:ScanEntry,signal:AbortSignal):Promise<void>{
  const c=this.db.scanJobs.context(id),generation=c.generation!;let existing=this.db.fileSnapshot(c.rootId,entry.relative_path);
  if(this.db.filePolicy.ignored(c.rootId,entry.relative_path)){this.db.scanJobs.checkpoint(id,this.owner,entry,{imported:0},()=>{if(existing)this.db.protectFile(existing.id,generation);});return;}
  try{
   if(existing)this.db.tagWriteJobs.assertReadable(existing.id);
   signal.throwIfAborted();const full=await this.trustedPath(id,entry.relative_path,'file'),handle=await fs.open(full,'r');
   try{
    const observation=await this.stable(id,entry,handle,signal),before=await handle.stat();if(!before.isFile()||!Number.isSafeInteger(before.size))throw new Error('音乐文件大小或类型无效');
    if(fileObservation(await handle.stat({bigint:true}))!==observation)throw new Error('稳定观察后文件已变化');
    let parsed:ParsedFile|null=null;
    if(!(existing&&!existing.parse_error&&existing.observation_hash===observation&&existing.size===before.size&&existing.mtime_ms===Math.trunc(before.mtimeMs)&&!this.db.needsCatalog(existing.id)&&!this.db.needsEmbeddedCue(existing.id))){
     if(c.realPath===null)throw new ScanBoundaryError('扫描根目录未绑定');
     parsed=await this.parser.parse({rootPath:c.path,realRootPath:c.realPath,fullPath:full,relativePath:entry.relative_path,before:mediaStat(before)},signal);
    }
    signal.throwIfAborted();const after=await handle.stat();await this.trustedPath(id,entry.relative_path,'file');const current=await fs.stat(full);
    if(!sameStat(before,after)||!sameStat(after,current)||fileObservation(await handle.stat({bigint:true}))!==observation||fileObservation(await fs.lstat(full,{bigint:true}))!==observation)throw new Error('音乐文件正在变化，保留旧资料等待下次读取');
    if(parsed?.parseError)throw new Error(parsed.parseError);
    if(this.db.filePolicy.ignored(c.rootId,entry.relative_path)){this.db.scanJobs.checkpoint(id,this.owner,entry,{imported:0},()=>{if(existing)this.db.protectFile(existing.id,generation);});return;}
    if(!parsed&&this.db.fileSnapshot(c.rootId,entry.relative_path)?.observation_hash!==observation)throw new Error('文件恢复或扫描状态已变化，等待重新读取');
    const embeddedNotice=parsed&&(parsed.embeddedCue||parsed.embeddedCueText)?embeddedCueView(parsed.embeddedCue??null,parsed.embeddedCueText??null,path.basename(entry.relative_path),parsed.artist,parsed.album).notice:'';
    this.db.scanJobs.checkpoint(id,this.owner,entry,{imported:parsed?1:0,...(embeddedNotice?{message:embeddedNotice,unsafe:true}:{})},()=>{if(parsed)this.db.upsertFile(c.rootId,parsed,generation,observation);else if(existing)this.db.markSeen(existing.id,generation);});
   }finally{await handle.close();}
  }catch(e){if(e instanceof MediaWorkerExitUnconfirmed)throw e;signal.throwIfAborted();if(e instanceof MediaBoundaryError)throw new ScanBoundaryError(e.message);if(e instanceof ScanBoundaryError||e instanceof MediaWorkerUnavailable)throw e;existing=this.db.fileSnapshot(c.rootId,entry.relative_path);this.db.scanJobs.checkpoint(id,this.owner,entry,{imported:0,message:e instanceof Error?e.message:String(e)},()=>{if(existing)this.db.protectFile(existing.id,generation);});}
 }
 private async cue(id:string,entry:ScanEntry,signal:AbortSignal):Promise<void>{
  const c=this.db.scanJobs.context(id),generation=c.generation!;
  try{
   signal.throwIfAborted();if(c.realPath===null)throw new ScanBoundaryError('扫描根目录未绑定');
   const full=path.resolve(c.path,entry.relative_path);let handle:FileHandle|undefined,historyFileId:string|undefined;
   let disk:Awaited<ReturnType<MediaParser['cue']>>|undefined;let sourceObservation:string|null=null;
   const interpretation=this.db.cueSources.interpretation(c.rootId,entry.relative_path);
   try{await this.trustedPath(id,entry.relative_path,'file');handle=await fs.open(full,'r');}
   catch(error){
    signal.throwIfAborted();if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    if(entry.observation_hash!==null)throw new Error('CUE在本轮枚举后消失，保留原编排等待新的核对');
    if(!await this.absentCuePath(id,entry.relative_path,signal))throw new Error('CUE在缺失核对时重新出现，等待新扫描');
    historyFileId=this.db.cueSources.retainedAt(c.rootId,entry.relative_path)??undefined;
    if(!historyFileId)throw new Error('磁盘CUE缺失且未明确选择历史原文，保留原编排');
   }
   if(handle){
    try{const observation=await this.stable(id,entry,handle,signal),before=await handle.stat();if(fileObservation(await handle.stat({bigint:true}))!==observation)throw new Error('稳定观察后CUE已变化');sourceObservation=observation;disk=await this.parser.cue({rootPath:c.path,realRootPath:c.realPath,fullPath:full,relativePath:entry.relative_path,before:mediaStat(before),cueEncoding:interpretation.encoding,cueGapPolicy:interpretation.gapPolicy},signal);signal.throwIfAborted();const after=await handle.stat();await this.trustedPath(id,entry.relative_path,'file');if(!sameStat(before,after)||!sameStat(after,await fs.stat(full))||fileObservation(await handle.stat({bigint:true}))!==observation||fileObservation(await fs.lstat(full,{bigint:true}))!==observation)throw new Error('CUE正在变化，保留原编排');}finally{await handle.close();}
   }
   if(disk&&sourceObservation)historyFileId=this.db.cueSources.observe(c.rootId,c.path,entry.relative_path,sourceObservation,disk,interpretation);
   if(!historyFileId)throw new Error('CUE来源未完成核对');
   const initialSelection=this.db.cueSources.source(historyFileId);
   if(initialSelection.selectionCommand&&initialSelection.pendingScan){
    const receipt=this.db.scanJobs.startReceipt(initialSelection.selectionCommand);
    if(!receipt||receipt.rootId!==c.rootId||receipt.jobId!==id){
     this.db.scanJobs.checkpoint(id,this.owner,entry,{imported:0,message:'此原文选择等待自己的新扫描，当前旧扫描保留原编排',unsafe:true},()=>this.db.protectCue(c.rootId,entry.relative_path,generation));return;
    }
   }
   const effective=this.db.cueSources.effectiveSource(historyFileId,disk),source=effective.source;
   const historySelection=this.db.cueSources.source(historyFileId);
   const strictSelection=historySelection.selectionCommand!==null;
   const checked=new Map<string,{fileId:string;observation:string;policyRevision:number}>();
   if(source.parseError)throw new Error(source.parseError);
   const cue=source.document,valid:Array<CueEntry&{fileId:string}>=[];
   if(cue.invalid)throw new Error(cue.warnings.join('；')||'CUE 编排需要修复');
   for(const track of cue.entries){
    signal.throwIfAborted();const media=resolveCueReference(c.path,full,track.file);
    if(!media){cue.warnings.push(`TRACK ${track.number} 引用目录外文件`);continue;}
    const relativeMedia=path.relative(c.path,media),ignoredRow=this.db.filePolicy.ignored(c.rootId,relativeMedia)?this.db.fileSnapshot(c.rootId,relativeMedia):undefined;
    if(ignoredRow&&!strictSelection){valid.push({...track,...(!track.songwriter&&cue.songwriter?{songwriter:cue.songwriter}:{}),fileId:ignoredRow.id});continue;}
    try{await this.trustedPath(id,relativeMedia,'file');}catch(e){if(e instanceof ScanBoundaryError)throw e;cue.warnings.push(`TRACK ${track.number} 引用文件无法读取`);continue;}
    const row=this.db.fileSnapshot(c.rootId,relativeMedia);
    if(!row||!this.db.scanJobs.mediaChecked(id,relativeMedia)||row.parse_error||strictSelection&&(!validFileObservation(row.observation_hash)||row.duration_seconds===null||!Number.isFinite(row.duration_seconds)||row.duration_seconds<=0)||row.duration_seconds!==null&&((track.startFrame??track.index01Frame)/75>=row.duration_seconds||track.index01Frame/75>=row.duration_seconds||track.endFrame!==undefined&&track.endFrame/75>row.duration_seconds+0.000001||track.indices?.some(index=>index.frame/75>=row.duration_seconds!))){cue.warnings.push(`TRACK ${track.number} 缺少可用音频或起点超出时长`);continue;}
    if(strictSelection){
     const policy=this.db.filePolicy.view(row.id);this.db.tagWriteJobs.assertReadable(row.id);
     if(policy.state!=='active'||policy.restorePending){cue.warnings.push(`TRACK ${track.number} 引用已忽略、移出或待恢复文件`);continue;}
     const observation=fileObservation(await fs.lstat(media,{bigint:true}));
     if(observation!==row.observation_hash)throw new Error('历史编排引用在媒体核对后已变化，保留原编排');
     checked.set(relativeMedia,{fileId:row.id,observation,policyRevision:policy.revision});
    }
    valid.push({...track,...(!track.songwriter&&cue.songwriter?{songwriter:cue.songwriter}:{}),fileId:row.id});
   }
   for(const hidden of cue.hiddenEntries??[]){const normal=valid.find(track=>!track.hidden&&track.file===hidden.file&&track.sourceOrdinal===hidden.sourceOrdinal);if(normal)valid.push({...hidden,fileId:normal.fileId});}
   if(!valid.length)throw new Error(cue.warnings.join('；')||'没有可用的 CUE 音频轨');
   if(cue.warnings.length&&(strictSelection||this.db.hasCue(c.rootId,entry.relative_path))){this.db.scanJobs.checkpoint(id,this.owner,entry,{imported:0,message:cue.warnings.join('；'),unsafe:true},()=>this.db.protectCue(c.rootId,entry.relative_path,generation));return;}
   if(strictSelection){
    for(const [relative,proof] of checked){signal.throwIfAborted();const actual=await this.trustedPath(id,relative,'file');if(fileObservation(await fs.lstat(actual,{bigint:true}))!==proof.observation)throw new Error('历史编排引用在提交前已变化，保留原编排');}
    if(sourceObservation===null){if(!await this.absentCuePath(id,entry.relative_path,signal))throw new Error('磁盘CUE在提交前重新出现，历史选择仍待核对');}
    else{await this.trustedPath(id,entry.relative_path,'file');if(fileObservation(await fs.lstat(full,{bigint:true}))!==sourceObservation)throw new Error('磁盘CUE在提交前已变化，历史选择仍待核对');}
   }
   let imported=0;this.db.scanJobs.checkpoint(id,this.owner,entry,{imported:valid.length,...(cue.warnings.length?{message:cue.warnings.join('；'),unsafe:true}:{})},()=>{
    const selection=this.db.cueSources.source(historyFileId);
    if(selection.revision!==historySelection.revision||selection.latestVersion!==historySelection.latestVersion||selection.selectedVersion!==historySelection.selectedVersion||selection.selectionCommand!==historySelection.selectionCommand)throw new Error('CUE解释设置或来源已变化，保留旧编排');
    for(const [relative,proof] of checked){const row=this.db.fileSnapshot(c.rootId,relative),policy=this.db.filePolicy.view(proof.fileId);this.db.tagWriteJobs.assertReadable(proof.fileId);if(!row||row.id!==proof.fileId||row.observation_hash!==proof.observation||policy.revision!==proof.policyRevision||policy.state!=='active'||policy.restorePending)throw new Error('CUE引用的曲库记录或管理状态已变化');}
    imported=this.db.applyCue(c.rootId,entry.relative_path,cue.title,cue.performer,valid,cue.warnings,generation,source,75,{...effective.application,sourcePresence:sourceObservation===null?'absent':'present'});
    if(imported!==valid.length)throw new Error('CUE检查点曲目数不一致');if(!cue.warnings.length)this.db.cueSources.applied(historyFileId);
   });
  }catch(e){if(e instanceof MediaWorkerExitUnconfirmed)throw e;signal.throwIfAborted();if(e instanceof MediaBoundaryError)throw new ScanBoundaryError(e.message);if(e instanceof ScanBoundaryError||e instanceof MediaWorkerUnavailable)throw e;this.db.scanJobs.checkpoint(id,this.owner,entry,{imported:0,message:e instanceof Error?e.message:String(e),unsafe:true},()=>this.db.protectCue(c.rootId,entry.relative_path,generation));}
 }
}
