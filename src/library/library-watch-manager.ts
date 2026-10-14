import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {LibraryDatabase} from './database.js';
import type {ScanManager} from './scan-manager.js';
import {NodeFileWatcher,probeWatchRoot,sameWatchAnchor,normalizedWatchPath,inWatchPath,type FileWatcher} from '../platform/file-watcher.js';
import {readLibraryWatchRequest,type LibraryWatchRequest,type LibraryWatchResult,type LibraryWatchState,type LibraryWatchRoot,type WatchStatus,type WatchAnchor} from '../shared/library-watch.js';
import type {WatchRecord} from './library-watch-store.js';

type Session={id:string;path:string;token:number;watcher:{close:()=>void}|null;probing:boolean;status:WatchStatus;message:string;pendingEvent:boolean;firstEvent:number;lastEvent:number;nextProbe:number;retryDelay:number;lastLaunch:number;booted:boolean};
const CAPACITY=64,MIN_SCAN_INTERVAL=60000,QUIET_MS=2500,MAX_COALESCE_MS=10000;
const message=(e:unknown)=>String(e instanceof Error?e.message:e).replace(/\0/g,'').slice(0,512);
export class LibraryWatchManager{
 private readonly session=randomUUID();private revision=0;private timer:ReturnType<typeof setInterval>|undefined;
 private readonly sessions=new Map<string,Session>();private closed=false;private suspended=false;private probes=0;private fault='';private lastNotice='';private ticking=false;
 private maintenanceOwner:string|null=null;private maintenanceWasSuspended=false;private readonly probeFlights=new Set<Promise<void>>();
 async beginMaintenance(owner:string):Promise<void>{
  if(!owner||this.maintenanceOwner&&this.maintenanceOwner!==owner)throw new Error('目录监听维护身份不符');
  if(!this.maintenanceOwner){this.maintenanceWasSuspended=this.suspended;this.suspend();this.maintenanceOwner=owner;}
  await Promise.allSettled([...this.probeFlights]);if(this.probes||this.probeFlights.size)throw new Error('目录核对读取尚未退出，不能建立快照');
 }
 endMaintenance(owner:string,resume:boolean):void{if(this.maintenanceOwner!==owner||this.probes||this.probeFlights.size)throw new Error('目录监听维护尚未完成或身份不符');this.maintenanceOwner=null;if(resume&&!this.maintenanceWasSuspended)this.resume();}
 constructor(private readonly db:LibraryDatabase,private readonly scans:ScanManager,private readonly publish:(state:LibraryWatchState)=>void,private readonly invalidate:(rootId:string)=>void,private readonly excluded:string[],private readonly adapter:FileWatcher=new NodeFileWatcher()){}
 start():void{if(this.timer||this.closed)return;this.tick();this.timer=setInterval(()=>this.tick(),1000);this.timer.unref();}
 close():void{this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;for(const s of this.sessions.values()){s.token++;this.closeWatcher(s);}this.sessions.clear();}
 suspend():void{if(this.suspended||this.closed)return;this.suspended=true;for(const s of this.sessions.values()){try{this.flush(s);}catch(e){this.fault=message(e);}finally{s.token++;this.closeWatcher(s);}}this.notify();}
 resume():void{if(!this.suspended||this.closed)return;this.suspended=false;for(const s of this.sessions.values()){s.booted=false;s.nextProbe=0;s.retryDelay=5000;}this.tick();}
 private root(id:string):{id:string;path:string}{const r=this.db.getRoot(id);if(!r)throw new Error('音乐目录已移除');return r;}
 private record(id:string):WatchRecord{return this.db.libraryWatch.load(this.root(id));}
 private save(r:WatchRecord):void{this.db.libraryWatch.save(r);this.revision++;}
 private request(r:WatchRecord):void{if(r.requested>=Number.MAX_SAFE_INTEGER-1)throw new Error('自动更新检查点已耗尽，请保留数据库并检查');r.requested++;this.save(r);}
 private status(s:Session,status:WatchStatus,detail:string):void{if(s.status!==status||s.message!==detail){s.status=status;s.message=detail;this.revision++;}}
 private closeWatcher(s:Session):void{const watcher=s.watcher;s.watcher=null;watcher?.close();}
 private view(r:WatchRecord):LibraryWatchRoot{
  const s=this.sessions.get(r.rootId);return {rootId:r.rootId,path:this.root(r.rootId).path,revision:r.revision,enabled:r.enabled,periodicMinutes:r.periodicMinutes,status:!r.enabled?'disabled':this.suspended?'paused':r.paused?'paused':s?.status??'capacity',message:!r.enabled?'自动更新已关闭；已创建的扫描可在任务中心取消':this.suspended?'系统休眠期间暂停自动更新':r.paused||s?.message||'同时监听上限为 64 个目录，可关闭其他目录后重试',pending:r.requested>r.completed||Boolean(s?.pendingEvent),jobId:r.launch?.jobId??null,lastSuccessAt:r.lastSuccessAt};
 }
 state():LibraryWatchState{return {version:1,session:this.session,revision:this.revision,capacity:CAPACITY,roots:this.db.roots().slice(0,128).map(root=>this.view(this.db.libraryWatch.load(root))),suspended:this.suspended,error:this.fault};}
 private notify():void{
  try{const state=this.state(),key=JSON.stringify(state);if(key!==this.lastNotice){this.lastNotice=key;this.publish(state);}}catch(e){this.fault=message(e);}
 }
 receipt(value:unknown):LibraryWatchResult|null{
  const q=readLibraryWatchRequest(value),r=this.record(q.rootId);
  if(r.lastCommand?.commandId!==q.commandId)return null;
  if(JSON.stringify(r.lastCommand)!==JSON.stringify(q))throw new Error('同一自动更新操作不能更改内容');return {status:'saved',state:this.state(),error:''};
 }
 async command(value:unknown,confirmed?:WatchAnchor):Promise<LibraryWatchResult>{
  const q=readLibraryWatchRequest(value),old=this.receipt(q);if(old)return old;
  let saveAttempted=false,committed=false;
  try{
   let r=this.record(q.rootId);if(r.revision!==q.revision)throw new Error('自动更新设置已变化，请重新读取');
   if(q.action!=='confirm'&&q.action!=='disable'&&!this.db.restorePolicy.rootAuthorized(this.root(q.rootId)))throw new Error('恢复的目录需重新选择并确认，不能直接启用或重试');
   if(q.action==='confirm'){
    if(!confirmed)throw new Error('需要重新选择并确认此音乐目录');
    const observed=await probeWatchRoot(this.root(q.rootId).path);if(!sameWatchAnchor(observed,confirmed))throw new Error('刚确认的目录身份已变化');
    const replay=this.receipt(q);if(replay)return replay;
    r=this.record(q.rootId);if(r.revision!==q.revision)throw new Error('自动更新设置已变化，请重新读取');r.anchor=observed;r.path=this.root(q.rootId).path;
   }
   if(r.revision>=Number.MAX_SAFE_INTEGER-1)throw new Error('自动更新设置修订已耗尽');
   r.revision++;r.enabled=q.action!=='disable';r.periodicMinutes=q.periodicMinutes;r.lastCommand=q;r.paused='';r.failedPasses=0;
   // Configure/enable/retry always establishes a fresh baseline. Disabling does
   // not cancel or discard an existing durable scan/receipt.
   if(r.enabled){if(r.requested>=Number.MAX_SAFE_INTEGER-1)throw new Error('自动更新检查点已耗尽');r.requested++;}
   saveAttempted=true;this.save(r);committed=true;const s=this.sessions.get(r.rootId);if(s){s.token++;this.closeWatcher(s);s.booted=true;s.nextProbe=0;s.retryDelay=5000;}
   this.tick();return {status:'saved',state:this.state(),error:''};
  }catch(e){
   // A failed write or post-commit response cannot be reported as a known
   // rejection. Keep the original command for explicit receipt reconciliation.
   if(committed){const saved=this.receipt(q);if(saved)return saved;}
   if(saveAttempted)throw e;
   return {status:'rejected',state:this.state(),error:message(e)};
  }
 }
 observeScan(id:string):void{
  if(this.closed||this.maintenanceOwner)return;
  try{const job=this.db.scanJobs.get(id);if(job.status==='cancelling'||job.status==='cancelled'){
    const r=this.record(job.rootId);if(r.enabled&&!r.paused){r.paused='扫描已取消，自动更新暂停；在自动更新设置中明确恢复后再继续';this.save(r);const s=this.sessions.get(r.rootId);if(s){s.token++;this.closeWatcher(s);}}
   }}catch(e){this.fault=message(e);}this.tick();
 }
 private changed(s:Session,filename:string|null):void{
  if(this.closed||this.suspended||!s.watcher)return;
  if(filename&&filename.length<=32768&&!filename.includes('\0')){
   const candidate=path.resolve(s.path,filename);
   // Filenames only suppress our own app-data writes; they never authorize I/O.
   if(inWatchPath(s.path,candidate)&&this.excluded.some(root=>inWatchPath(root,candidate)))return;
  }
  if(!s.pendingEvent){s.pendingEvent=true;s.firstEvent=Date.now();}s.lastEvent=Date.now();
  this.status(s,'pending','发现目录变化，等待文件写入和连续通知合并');
 }
 private flush(s:Session):void{
  if(!s.pendingEvent)return;const r=this.record(s.id);r.failedPasses=0;this.request(r);s.pendingEvent=false;
  // Metadata, local cover and lyric consumers receive a revision even when only
  // sidecar files changed and an audio scan has nothing new to import.
  s.nextProbe=Math.min(s.nextProbe,Date.now());this.invalidate(s.id);
 }
 private reconcile(r:WatchRecord,s:Session):WatchRecord{
  if(!r.launch)return r;
  if(!r.launch.jobId){const receipt=this.db.scanJobs.startReceipt(r.launch.commandId);if(receipt){if(receipt.rootId!==r.rootId)throw new Error('自动扫描回执目录不一致');r.launch.jobId=receipt.jobId;this.save(r);}else return r;}
  const j=this.db.scanJobs.get(r.launch.jobId!);if(j.rootId!==r.rootId||j.path!==r.path)throw new Error('自动扫描身份已变化');
  if(j.status==='succeeded'){
   if(j.errors===0){r.completed=Math.max(r.completed,r.launch.epoch);r.lastSuccessAt=Date.now();r.failedPasses=0;}
   else{r.failedPasses=Math.min(3,r.failedPasses+1);if(r.failedPasses===3)r.paused='三次核对仍有文件读取异常，保留旧资料并暂停自动更新；请检查任务记录后明确恢复';}
   r.launch=null;this.save(r);s.lastLaunch=Date.now();
  }else if(['failed','cancelled','interrupted'].includes(j.status)){
   if(!r.paused){r.paused=j.status==='interrupted'?'原扫描中断，请在任务中心继续或取消；自动更新等待明确恢复':j.status==='cancelled'?'扫描已取消，自动更新等待明确恢复':`自动扫描失败：${j.message}`.slice(0,512);this.save(r);}this.closeWatcher(s);
   // Retain interrupted jobs so a user's checkpoint resume can still satisfy
   // the exact original epoch. A failed/cancelled job cannot satisfy it.
   if(j.status!=='interrupted'){r.launch=null;this.save(r);}
  }else this.status(s,'scanning',j.status==='cancelling'?'等待扫描取消确认':'目录变化已进入持久扫描任务');
  return r;
 }
 private tick():void{
  if(this.closed||this.ticking||this.maintenanceOwner)return;this.ticking=true;
  try{
   const roots=this.db.roots(),ids=new Set(roots.map(root=>root.id));
   for(const [id,s] of this.sessions)if(!ids.has(id)){s.token++;this.closeWatcher(s);this.sessions.delete(id);}
   const enabled=roots.filter(root=>this.db.libraryWatch.load(root).enabled).slice(0,CAPACITY),allowed=new Set(enabled.map(root=>root.id));
   for(const [id,s] of this.sessions)if(!allowed.has(id)){s.token++;this.closeWatcher(s);this.sessions.delete(id);}
   if(roots.length>128)this.fault='目录超过设置面板 128 项的显示预算，请先整理目录；其他目录仍可手动扫描';
   for(const root of enabled){
    let s=this.sessions.get(root.id);if(!s){s={id:root.id,path:root.path,token:0,watcher:null,probing:false,status:'starting',message:'准备目录监听',pendingEvent:false,firstEvent:0,lastEvent:0,nextProbe:0,retryDelay:5000,lastLaunch:0,booted:false};this.sessions.set(root.id,s);}
    let r=this.record(root.id);r=this.reconcile(r,s);
    if(!this.db.restorePolicy.rootAuthorized(root)){this.closeWatcher(s);continue;}
    if(this.suspended||r.paused){this.closeWatcher(s);continue;}
    if(r.path!==root.path){r.paused='音乐根目录路径发生变化，请重新确认目录';this.save(r);this.closeWatcher(s);continue;}
    if(!s.booted){this.request(r);s.booted=true;r=this.record(root.id);}
    if(s.pendingEvent&&(Date.now()-s.lastEvent>=QUIET_MS||Date.now()-s.firstEvent>=MAX_COALESCE_MS)){this.flush(s);r=this.record(root.id);}
    const active=this.db.scanJobs.activeForRoot(root.id);
    if(active?.status==='interrupted'){this.status(s,'waiting','扫描检查点等待用户继续或取消');continue;}
    const periodic=Boolean(r.periodicMinutes&&r.lastSuccessAt&&Date.now()-r.lastSuccessAt>=r.periodicMinutes*60000);
    if(periodic&&r.requested===r.completed){this.request(r);r=this.record(root.id);}
    const shouldLaunch=!r.launch&&!active&&!s.pendingEvent&&r.requested>r.completed&&Date.now()-s.lastLaunch>=MIN_SCAN_INTERVAL;
    if(active&&!r.launch)this.status(s,'waiting','等待现有扫描结束后再核对目录变化');
    if(!s.probing&&this.probes<2&&Date.now()>=s.nextProbe){const work=this.probe(s,shouldLaunch).catch(e=>{this.fault=message(e);this.notify();}).finally(()=>{this.probeFlights.delete(work);});this.probeFlights.add(work);}
    else if(!s.probing&&s.watcher&&!active&&!r.launch&&!s.pendingEvent)this.status(s,r.requested>r.completed?'pending':'watching',r.requested>r.completed?'变化已保存，等待扫描间隔或目录核对':'正在监听目录；定期对账补查遗漏变化');
   }
   this.notify();
  }catch(e){this.fault=message(e);this.notify();}finally{this.ticking=false;}
 }
 private async probe(s:Session,launch:boolean):Promise<void>{
  s.probing=true;this.probes++;const token=s.token;
  // Keep the actual I/O flight counted after this observation deadline. A slow
  // network call never frees a slot and starts duplicate directory probes.
  const deadline=setTimeout(()=>{if(!this.closed&&s.token===token){this.status(s,'offline','目录读取超过 5 秒，等待原读取结束；未启动重复读取');this.notify();}},5000);deadline.unref();
  const valid=()=>!this.closed&&!this.suspended&&s.token===token&&this.sessions.get(s.id)===s;
  try{
   let r=this.record(s.id);if(!r.enabled||r.paused||!this.db.restorePolicy.rootAuthorized(this.root(s.id)))return;
   if(this.excluded.some(root=>inWatchPath(root,s.path))){r.paused='应用目录与应用数据目录不参与音乐自动监听';this.save(r);this.closeWatcher(s);return;}
   const anchor=await probeWatchRoot(s.path);if(!valid())return;
   r=this.record(s.id);if(!r.enabled||r.paused)return;
   if(!r.anchor){const previous=this.db.scanJobs.lastBoundPath(s.id);if(previous&&normalizedWatchPath(previous)!==anchor.realPath){r.paused='根目录目标与原扫描授权不同，请重新确认目录';this.save(r);this.closeWatcher(s);return;}r.anchor=anchor;this.save(r);}
   if(!sameWatchAnchor(r.anchor,anchor)){r.paused='根目录身份与原授权不同，请重新选择并确认此目录';this.save(r);this.closeWatcher(s);return;}
   let watcherError='';
   if(!s.watcher){
    try{
     s.watcher=this.adapter.open(s.path,name=>{if(valid())this.changed(s,name);},error=>{if(!valid())return;this.closeWatcher(s);s.nextProbe=Date.now()+s.retryDelay;s.retryDelay=Math.min(300000,s.retryDelay*2);this.status(s,'offline',`监听暂不可用：${message(error)}`.slice(0,512));this.notify();});
    }catch(e){this.closeWatcher(s);watcherError=message(e);}
    if(s.watcher){
     const after=await probeWatchRoot(s.path);if(!valid()){this.closeWatcher(s);return;}
     if(!sameWatchAnchor(anchor,after)){r=this.record(s.id);r.paused='建立监听期间目录身份发生变化，请重新确认目录';this.save(r);this.closeWatcher(s);return;}
     r=this.record(s.id);if(r.requested===r.completed)this.request(r);
    }
   }
   if(s.watcher){s.retryDelay=5000;s.nextProbe=Date.now()+30000;}
   else{s.nextProbe=Date.now()+s.retryDelay;s.retryDelay=Math.min(300000,s.retryDelay*2);}
   r=this.record(s.id);
   if(launch&&!r.paused&&r.enabled&&!s.pendingEvent&&!r.launch&&!this.db.scanJobs.activeForRoot(s.id)){
    r.launch={commandId:randomUUID(),epoch:r.requested,jobId:null,anchor:{...r.anchor!}};this.save(r);
   }
   if(r.launch&&!r.launch.jobId&&!r.paused&&!this.db.scanJobs.activeForRoot(s.id)){
    const intent=r.launch.commandId;
    const saved=this.scans.command({commandId:intent,rootId:s.id,action:'start'},r.launch.anchor.realPath);
    if(saved.status!=='saved'||!saved.job)throw new Error(saved.error||'自动扫描尚未保存');
    // Scan callbacks can observe or pause this record while command() returns.
    r=this.record(s.id);if(!r.launch||r.launch.commandId!==intent||saved.job.rootId!==r.rootId)throw new Error('自动扫描意图或回执发生变化');
    r.launch.jobId=saved.job.id;this.save(r);s.lastLaunch=Date.now();this.status(s,'scanning','已创建持久扫描任务');
   }else if(!r.launch)this.status(s,watcherError?'error':r.requested>r.completed?'pending':'watching',watcherError?`监听不可用，${r.periodicMinutes?'周期对账仍启用':'周期对账已关闭'}：${watcherError}`.slice(0,512):r.requested>r.completed?'已保存变化，等待现有扫描或间隔':'正在监听目录');
  }catch(e){if(valid()){this.closeWatcher(s);s.nextProbe=Date.now()+s.retryDelay;s.retryDelay=Math.min(300000,s.retryDelay*2);this.status(s,'offline',message(e));
    const r=this.record(s.id);if(r.requested===r.completed)this.request(r);
    if(['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException)?.code??'')&&this.root(s.id)&&this.db.getRoot(s.id)?.status!=='offline'){this.db.markRootOffline(s.id);this.invalidate(s.id);}
   }}
  finally{clearTimeout(deadline);s.probing=false;this.probes--;if(valid())this.notify();}
 }
}
