import {TagBackupStorage} from './tag-backup-storage.js';
import {readTagRestoreReprobeRequest,readTagRestoreReprobeCancel} from '../shared/tag-restore-reprobe.js';
import {assertTagCommitCertified} from '../shared/tag-commit.js';
import {readTagCommitCancel} from '../shared/tag-commit-journal.js';
import {tagRestorePreviewChanges,validateRestoreReprobeProof,type TagRestoreReprobeProof} from './tag-restore-reprobe-proof.js';
import {readTagRestoreInspectionRequest,classifyTagRestoreRecovery,assertTagRestoreInspectionEqual,type TagRestoreInspectionRequest,type TagRestoreRecoveryReport} from '../shared/tag-restore-recovery.js';
import {TagRestoreJournal} from './tag-restore-journal.js';
import {TagFileRestorer} from './tag-file-restorer.js';
import {readTagRestoreStart,readTagRestoreCancel} from '../shared/tag-restore-journal.js';
import {readTagCommitReprobeRequest,readTagCommitReprobeCancel} from '../shared/tag-commit-reprobe.js';
import {assertCommitInspectionEqual,validateCommitReprobeProof,type TagCommitReprobeProof} from './tag-commit-reprobe-proof.js';
import {classifyTagCommitRecovery,type TagCommitInspectionRequest,type TagCommitRecoveryReport} from '../shared/tag-commit-recovery.js';
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {FLAC_TAG_ADAPTER,tagWriteUuid,readTagFieldChanges,type TagWritePlan} from '../shared/tag-write.js';
import {readTagWriteDraft,readTagWritePrepareRequest,type TagWritePreview,type TagWriteJob,type TagWriteDraft} from '../shared/tag-write-ui.js';
import {fileObservation} from '../platform/file-observation.js';
import {probeWatchRoot,sameWatchAnchor} from '../platform/file-watcher.js';
import type {WatchAnchor} from '../shared/library-watch.js';
import {mediaStat,sameMediaStat,insideMediaRoot,type MediaStat} from './media-worker-protocol.js';
import type {LibraryDatabase} from './database.js';
import type {MediaParser} from './media-worker-client.js';
import type {TagWriteFrozenSnapshot} from './tag-write-jobs.js';
import {TagWriteJournal} from './tag-write-journal.js';
import {TagWriteWorker} from './tag-write-worker-client.js';
import {readTagWriteCancelRequest} from '../shared/tag-write-ui.js';
import type {TagStageDescriptor} from './tag-write-jobs.js';
import {TagFileInspector} from './tag-file-inspector.js';
import {readTagRecoveryCancel,readTagRecoveryAction,readTagRecoveryActionCancel,assertTagRecoverySnapshotEqual,type TagRecoveryReport,type TagInspectionRequest} from '../shared/tag-recovery.js';
import {classifyTagWriteRecovery} from '../shared/tag-write.js';
import {TagCommitJournal} from './tag-commit-journal.js';
import {TagFileCommitter} from './tag-file-committer.js';
import {readTagCommitStart} from '../shared/tag-commit-journal.js';
export interface TagStageRuntime {dataDir:string;executable:string;quiesce:(fileId:string,filename:string,owner:string)=>Promise<void>;release:(filename:string,owner:string)=>void;releaseRecovered:(filename:string,owner:string)=>void;recovered:(jobId:string)=>void;invalidated?:(jobId:string)=>void;changed:(jobId:string,error?:string)=>void}

type Pending={value:TagWritePreview;snapshot:TagWriteFrozenSnapshot;bytes:number};
export class TagWriteManager {
 private readonly tokens=new Map<string,Pending>();
 private readonly requests=new Map<string,{identity:string;controller:AbortController;result:Promise<TagWritePreview>}>();
 private activeStage:{jobId:string;controller:AbortController;finished?:Promise<void>}|null=null;
 private readonly journal:TagWriteJournal|undefined;private readonly writer:TagWriteWorker|undefined;
 private readonly inspector:TagFileInspector|undefined;
 private readonly commitJournal:TagCommitJournal|undefined;private readonly committer:TagFileCommitter|undefined;
 private readonly restoreJournal:TagRestoreJournal|undefined;private readonly restorer:TagFileRestorer|undefined;
 private readonly restoreReleases=new Map<string,Promise<void>>();
 private readonly prepareFlights=new Map<string,{identity:string;result:Promise<TagWriteJob>}>();
 private readonly commitReleases=new Map<string,Promise<void>>();
 private activeRestoreReprobe:{id:string;jobId:string;controller:AbortController;releaseReady?:boolean;finished?:Promise<void>}|null=null;
 private activeRestoreInspection:{id:string;jobId:string;controller:AbortController;finished?:Promise<void>}|null=null;
 private activeRestore:{id:string;jobId:string;controller:AbortController;finished?:Promise<void>}|null=null;
 private activeReprobe:{id:string;jobId:string;controller:AbortController;releaseReady?:boolean;finished?:Promise<void>}|null=null;
 private activeCommitInspection:{id:string;jobId:string;controller:AbortController;finished?:Promise<void>}|null=null;
 private activeCommit:{id:string;jobId:string;controller:AbortController;finished?:Promise<void>}|null=null;
 private activeInspection:{id:string;jobId:string;controller:AbortController;finished?:Promise<void>}|null=null;
 private activeRecoveryAction:{id:string;jobId:string;controller:AbortController;finished?:Promise<void>}|null=null;
 private maintenanceOwner:string|null=null;
 async beginMaintenance(owner:string):Promise<void>{
  if(!owner||this.maintenanceOwner&&this.maintenanceOwner!==owner)throw new Error('标签写回维护身份不符');this.maintenanceOwner=owner;this.close();
  const active=[this.activeStage,this.activeInspection,this.activeRecoveryAction,this.activeCommit,this.activeCommitInspection,this.activeReprobe,this.activeRestore,this.activeRestoreInspection,this.activeRestoreReprobe];
  if(active.some(value=>value&&!value.finished))throw new Error('文件操作仍在准备阶段，须先等待原请求结束');
  await Promise.allSettled([...active.flatMap(value=>value?.finished?[value.finished]:[]),...[...this.requests.values()].map(value=>value.result),...this.restoreReleases.values(),...this.commitReleases.values(),...[...this.prepareFlights.values()].map(f=>f.result)]);
  this.assertMaintenanceIdle();
 }
 private assertMaintenanceIdle():void{
  if(this.activeStage||this.activeInspection||this.activeRecoveryAction||this.activeCommit||this.activeCommitInspection||this.activeReprobe||this.activeRestore||this.activeRestoreInspection||this.activeRestoreReprobe||this.requests.size||this.prepareFlights.size||this.restoreReleases.size||this.commitReleases.size||[this.writer,this.inspector,this.committer,this.restorer].some(value=>value&&!value.quiescent))throw new Error('写回或恢复进程未全部确认退出，保留原任务与恢复占用');
 }
 endMaintenance(owner:string):void{if(this.maintenanceOwner!==owner)throw new Error('标签维护身份不符');this.assertMaintenanceIdle();this.maintenanceOwner=null;}
 get batchIdle():boolean{if(this.maintenanceOwner)return false;try{this.assertMaintenanceIdle();return true;}catch{return false;}}
 constructor(private readonly db:LibraryDatabase,private readonly parser:MediaParser,private readonly runtime?:TagStageRuntime){if(runtime){this.restoreJournal=new TagRestoreJournal(runtime.dataDir);this.restorer=new TagFileRestorer(path.join(path.dirname(runtime.executable),'tag-file-restorer.exe'));this.commitJournal=new TagCommitJournal(runtime.dataDir);this.committer=new TagFileCommitter(path.join(path.dirname(runtime.executable),'tag-file-committer.exe'));this.journal=new TagWriteJournal(runtime.dataDir);this.writer=new TagWriteWorker(runtime.executable);this.inspector=new TagFileInspector(path.join(path.dirname(runtime.executable),'tag-file-inspector.exe'));}}
 private sweep():void {for(const [id,p] of this.tokens)if(p.value.expiresAt<=Date.now())this.tokens.delete(id);}
 cancel(value:unknown):void {if(!tagWriteUuid(value))throw new Error('标签预览任务身份无效');const requestId=value.toLowerCase();this.requests.get(requestId)?.controller.abort(new Error('标签预览已取消'));for(const [key,p] of this.tokens)if(p.value.draft.requestId===requestId)this.tokens.delete(key);}
 close():void {for(const r of this.requests.values())r.controller.abort(new Error('曲库服务正在关闭'));this.activeStage?.controller.abort(new Error('曲库服务正在关闭'));this.activeInspection?.controller.abort(new Error('曲库服务正在关闭'));this.activeRecoveryAction?.controller.abort(new Error('曲库服务正在关闭'));this.activeCommit?.controller.abort(new Error('曲库服务正在关闭'));this.activeCommitInspection?.controller.abort(new Error('曲库服务正在关闭'));this.activeReprobe?.controller.abort(new Error('曲库服务正在关闭'));this.activeRestore?.controller.abort(new Error('曲库服务正在关闭'));this.activeRestoreInspection?.controller.abort(new Error('曲库服务正在关闭'));this.activeRestoreReprobe?.controller.abort(new Error('曲库服务正在关闭'));this.tokens.clear();}
 private context(draft:TagWriteDraft,ownerJobId?:string,reviewLeaseRevision?:number,basisVersion:1|2=2){const c=this.db.tagWriteContext(draft.itemId,ownerJobId,reviewLeaseRevision,basisVersion);if(!c.eligible)throw new Error(c.reason);if(c.fingerprint!==draft.fingerprint)throw new Error('歌曲资料或来源权限已变化，请重新读取');for(const f of draft.fields)if(f.origin==='library'){const field=c.fields.find(v=>v.field===f.field);if(!field?.libraryAllowed||JSON.stringify(field.values)!==JSON.stringify(f.values))throw new Error('所选曲库值未取得写回权限或已变化');}return c;}
 private frozenContext(snapshot:TagWriteFrozenSnapshot,ownerJobId?:string,reviewLeaseRevision?:number){const version=snapshot.basisVersion??1;if(version!==1&&version!==2)throw new Error('冻结标签审核依据版本不受支持');return this.context(snapshot.draft,ownerJobId,reviewLeaseRevision,version);}
 private async source(itemId:string,ownerJobId?:string):Promise<{rootPath:string;realRootPath:string;rootAnchor:WatchAnchor;fullPath:string;relativePath:string;before:MediaStat;fileObservation:string}> {
  const {item,rootPath}=this.db.mediaSource(itemId,ownerJobId);if(!item.fileObservation)throw new Error('此文件尚无扫描观察，请重新扫描后再预览');
  const binding=this.db.tagWriteRootBinding(itemId),rootAnchor=await probeWatchRoot(rootPath);
  if(binding.path!==rootPath||binding.anchor&&!sameWatchAnchor(binding.anchor,rootAnchor))throw new Error('音乐目录身份已变化，请先核对目录设置');
  const fullPath=path.resolve(item.path),realRootPath=rootAnchor.realPath,realFilePath=await fs.realpath(fullPath),relativePath=path.relative(rootPath,fullPath);
  if(!insideMediaRoot(rootPath,fullPath)||!insideMediaRoot(realRootPath,realFilePath)||!relativePath||path.isAbsolute(relativePath))throw new Error('歌曲不在已授权的音乐目录内');
  const before=mediaStat(await fs.lstat(fullPath));
  const big=await fs.lstat(fullPath,{bigint:true});if(!big.isFile()||big.isSymbolicLink()||big.nlink!==1n||fileObservation(big)!==item.fileObservation)throw new Error('歌曲文件已变化或为共享链接，请重新扫描');
  if(!sameMediaStat(before,mediaStat(await fs.lstat(fullPath))))throw new Error('读取文件观察时来源已变化');
  if(!sameWatchAnchor(rootAnchor,await probeWatchRoot(rootPath)))throw new Error('音乐目录读取期间已变化');
  if(item.fileStamp!==`${before.size}:${Math.trunc(before.mtimeMs)}`)throw new Error('歌曲大小或时间与曲库不一致，请重新扫描');
  return {rootPath,realRootPath,rootAnchor,fullPath,relativePath,before,fileObservation:item.fileObservation};
 }
 private async checkSource(snapshot:TagWriteFrozenSnapshot,ownerJobId?:string):Promise<void> {
  const actual=await this.source(snapshot.draft.itemId,ownerJobId);
  if(actual.rootPath!==snapshot.rootPath||actual.realRootPath!==snapshot.realRootPath||!sameWatchAnchor(actual.rootAnchor,snapshot.rootAnchor)||actual.fullPath!==snapshot.fullPath||actual.relativePath!==snapshot.relativePath||actual.fileObservation!==snapshot.fileObservation||!sameMediaStat(actual.before,snapshot.before))throw new Error('预览后的歌曲文件已变化，请重新预览');
 }
 preview(value:unknown):Promise<TagWritePreview> {
  const draft=readTagWriteDraft(value),identity=JSON.stringify(draft),known=this.requests.get(draft.requestId);if(known){if(known.identity!==identity)throw new Error('标签预览 ID 已用于其他内容');return known.result;}
  if(this.requests.size>=8)throw new Error('标签预览任务过多，请稍后重试');this.sweep();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('标签预览等待超时')),55000);
  const result=this.buildPreview(draft,controller.signal).finally(()=>{clearTimeout(timer);this.requests.delete(draft.requestId);});this.requests.set(draft.requestId,{identity,controller,result});return result;
 }
 private async buildPreview(draft:TagWriteDraft,signal:AbortSignal):Promise<TagWritePreview> {
  const context=this.context(draft),source=await this.source(draft.itemId);signal.throwIfAborted();
  const rights=draft.fields.map(f=>({field:f.field,origin:f.origin,fingerprint:f.origin==='manual'?'user-declared-private-tag-v1':context.fields.find(p=>p.field===f.field)!.rightsFingerprint}));
  const snapshot:TagWriteFrozenSnapshot={basisVersion:2,draft,fingerprint:context.fingerprint,...source,rights};
  const changes=readTagFieldChanges(draft.fields.map(f=>({field:f.field,values:f.values})));
  const {rootPath,realRootPath,fullPath,relativePath,before}=source;
  const preview=await this.parser.flacTagPreview({rootPath,realRootPath,fullPath,relativePath,before,tagChanges:changes},signal);
  if(preview.embeddedCueSheet)throw new Error('文件内含内嵌 CUE 编排，暂不支持单曲写回');
  await this.checkSource(snapshot);this.context(draft);signal.throwIfAborted();
  const result:TagWritePreview={token:randomUUID(),expiresAt:Date.now()+300000,context,draft,preview},bytes=Buffer.byteLength(JSON.stringify({result,snapshot}),'utf8');this.sweep();
  if(this.tokens.size>=64||[...this.tokens.values()].reduce((sum,p)=>sum+p.bytes,0)+bytes>8*1024*1024)throw new Error('标签预览缓存已满，请等待旧预览过期');
  this.tokens.set(result.token,{value:structuredClone(result),snapshot:structuredClone(snapshot),bytes});return result;
 }
 prepareInFlight(id:string):boolean{return this.prepareFlights.has(id);}
 abandonPrepareToken(value:unknown):void{const q=readTagWritePrepareRequest(value);if(this.prepareFlights.has(q.commandId))throw new Error('原保存仍在进行，不能放弃原预览');if(this.db.tagWriteJobs.prepareReceipt(q))throw new Error('原任务已经保存');this.tokens.delete(q.token);}
 async prepare(value:unknown):Promise<TagWriteJob>{const q=readTagWritePrepareRequest(value),identity=JSON.stringify(q),known=this.db.tagWriteJobs.prepareReceipt(q);if(known)return Promise.resolve(known);const flight=this.prepareFlights.get(q.commandId);if(flight){if(flight.identity!==identity)throw new Error('原保存命令内容已经变化');return flight.result;}if(this.maintenanceOwner||this.prepareFlights.size>=8)throw new Error('曲库正在维护或保存请求过多，请等待原请求');const result=this.performPrepare(q).finally(()=>this.prepareFlights.delete(q.commandId));this.prepareFlights.set(q.commandId,{identity,result});return result;}
 private async performPrepare(value:unknown):Promise<TagWriteJob> {
  const request=readTagWritePrepareRequest(value),known=this.db.tagWriteJobs.prepareReceipt(request);if(known)return known;
  this.sweep();const pending=this.tokens.get(request.token);if(!pending)throw new Error('标签预览已过期，请重新预览');
  const {value:preview,snapshot}=pending;if(!preview.preview.changed)throw new Error('所选标签没有变化，无需保存任务');
  await this.checkSource(snapshot);const current=this.frozenContext(snapshot);
  if(this.maintenanceOwner||this.tokens.get(request.token)!==pending||preview.expiresAt<=Date.now())throw new Error('标签预览已过期或已取消，请重新预览');
  const plan:TagWritePlan={version:1,jobId:randomUUID(),itemId:current.itemId,fileId:current.fileId,contentRevision:current.contentRevision,adapter:FLAC_TAG_ADAPTER,certificateId:null,preview:preview.preview,changes:snapshot.draft.fields.map(f=>({field:f.field,values:f.values}))};
  return this.db.tagWriteJobs.prepare(request,plan,snapshot,current.title);
 }
 async startStage(value:unknown):Promise<TagWriteJob> {
  const request=readTagWriteCancelRequest(value);this.db.restorePolicy.assertTagJob(request.jobId);const known=this.db.tagWriteJobs.stageReceipt(request);if(known)return known;
  if(this.maintenanceOwner)throw new Error('曲库正在维护或清理备份，暂不能开始标签暂存');if(!this.runtime||!this.journal||!this.writer)throw new Error('标签暂存组件尚未配置');if(this.activeStage||this.activeInspection||this.activeRecoveryAction||this.activeCommit||this.activeCommitInspection||this.activeReprobe||this.activeRestoreReprobe||this.activeRestoreInspection||this.activeRestore||!this.restorer?.quiescent||!this.committer?.quiescent||!this.writer.quiescent||!this.inspector?.quiescent)throw new Error('已有暂存或核对任务在运行，或进程退出尚未确认，请等待完成或重启后恢复');
  const active={jobId:request.jobId,controller:new AbortController()} as NonNullable<TagWriteManager['activeStage']>;this.activeStage=active;
  try{
   const {plan,snapshot,job}=this.db.tagWriteJobs.material(request.jobId);if(job.staging)throw new Error('此任务已有暂存或恢复记录，请从任务列表继续处理');
   this.journal.assertPlanBudget(plan);await this.checkSource(snapshot);this.frozenContext(snapshot);active.controller.signal.throwIfAborted();
   const capacity=new TagBackupStorage(this.db,this.runtime.dataDir);try{await capacity.assertCapacity(plan.preview.sourceFileBytes,active.controller.signal);}finally{await capacity.close();}
   const backupDir=path.join(this.runtime.dataDir,'tag-backups');await fs.mkdir(backupDir,{recursive:true});active.controller.signal.throwIfAborted();
   // The durable command is committed before any worker can create an artifact.
   const result=this.db.tagWriteJobs.startStage(request,this.frozenContext(snapshot).fingerprint,backupDir),executionId=result.staging!.executionId;
   active.finished=this.runStage(executionId,result.id,active.controller.signal).finally(()=>{if(this.activeStage===active)this.activeStage=null;});void active.finished.catch(()=>{});this.notify(result.id);return result;
  }catch(e){if(this.activeStage===active)this.activeStage=null;throw e;}
 }
 async stageTarget(value:unknown):Promise<{fileId:string;observation:string}> {const request=readTagWriteCancelRequest(value);this.db.restorePolicy.assertTagJob(request.jobId);const {plan,snapshot,job}=this.db.tagWriteJobs.material(request.jobId);if(job.state!=='prepared'||job.revision!==request.baseRevision||job.staging)throw new Error('暂存任务已变化或已有执行记录，请刷新任务列表');this.journal?.assertPlanBudget(plan);await this.checkSource(snapshot);this.frozenContext(snapshot);return {fileId:plan.fileId,observation:snapshot.fileObservation};}
 startReprobe(value:unknown):TagWriteJob {
  const request=readTagCommitReprobeRequest(value);this.db.restorePolicy.assertTagJob(request.jobId);const known=this.db.tagWriteJobs.reprobeReceipt(request);if(known)return known;
  if(!this.runtime||!this.journal||!this.commitJournal||!this.writer||!this.inspector||!this.committer)throw new Error('曲库重新解析组件尚未配置');
  if(this.activeStage||this.activeInspection||this.activeRecoveryAction||this.activeCommit||this.activeCommitInspection||this.activeReprobe||this.activeRestoreReprobe||this.activeRestoreInspection||this.activeRestore||!this.restorer?.quiescent||!this.writer.quiescent||!this.inspector.quiescent||!this.committer.quiescent)throw new Error('已有文件操作运行或退出尚未确认');
  const job=this.db.tagWriteJobs.beginReprobe(request),active={id:request.commandId,jobId:job.id,controller:new AbortController()} as NonNullable<TagWriteManager['activeReprobe']>;
  this.activeReprobe=active;active.finished=this.runReprobe(active.id,job.id,active.controller.signal).finally(()=>{if(this.activeReprobe===active)this.activeReprobe=null;});void active.finished.catch(()=>{});this.notify(job.id);return job;
 }
 cancelReprobe(value:unknown):TagWriteJob {
  const request=readTagCommitReprobeCancel(value),known=this.db.tagWriteJobs.reprobeCancelReceipt(request);if(known)return known;
  if(!this.activeReprobe||this.activeReprobe.id!==request.reprobeId)throw new Error('此重新解析不在当前会话运行，请刷新任务');
  const job=this.db.tagWriteJobs.requestReprobeCancel(request);this.activeReprobe.controller.abort(new Error('用户已停止重新解析，文件及恢复占用保留'));this.notify(job.id);return job;
 }
 releaseReprobe(id:string):Promise<void> {
  if(this.activeReprobe?.id===id&&!this.activeReprobe.releaseReady)return Promise.resolve();
  const known=this.commitReleases.get(id);if(known)return known;
  const work=this.releaseReprobeNow(id).finally(()=>{if(this.commitReleases.get(id)===work)this.commitReleases.delete(id);});this.commitReleases.set(id,work);return work;
 }
 private async releaseReprobeNow(id:string):Promise<void>{
  if(!this.runtime)throw new Error('曲库提交释放组件尚未配置');const {row,descriptor:d,apply}=this.db.tagWriteJobs.reprobeReleaseBinding(id);this.db.restorePolicy.assertTagJob(row.job_id);
  if(apply){
   const proof=JSON.parse(row.proof_json!) as TagCommitReprobeProof;
   // A retry may run long after the DB transaction, including after restart.
   // Recheck the actual observation before releasing the old read owner.
   try{await this.reprobeSource(d,proof.observation);}catch(e){this.db.tagWriteJobs.invalidateReprobeObservation(id);this.notify(row.job_id,`曲库已提交，但文件或目录随后变化，需重新扫描：${String(e instanceof Error?e.message:e)}`);}
   const current=this.db.tagWriteJobs.reprobeReleaseBinding(id);
   if(current.apply){this.parser.releaseRecoveredFile(d.worker.binding.fullPath,row.lease_id);this.runtime.releaseRecovered(d.worker.binding.fullPath,row.lease_id);}
  }
  this.db.tagWriteJobs.confirmReprobeRelease(id);this.runtime.invalidated?.(row.job_id);this.notify(row.job_id);
 }
 private async reprobeSource(d:TagStageDescriptor,expected?:string){
  await this.recoveryRoot(d);const w=d.worker,fullPath=w.binding.fullPath,big=await fs.lstat(fullPath,{bigint:true}),observation=fileObservation(big),normal=(v:string)=>process.platform==='win32'?path.resolve(v).toLowerCase():path.resolve(v);
  if(!big.isFile()||big.isSymbolicLink()||big.nlink!==1n||normal(await fs.realpath(fullPath))!==normal(fullPath)||expected!==undefined&&observation!==expected)throw new Error('实际目标文件的路径或观察已变化，请重新核对');
  const before=mediaStat(await fs.lstat(fullPath));if(fileObservation(await fs.lstat(fullPath,{bigint:true}))!==observation||before.size!==Number(big.size))throw new Error('目标文件观察读取期间变化');
  return {observation,input:{rootPath:w.binding.rootPath,realRootPath:w.binding.realRootPath,fullPath,relativePath:w.binding.relativePath,before}};
 }
 private async runReprobe(id:string,jobId:string,signal:AbortSignal):Promise<void>{
  let lastNotice=performance.now()-2000,committed=false;
  try{
   const {row,operation,descriptor:d,binding,report}=this.db.tagWriteJobs.reprobeBinding(id),w=d.worker;
   const waiting=Promise.all([this.parser.quiesceFile(w.binding.fullPath,row.lease_id),this.runtime!.quiesce(w.plan.fileId,w.binding.fullPath,row.lease_id)]);let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([waiting,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取组件未在35秒内退出，重新解析占用保留')),35000);})]);}finally{if(timer)clearTimeout(timer);}
   signal.throwIfAborted();await this.recoveryRoot(d);this.db.tagWriteJobs.reprobeBinding(id);
   const three=this.inspectionInput(id,d),inspection:TagCommitInspectionRequest={...three,version:2,kind:'inspect-commit',files:[...three.files,{role:'victim',path:path.join(path.dirname(w.binding.fullPath),`.aural-${jobId}-${binding.request.victimArtifactId}.victim`)}]};
   const progress=(p:{role:string;bytes:string;total:string})=>{if(performance.now()-lastNotice>=2000||p.bytes===p.total){lastNotice=performance.now();this.db.tagWriteJobs.reprobeProgress(id,p.role,p.bytes,p.total);this.notify(jobId);}};
   const before=await this.inspector!.runCommit(inspection,progress,signal);assertCommitInspectionEqual(report.actual,before);
   const source=await this.reprobeSource(d);this.db.tagWriteJobs.reprobeBinding(id);signal.throwIfAborted();
   this.db.tagWriteJobs.reprobeProgress(id,'fields');this.notify(jobId);
   const preview=await this.parser.flacTagPreviewOwned({...source.input,tagChanges:binding.plan.changes},row.lease_id,signal);await this.reprobeSource(d,source.observation);this.db.tagWriteJobs.reprobeBinding(id);
   this.db.tagWriteJobs.reprobeProgress(id,'tags');this.notify(jobId);
   const parsed=await this.parser.parseOwned(source.input,row.lease_id,signal);await this.reprobeSource(d,source.observation);this.db.tagWriteJobs.reprobeBinding(id);
   const after=await this.inspector!.runCommit(inspection,progress,signal);await this.reprobeSource(d,source.observation);signal.throwIfAborted();
   const staged=await this.journal!.read(jobId);this.db.tagWriteJobs.inspectJournal(w.executionId,staged);if(staged.receiptSha256!==binding.stagingJournalSha256)throw new Error('重新解析引用的原暂存日志已变化');
   const journal=await this.commitJournal!.read(row.operation_id);this.db.tagWriteJobs.assertReprobeJournal(id,journal);
   const proof:TagCommitReprobeProof={mode:row.mode,originalExitConfirmed:operation.exit_confirmed===1,journalRevision:journal.revision,before,after,preview,parsed,stat:source.input.before,observation:source.observation,journalSha256:journal.sha256,stagingJournalSha256:staged.receiptSha256};validateCommitReprobeProof(proof,binding,journal,w.binding);
   await this.reprobeSource(d,source.observation);this.db.tagWriteJobs.reprobeProgress(id,'library');signal.throwIfAborted();this.db.commitTagReprobe(id,proof,journal);committed=true;
   // Snapshot validity ends before the DB transaction; check again before
   // releasing application gates. Later external changes remain watcher work.
   try{await this.reprobeSource(d,source.observation);}catch(e){this.db.tagWriteJobs.invalidateReprobeObservation(id);this.notify(jobId,`曲库已提交，但文件随后变化，需重新扫描：${String(e instanceof Error?e.message:e)}`);}
   if(this.activeReprobe?.id===id)this.activeReprobe.releaseReady=true;
   await this.releaseReprobe(id);
  }catch(e){const message=String(e instanceof Error?e.message:e);if(!committed)try{this.db.tagWriteJobs.failReprobe(id,message,signal.aborted);}catch{}this.notify(jobId,message);}
  // Failed/cancelled work keeps recovery gates. A completed DB transaction has
  // a durable cleanup receipt retried by startup/periodic service reconciliation.
 }


 startRestoreReprobe(value:unknown):TagWriteJob {
  const request=readTagRestoreReprobeRequest(value);this.db.restorePolicy.assertTagJob(request.jobId);const known=this.db.tagWriteJobs.restoreReprobeReceipt(request);if(known)return known;
  if(!this.runtime||!this.journal||!this.commitJournal||!this.restoreJournal||!this.writer||!this.inspector||!this.committer||!this.restorer)throw new Error('恢复来源重新解析组件尚未配置');
  if(this.activeStage||this.activeInspection||this.activeRecoveryAction||this.activeCommit||this.activeCommitInspection||this.activeReprobe||this.activeRestoreReprobe||this.activeRestoreInspection||this.activeRestore||!this.restorer.quiescent||!this.writer.quiescent||!this.inspector.quiescent||!this.committer.quiescent)throw new Error('已有文件操作运行或退出尚未确认');
  const job=this.db.tagWriteJobs.beginRestoreReprobe(request),active={id:request.commandId,jobId:job.id,controller:new AbortController()} as NonNullable<TagWriteManager['activeRestoreReprobe']>;
  this.activeRestoreReprobe=active;active.finished=this.runRestoreReprobe(active.id,job.id,active.controller.signal).finally(()=>{if(this.activeRestoreReprobe===active)this.activeRestoreReprobe=null;});void active.finished.catch(()=>{});this.notify(job.id);return job;
 }
 cancelRestoreReprobe(value:unknown):TagWriteJob {
  const request=readTagRestoreReprobeCancel(value),known=this.db.tagWriteJobs.restoreReprobeCancelReceipt(request);if(known)return known;
  if(!this.activeRestoreReprobe||this.activeRestoreReprobe.id!==request.reprobeId)throw new Error('此恢复来源重新解析不在当前会话运行，请刷新任务');
  const job=this.db.tagWriteJobs.requestRestoreReprobeCancel(request);this.activeRestoreReprobe.controller.abort(new Error('用户已停止重新解析，文件及恢复占用保留'));this.notify(job.id);return job;
 }
 releaseRestoreReprobe(id:string):Promise<void> {
  if(this.activeRestoreReprobe?.id===id&&!this.activeRestoreReprobe.releaseReady)return Promise.resolve();
  const known=this.restoreReleases.get(id);if(known)return known;
  const work=this.releaseRestoreReprobeNow(id).finally(()=>{if(this.restoreReleases.get(id)===work)this.restoreReleases.delete(id);});this.restoreReleases.set(id,work);return work;
 }
 private async releaseRestoreReprobeNow(id:string):Promise<void>{
  if(!this.runtime)throw new Error('恢复曲库释放组件尚未配置');const {row,descriptor:d,apply}=this.db.tagWriteJobs.restoreReprobeReleaseBinding(id);this.db.restorePolicy.assertTagJob(row.job_id);
  if(apply){
   const proof=JSON.parse(row.proof_json!) as TagRestoreReprobeProof;
   // Retry/startup cleanup must also reject a changed on-disk observation.
   try{await this.reprobeSource(d,proof.observation);}catch(e){this.db.tagWriteJobs.invalidateRestoreReprobeObservation(id);this.notify(row.job_id,`曲库已恢复，但文件或目录随后变化，需重新扫描：${String(e instanceof Error?e.message:e)}`);}
   const current=this.db.tagWriteJobs.restoreReprobeReleaseBinding(id);
   if(current.apply){this.parser.releaseRecoveredFile(d.worker.binding.fullPath,row.lease_id);this.runtime.releaseRecovered(d.worker.binding.fullPath,row.lease_id);}
  }
  this.db.tagWriteJobs.confirmRestoreReprobeRelease(id);this.runtime.invalidated?.(row.job_id);this.notify(row.job_id);
 }
 private async runRestoreReprobe(id:string,jobId:string,signal:AbortSignal):Promise<void>{
  let lastNotice=performance.now()-2000,committed=false;
  try{
   const {row,operation,descriptor:d,binding,report,commitExitConfirmed}=this.db.tagWriteJobs.restoreReprobeBinding(id),w=d.worker;
   const waiting=Promise.all([this.parser.quiesceFile(w.binding.fullPath,row.lease_id),this.runtime!.quiesce(w.plan.fileId,w.binding.fullPath,row.lease_id)]);let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([waiting,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取组件未在35秒内退出，重新解析占用保留')),35000);})]);}finally{if(timer)clearTimeout(timer);}
   signal.throwIfAborted();await this.recoveryRoot(d);this.db.tagWriteJobs.restoreReprobeBinding(id);
   const directory=path.dirname(w.binding.fullPath),inspection:TagRestoreInspectionRequest={version:3,kind:'inspect-restore',inspectionId:id,sourceRoot:binding.request.sourceRoot,backupRoot:binding.request.backupRoot,files:[...binding.request.files,{role:'replacement',path:path.join(directory,`.aural-${jobId}-${binding.request.replacementArtifactId}.restore`)},{role:'displaced',path:path.join(directory,`.aural-${jobId}-${binding.request.displacedArtifactId}.displaced`)}]};
   const progress=(p:{role:string;bytes:string;total:string})=>{if(performance.now()-lastNotice>=2000||p.bytes===p.total){lastNotice=performance.now();this.db.tagWriteJobs.restoreReprobeProgress(id,p.role,p.bytes,p.total);this.notify(jobId);}};
   const before=await this.inspector!.runRestore(inspection,progress,signal);assertTagRestoreInspectionEqual(report.actual,before);
   const source=await this.reprobeSource(d);this.db.tagWriteJobs.restoreReprobeBinding(id);signal.throwIfAborted();
   this.db.tagWriteJobs.restoreReprobeProgress(id,'fields');this.notify(jobId);
   const preview=await this.parser.flacTagPreviewOwned({...source.input,tagChanges:tagRestorePreviewChanges(binding)},row.lease_id,signal);await this.reprobeSource(d,source.observation);this.db.tagWriteJobs.restoreReprobeBinding(id);
   this.db.tagWriteJobs.restoreReprobeProgress(id,'tags');this.notify(jobId);
   const parsed=await this.parser.parseOwned(source.input,row.lease_id,signal);await this.reprobeSource(d,source.observation);this.db.tagWriteJobs.restoreReprobeBinding(id);
   const after=await this.inspector!.runRestore(inspection,progress,signal);await this.reprobeSource(d,source.observation);signal.throwIfAborted();
   const staged=await this.journal!.read(jobId);this.db.tagWriteJobs.inspectJournal(w.executionId,staged);if(staged.receiptSha256!==binding.request.stagingJournalSha256)throw new Error('重新解析引用的原暂存日志已变化');
   const original=await this.commitJournal!.read(operation.commit_operation_id);this.db.tagWriteJobs.inspectCommitJournal(operation.commit_operation_id,original);if(original.revision!==binding.commitJournalRevision||original.sha256!==binding.request.commitJournalSha256)throw new Error('恢复来源链接的原提交日志已变化');
   const journal=await this.restoreJournal!.read(row.operation_id);this.db.tagWriteJobs.assertRestoreReprobeJournal(id,journal);
   const proof:TagRestoreReprobeProof={mode:row.mode,originalExitConfirmed:operation.exit_confirmed===1,commitExitConfirmed,journalRevision:journal.revision,before,after,preview,parsed,stat:source.input.before,observation:source.observation,journalSha256:journal.sha256,commitJournalSha256:original.sha256,stagingJournalSha256:staged.receiptSha256};validateRestoreReprobeProof(proof,binding,journal,w.binding);
   await this.reprobeSource(d,source.observation);this.db.tagWriteJobs.restoreReprobeProgress(id,'library');signal.throwIfAborted();this.db.commitTagRestoreReprobe(id,proof,journal);committed=true;
   // Snapshot validity ends before the DB transaction; check again before
   // releasing application gates. Later external changes remain watcher work.
   try{await this.reprobeSource(d,source.observation);}catch(e){this.db.tagWriteJobs.invalidateRestoreReprobeObservation(id);this.notify(jobId,`曲库已提交，但文件随后变化，需重新扫描：${String(e instanceof Error?e.message:e)}`);}
   if(this.activeRestoreReprobe?.id===id)this.activeRestoreReprobe.releaseReady=true;
   await this.releaseRestoreReprobe(id);
  }catch(e){const message=String(e instanceof Error?e.message:e);if(!committed)try{this.db.tagWriteJobs.failRestoreReprobe(id,message,signal.aborted);}catch{}this.notify(jobId,message);}
  // Failed/cancelled work keeps recovery gates. A completed DB transaction has
  // a durable cleanup receipt retried by startup/periodic service reconciliation.
 }
 startRestoreInspection(value:unknown):TagWriteJob {
  const request=readTagWriteCancelRequest(value);this.db.restorePolicy.assertTagJob(request.jobId);const known=this.db.tagWriteJobs.restoreInspectionReceipt(request);if(known)return known;
  if(!this.runtime||!this.journal||!this.commitJournal||!this.restoreJournal||!this.writer||!this.inspector||!this.committer||!this.restorer)throw new Error('六文件核对组件尚未配置');
  if(this.activeStage||this.activeInspection||this.activeRecoveryAction||this.activeCommit||this.activeCommitInspection||this.activeReprobe||this.activeRestoreReprobe||this.activeRestoreInspection||this.activeRestore||!this.restorer.quiescent||!this.writer.quiescent||!this.inspector.quiescent||!this.committer.quiescent)throw new Error('已有文件操作运行或进程退出尚未确认');
  const job=this.db.tagWriteJobs.beginRestoreInspection(request),active={id:request.commandId,jobId:job.id,controller:new AbortController()} as NonNullable<TagWriteManager['activeRestoreInspection']>;
  this.activeRestoreInspection=active;active.finished=this.runRestoreInspection(active.id,job.id,active.controller.signal).finally(()=>{if(this.activeRestoreInspection===active)this.activeRestoreInspection=null;});void active.finished.catch(()=>{});this.notify(job.id);return job;
 }
 cancelRestoreInspection(value:unknown):TagWriteJob {
  const request=readTagRecoveryCancel(value),known=this.db.tagWriteJobs.restoreInspectionCancelReceipt(request);if(known)return known;
  if(!this.activeRestoreInspection||this.activeRestoreInspection.id!==request.inspectionId)throw new Error('此六文件核对不在当前会话运行，请刷新状态');
  const job=this.db.tagWriteJobs.requestRestoreInspectionCancel(request);this.activeRestoreInspection.controller.abort(new Error('用户已停止六文件核对，文件及恢复占用保留'));this.notify(job.id);return job;
 }
 private async runRestoreInspection(id:string,jobId:string,signal:AbortSignal):Promise<void>{
  let lastNotice=performance.now()-2000;
  try{
   const {row,descriptor:d,commit}=this.db.tagWriteJobs.restoreInspectionBinding(id),w=d.worker;await this.recoveryRoot(d);signal.throwIfAborted();
   const waiting=Promise.all([this.parser.quiesceFile(w.binding.fullPath,row.lease_id),this.runtime!.quiesce(w.plan.fileId,w.binding.fullPath,row.lease_id)]);let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([waiting,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取组件未在35秒内退出，六文件恢复占用保留')),35000);})]);}finally{if(timer)clearTimeout(timer);}
   signal.throwIfAborted();await this.recoveryRoot(d);this.db.tagWriteJobs.restoreInspectionBinding(id);
   const directory=path.dirname(w.binding.fullPath),prefix=`.aural-${jobId}-`,input:TagRestoreInspectionRequest={...this.inspectionInput(id,d),version:3,kind:'inspect-restore',files:[...this.inspectionInput(id,d).files,{role:'victim',path:path.join(directory,`${prefix}${commit.request.victimArtifactId}.victim`)},{role:'replacement',path:path.join(directory,`${prefix}${row.replacement_artifact_id}.restore`)},{role:'displaced',path:path.join(directory,`${prefix}${row.displaced_artifact_id}.displaced`)}]};
   readTagRestoreInspectionRequest(input);
   const actual=await this.inspector!.runRestore(input,p=>{if(performance.now()-lastNotice>=2000||p.bytes===p.total){lastNotice=performance.now();this.db.tagWriteJobs.restoreInspectionProgress(id,p);this.notify(jobId);}},signal);
   signal.throwIfAborted();await this.recoveryRoot(d);const {binding}=this.db.tagWriteJobs.restoreInspectionBinding(id);
   const report:TagRestoreRecoveryReport={classification:binding?'journal-unconfirmed':'binding-unavailable',journal:'unconfirmed',phase:null,journalEvidence:null,commitJournalSha256:null,stagingJournalSha256:null,reason:binding?'恢复日志尚未核对，文件及恢复占用保留':'恢复尚未冻结实际来源绑定，不以旧提交日志推定恢复结果；文件和占用保留',actual};
   if(!binding)try{
    this.db.tagWriteJobs.assertRestoreUnbound(row.id);await this.restoreJournal!.assertUnstarted(row.id);
    const staged=await this.journal!.read(jobId),original=await this.commitJournal!.read(row.commit_operation_id);
    const checked=this.db.tagWriteJobs.proveUnstartedRestore(row.id,actual,staged,original);
    await this.restoreJournal!.assertUnstarted(row.id);this.db.tagWriteJobs.assertRestoreUnbound(row.id);Object.assign(report,checked);
   }catch(e){report.reason=`恢复准备状态无法确认，现有文件与占用保留：${String(e instanceof Error?e.message:e).slice(0,500)}`;}
   if(binding)try{
    const staged=await this.journal!.read(jobId);this.db.tagWriteJobs.inspectJournal(d.worker.executionId,staged);if(staged.receiptSha256!==binding.request.stagingJournalSha256)throw new Error('原暂存日志与恢复来源不符');
    const original=await this.commitJournal!.read(row.commit_operation_id);this.db.tagWriteJobs.inspectCommitJournal(row.commit_operation_id,original);if(original.revision!==binding.commitJournalRevision||original.sha256!==binding.request.commitJournalSha256)throw new Error('恢复所链接的原提交日志已变化');
    const journal=await this.restoreJournal!.read(row.id),status=this.db.tagWriteJobs.inspectRestoreJournal(row.id,journal),classification=classifyTagRestoreRecovery(actual,binding,journal);
    const reasons:Record<typeof classification,string>={
     'unstarted-restore':'上次恢复尚未开始移动文件，可确认后继续恢复',
     'unchanged-before-restore':'原路径及保留文件仍符合恢复前状态，尚未观察到恢复移动；恢复占用保留',
     'source-prepared':'恢复来源已准备，实际身份及内容符合持久阶段，尚未放回歌曲原路径',
     'copy-unconfirmed':'观察到恢复副本，但尚无完整准备阶段证据；可能是部分复制，文件和占用保留',
     'target-displaced':'歌曲原路径明确缺失，已准备来源及保留目标符合证据；仍需后续恢复处理',
     'restored-source':'歌曲原路径已是恢复来源，保留文件和日志符合核对证据；尚需重新解析和曲库恢复',
     'recovery-required':'文件状态、物理身份、内容或目录无法证明符合恢复日志；保留全部文件及占用',
     'binding-unavailable':'恢复实际来源绑定无法确认，保留文件及占用',
     'journal-unconfirmed':'恢复日志无法确认，保留文件及占用'
    };
    report.classification=classification;report.journal=status;report.phase=journal.stages.at(-1)?.phase??null;report.journalEvidence={revision:journal.revision,sha256:journal.sha256};report.commitJournalSha256=original.sha256;report.stagingJournalSha256=staged.receiptSha256;report.reason=reasons[classification]+(status==='fs-ahead'?'；文件日志先于数据库持久回执':'');
   }catch(e){report.reason=`恢复日志证据无法确认，保留全部文件和恢复占用：${String(e instanceof Error?e.message:e).slice(0,500)}`;}
   signal.throwIfAborted();this.db.tagWriteJobs.finishRestoreInspection(id,report);this.notify(jobId);
  }catch(e){const message=String(e instanceof Error?e.message:e);try{this.db.tagWriteJobs.failRestoreInspection(id,message,signal.aborted,this.inspector?.quiescent??false);}catch{}this.notify(jobId,message);}
  // Read-only snapshot: original commit/restore histories and read owner stay intact.
 }
 startCommitInspection(value:unknown):TagWriteJob {
  const request=readTagWriteCancelRequest(value);this.db.restorePolicy.assertTagJob(request.jobId);const known=this.db.tagWriteJobs.commitInspectionReceipt(request);if(known)return known;
  if(!this.runtime||!this.journal||!this.commitJournal||!this.writer||!this.inspector||!this.committer)throw new Error('四工件核对组件尚未配置');
  if(this.activeStage||this.activeInspection||this.activeRecoveryAction||this.activeCommit||this.activeCommitInspection||this.activeReprobe||this.activeRestoreReprobe||this.activeRestoreInspection||this.activeRestore||!this.restorer?.quiescent||!this.writer.quiescent||!this.inspector.quiescent||!this.committer.quiescent)throw new Error('已有文件操作运行或进程退出尚未确认');
  const job=this.db.tagWriteJobs.beginCommitInspection(request),active={id:request.commandId,jobId:job.id,controller:new AbortController()} as NonNullable<TagWriteManager['activeCommitInspection']>;
  this.activeCommitInspection=active;active.finished=this.runCommitInspection(active.id,job.id,active.controller.signal).finally(()=>{if(this.activeCommitInspection===active)this.activeCommitInspection=null;});void active.finished.catch(()=>{});this.notify(job.id);return job;
 }
 cancelCommitInspection(value:unknown):TagWriteJob {
  const request=readTagRecoveryCancel(value),known=this.db.tagWriteJobs.commitInspectionCancelReceipt(request);if(known)return known;
  if(!this.activeCommitInspection||this.activeCommitInspection.id!==request.inspectionId)throw new Error('此四工件核对不在当前会话运行，请刷新状态');
  const result=this.db.tagWriteJobs.requestCommitInspectionCancel(request);this.activeCommitInspection.controller.abort(new Error('用户已停止四工件核对，文件和恢复占用保留'));this.notify(result.id);return result;
 }
 private async runCommitInspection(id:string,jobId:string,signal:AbortSignal):Promise<void>{
  let lastNotice=performance.now()-2000;
  try{
   const {row,descriptor:d}=this.db.tagWriteJobs.commitInspectionBinding(id),w=d.worker;await this.recoveryRoot(d);signal.throwIfAborted();
   const waiting=Promise.all([this.parser.quiesceFile(w.binding.fullPath,row.lease_id),this.runtime!.quiesce(w.plan.fileId,w.binding.fullPath,row.lease_id)]);let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([waiting,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取组件未在35秒内退出，四工件恢复占用保留')),35000);})]);}finally{if(timer)clearTimeout(timer);}
   signal.throwIfAborted();await this.recoveryRoot(d);this.db.tagWriteJobs.commitInspectionBinding(id);
   const three=this.inspectionInput(id,d),input:TagCommitInspectionRequest={...three,version:2,kind:'inspect-commit',files:[...three.files,{role:'victim',path:path.join(path.dirname(w.binding.fullPath),`.aural-${jobId}-${row.victim_artifact_id}.victim`)}]};
   const actual=await this.inspector!.runCommit(input,p=>{if(performance.now()-lastNotice>=2000||p.bytes===p.total){lastNotice=performance.now();this.db.tagWriteJobs.commitInspectionProgress(id,p);this.notify(jobId);}},signal);
   signal.throwIfAborted();await this.recoveryRoot(d);const {binding}=this.db.tagWriteJobs.commitInspectionBinding(id);
   const report:TagCommitRecoveryReport={classification:binding?'journal-unconfirmed':'binding-unavailable',journal:'unconfirmed',phase:null,journalEvidence:null,stagingJournalSha256:null,reason:binding?'提交日志尚未核对；四工件快照不解除恢复占用':'提交尚未冻结完整实际绑定，不能用旧日志推定替换结果；文件和恢复占用保留',actual};
   if(binding)try{
    const staged=await this.journal!.read(jobId);this.db.tagWriteJobs.inspectJournal(row.execution_id,staged);if(staged.receiptSha256!==binding.stagingJournalSha256)throw new Error('提交绑定所链接的原暂存日志摘要不符');
    const journal=await this.commitJournal!.read(row.id),evidence=this.db.tagWriteJobs.inspectCommitJournal(row.id,journal),classification=classifyTagCommitRecovery(actual,binding,journal);
    const reasons:Record<typeof classification,string>={
     'unchanged-staged':'实际原文件、备份和临时文件与冻结证据一致，旧文件工件明确缺失；仍未解除恢复占用',
     'victim-moved':'原路径明确缺失，实际旧文件、备份和临时文件符合冻结证据；需要后续原生恢复或提交处理',
     'replacement-observed':'当前原路径是目标文件，实际旧文件及备份符合来源证据，临时路径明确缺失；尚未重探测或提交曲库',
     'restore-available':'原路径明确缺失且来源备份可验证；仍需显式确认的原生恢复，不自动移动文件',
     'recovery-required':'四工件的存在状态、物理身份、实际摘要或目录与日志无法证明一致；保留全部文件及占用',
     'binding-unavailable':'提交实际绑定无法确认，保留文件及占用',
     'journal-unconfirmed':'提交日志无法确认，保留文件及占用'
    };
    report.classification=classification;report.journal=evidence;report.phase=journal.stages.at(-1)?.phase??null;report.journalEvidence={revision:journal.revision,sha256:journal.sha256};report.stagingJournalSha256=staged.receiptSha256;report.reason=reasons[classification]+(evidence==='fs-ahead'?'；文件系统日志先于数据库持久回执':'');
   }catch(e){report.reason=`提交日志证据无法确认，保留四工件和恢复占用：${String(e instanceof Error?e.message:e).slice(0,500)}`;}
   signal.throwIfAborted();this.db.tagWriteJobs.finishCommitInspection(id,report);this.notify(jobId);
  }catch(e){const message=String(e instanceof Error?e.message:e);try{this.db.tagWriteJobs.failCommitInspection(id,message,signal.aborted,this.inspector?.quiescent??false);}catch{}this.notify(jobId,message);}
  // This read-only task cannot clear a lease, release gates, restore or delete.
 }
 // Internal certified restoration only; no external execution IPC is registered.
 startRestore(value:unknown):TagWriteJob {return this.startRestoreOperation(value,false);}
 retryRestore(value:unknown):TagWriteJob {return this.startRestoreOperation(value,true);}
 private startRestoreOperation(value:unknown,retry:boolean):TagWriteJob {
  const request=readTagRestoreStart(value);this.db.restorePolicy.assertTagJob(request.jobId);const known=retry?this.db.tagWriteJobs.restoreRetryReceipt(request):this.db.tagWriteJobs.restoreReceipt(request);if(known)return known;
  if(!this.runtime||!this.journal||!this.commitJournal||!this.restoreJournal||!this.restorer||!this.inspector||!this.writer||!this.committer)throw new Error('原生恢复组件尚未配置');
  if(this.activeStage||this.activeInspection||this.activeRecoveryAction||this.activeCommit||this.activeCommitInspection||this.activeReprobe||this.activeRestoreReprobe||this.activeRestoreInspection||this.activeRestore||!this.restorer.quiescent||!this.writer.quiescent||!this.inspector.quiescent||!this.committer.quiescent)throw new Error('已有文件操作运行或进程退出尚未确认');
  const result=retry?this.db.tagWriteJobs.reserveRestoreRetry(request):this.db.tagWriteJobs.reserveRestore(request),active={id:request.commandId,jobId:result.id,controller:new AbortController()} as NonNullable<TagWriteManager['activeRestore']>;
  this.activeRestore=active;active.finished=this.runRestore(active.id,active.jobId,active.controller.signal).finally(()=>{if(this.activeRestore===active)this.activeRestore=null;});void active.finished.catch(()=>{});this.notify(result.id);return result;
 }
 cancelRestore(value:unknown):TagWriteJob {
  const request=readTagRestoreCancel(value),known=this.db.tagWriteJobs.restoreCancelReceipt(request);if(known)return known;
  if(!this.activeRestore||this.activeRestore.id!==request.operationId)throw new Error('此恢复操作不在当前会话运行，请刷新状态');
  const result=this.db.tagWriteJobs.requestRestoreCancel(request);this.activeRestore.controller.abort(new Error('用户已停止恢复，所有文件及恢复占用保留'));this.notify(result.id);return result;
 }
 private async validateRestoreOwned(id:string,signal:AbortSignal):Promise<TagStageDescriptor>{signal.throwIfAborted();const {descriptor}=this.db.tagWriteJobs.restoreOwned(id);await this.recoveryRoot(descriptor);signal.throwIfAborted();this.db.tagWriteJobs.restoreOwned(id);return descriptor;}
 private async runRestore(id:string,jobId:string,signal:AbortSignal):Promise<void>{
  let lastNotice=performance.now()-2000;
  try{
   const {row,descriptor:d,commit}=this.db.tagWriteJobs.restoreOwned(id),w=d.worker;await this.recoveryRoot(d);signal.throwIfAborted();
   for(const request of this.requests.values())if((JSON.parse(request.identity) as TagWriteDraft).itemId===w.plan.itemId)request.controller.abort(new Error('歌曲正在准备文件恢复'));
   // Keep the existing blocked owner continuously held; advance only the DB epoch.
   const waiting=Promise.all([this.parser.quiesceFile(w.binding.fullPath,row.lease_id),this.runtime!.quiesce(w.plan.fileId,w.binding.fullPath,row.lease_id)]);let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([waiting,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取组件未在35秒内退出，恢复占用保留')),35000);})]);}finally{if(timer)clearTimeout(timer);}
   await this.validateRestoreOwned(id,signal);const three=this.inspectionInput(id,d),input:TagCommitInspectionRequest={...three,version:2,kind:'inspect-commit',files:[...three.files,{role:'victim',path:path.join(path.dirname(w.binding.fullPath),`.aural-${jobId}-${commit.request.victimArtifactId}.victim`)}]};
   const progress=(p:{role:string;bytes:string;total:string})=>{if(performance.now()-lastNotice>=2000||p.bytes===p.total){lastNotice=performance.now();this.db.tagWriteJobs.restoreProgress(id,{role:p.role as import('../shared/tag-restore.js').TagRestoreRole,bytes:p.bytes,total:p.total});this.notify(jobId);}};
   if(row.predecessor_id){
    const unstarted=this.db.tagWriteJobs.restoreRetryUnstarted(id);if(unstarted)await this.restoreJournal!.assertUnstarted(row.predecessor_id);
    const prior=unstarted?null:await this.restoreJournal!.read(row.predecessor_id),evidence=this.db.tagWriteJobs.restoreRetryEvidence(id,prior);
    if(!evidence)throw new Error('恢复续办缺少前次尝试');const directory=path.dirname(w.binding.fullPath),prefix=`.aural-${jobId}-`;
    const before=await this.inspector!.runRestore({version:3,kind:'inspect-restore',inspectionId:id,sourceRoot:input.sourceRoot,backupRoot:input.backupRoot,files:[...input.files,{role:'replacement',path:path.join(directory,`${prefix}${evidence.replacementArtifactId}.restore`)},{role:'displaced',path:path.join(directory,`${prefix}${evidence.displacedArtifactId}.displaced`)}]},progress,signal);
    assertTagRestoreInspectionEqual(evidence.report.actual,before);if(unstarted)await this.restoreJournal!.assertUnstarted(row.predecessor_id);
    this.db.tagWriteJobs.restoreRetryEvidence(id,unstarted?null:await this.restoreJournal!.read(row.predecessor_id));
   }
   const actual=await this.inspector!.runCommit(input,progress,signal);await this.validateRestoreOwned(id,signal);
   const staged=await this.journal!.read(jobId),original=await this.commitJournal!.read(row.commit_operation_id),binding=this.db.tagWriteJobs.freezeRestore(id,actual,staged,original);
   let journal=await this.restoreJournal!.create(binding);this.db.tagWriteJobs.recordRestoreJournal(id,journal);this.notify(jobId);
   const result=await this.restorer!.run(binding.request,async stage=>{
    // Exclusive native handles hold all present artifacts, including rename gaps.
    // Validate metadata/lease/root only; never reopen the held source path here.
    await this.validateRestoreOwned(id,signal);journal=await this.restoreJournal!.advance(id,journal.revision,stage);const receipt=this.db.tagWriteJobs.recordRestoreJournal(id,journal);this.notify(jobId);return receipt;
   },progress,signal);
   await this.validateRestoreOwned(id,signal);journal=await this.restoreJournal!.read(id);this.db.tagWriteJobs.finishNativeRestore(id,result,journal);try{this.runtime!.invalidated?.(jobId);}catch{}this.notify(jobId);
  }catch(e){const message=String(e instanceof Error?e.message:e);try{this.db.tagWriteJobs.failRestore(id,message,Boolean(this.writer?.quiescent&&this.inspector?.quiescent&&this.committer?.quiescent&&this.restorer?.quiescent));}catch{}try{this.runtime?.invalidated?.(jobId);}catch{}this.notify(jobId,message);}
  // Success and interruption retain recovery gates and all artifacts. Fresh
  // six-artifact inspection and source reprobe/library reconciliation follow.
 }
 async commitTarget(value:unknown):Promise<{fileId:string;observation:string}> {
  const request=readTagCommitStart(value);this.db.restorePolicy.assertTagJob(request.jobId);assertTagCommitCertified(request.certificateId);
  const {plan,snapshot,job}=this.db.tagWriteJobs.material(request.jobId);
  if(job.state!=='prepared'||job.revision!==request.baseRevision||job.staging?.state!=='staged'||job.nativeCommit||this.db.tagWriteJobs.contentRevision(plan.fileId)!==plan.contentRevision)throw new Error('提交要求当前已完成暂存的标签任务');
  this.db.tagWriteJobs.assertReadable(plan.fileId);await this.checkSource(snapshot);return {fileId:plan.fileId,observation:snapshot.fileObservation};
 }
 cancelCommit(value:unknown):TagWriteJob {
  const request=readTagCommitCancel(value),known=this.db.tagWriteJobs.commitCancelReceipt(request);if(known)return known;
  if(!this.activeCommit||this.activeCommit.id!==request.operationId)throw new Error('此标签提交不在当前会话运行，请核对文件状态');
  const result=this.db.tagWriteJobs.requestCommitCancel(request);this.activeCommit.controller.abort(new Error('用户已停止标签提交，保留全部文件并等待恢复核对'));this.notify(result.id);return result;
 }
 startCommit(value:unknown):TagWriteJob {
  const request=readTagCommitStart(value);this.db.restorePolicy.assertTagJob(request.jobId);const known=this.db.tagWriteJobs.commitReceipt(request);if(known)return known;
  if(!this.runtime||!this.journal||!this.commitJournal||!this.committer||!this.inspector||!this.writer)throw new Error('原生提交组件尚未配置');
  if(this.activeStage||this.activeInspection||this.activeRecoveryAction||this.activeCommit||this.activeCommitInspection||this.activeReprobe||this.activeRestoreReprobe||this.activeRestoreInspection||this.activeRestore||!this.restorer?.quiescent||!this.writer.quiescent||!this.inspector.quiescent||!this.committer.quiescent)throw new Error('已有文件操作运行或进程退出尚未确认');
  // Empty controlled certification rejects before acquiring a lease or creating files.
  const result=this.db.tagWriteJobs.reserveCommit(request),active={id:request.commandId,jobId:result.id,controller:new AbortController()} as NonNullable<TagWriteManager['activeCommit']>;
  this.activeCommit=active;active.finished=this.runCommit(active.id,active.jobId,active.controller.signal).finally(()=>{if(this.activeCommit===active)this.activeCommit=null;});void active.finished.catch(()=>{});this.notify(result.id);return result;
 }
 private async validateCommitOwned(id:string,signal:AbortSignal,checkFile=false):Promise<TagStageDescriptor>{
  signal.throwIfAborted();const {row,descriptor:d}=this.db.tagWriteJobs.commitOwned(id),{snapshot}=this.db.tagWriteJobs.material(row.job_id);
  // Preserve the review epoch before staging; all other rights/metadata fields are live.
  const c=this.frozenContext(snapshot,row.job_id,d.worker.leaseRevision-1);if(c.fileId!==row.file_id)throw new Error('提交曲目已绑定到其他文件');
  await this.recoveryRoot(d);if(checkFile)await this.checkSource(snapshot,row.job_id);signal.throwIfAborted();this.db.tagWriteJobs.commitOwned(id);return d;
 }
 private async runCommit(id:string,jobId:string,signal:AbortSignal):Promise<void>{
  let lastNotice=performance.now()-2000;
  try{
   const {row,descriptor:d}=this.db.tagWriteJobs.commitOwned(id),w=d.worker;await this.recoveryRoot(d);signal.throwIfAborted();
   for(const r of this.requests.values())if((JSON.parse(r.identity) as TagWriteDraft).itemId===w.plan.itemId)r.controller.abort(new Error('歌曲正在准备标签提交'));
   const waiting=Promise.all([this.parser.quiesceFile(w.binding.fullPath,row.lease_id),this.runtime!.quiesce(w.plan.fileId,w.binding.fullPath,row.lease_id)]);let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([waiting,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取组件未在35秒内退出，提交占用保留')),35000);})]);}finally{if(timer)clearTimeout(timer);}
   await this.validateCommitOwned(id,signal,true);
   const actual=await this.inspector!.run(this.inspectionInput(id,d),p=>{if(performance.now()-lastNotice>=2000||p.bytes===p.total){lastNotice=performance.now();this.db.tagWriteJobs.commitProgress(id,{version:1,operationId:id,sequence:p.sequence,kind:'progress',role:p.role,bytes:p.bytes,total:p.total});this.notify(jobId);}},signal);
   await this.validateCommitOwned(id,signal,true);const staged=await this.journal!.read(jobId),binding=this.db.tagWriteJobs.freezeCommit(id,actual,staged);
   let journal=await this.commitJournal!.create(binding);this.db.tagWriteJobs.recordCommitJournal(id,journal);this.notify(jobId);
   const done=await this.committer!.run(binding.request,async stage=>{
    // Native holds exclusive file handles here. Never reopen/stat the source path,
    // including the intentional gap after moving it to the retained victim name.
    await this.validateCommitOwned(id,signal);journal=await this.commitJournal!.advance(id,journal.revision,stage);
    const receipt=this.db.tagWriteJobs.recordCommitJournal(id,journal);this.notify(jobId);return receipt;
   },p=>{if(performance.now()-lastNotice>=2000||p.bytes===p.total){lastNotice=performance.now();this.db.tagWriteJobs.commitProgress(id,p);this.notify(jobId);}},signal);
   // Client completion includes actual process exit and all pending callbacks.
   await this.validateCommitOwned(id,signal);journal=await this.commitJournal!.read(id);this.db.tagWriteJobs.finishNativeCommit(id,done,journal);
   try{this.runtime?.invalidated?.(jobId);}catch{}this.notify(jobId);
  }catch(e){const message=String(e instanceof Error?e.message:e);try{this.db.tagWriteJobs.failCommit(id,message,Boolean(this.writer?.quiescent&&this.inspector?.quiescent&&this.committer?.quiescent));}catch{}try{this.runtime?.invalidated?.(jobId);}catch{}this.notify(jobId,message);}
  // Neither success nor interruption releases read gates, deletes artifacts or
  // marks the library committed; four-artifact recovery and reprobe must follow.
 }
 private notify(jobId:string,error?:string):void {try{this.runtime?.changed(jobId,error);}catch{/* Persisted receipts remain authoritative if the UI closes. */}}
 cancelStage(value:unknown):TagWriteJob {const request=readTagWriteCancelRequest(value),known=this.db.tagWriteJobs.stageCancelReceipt(request);if(known)return known;const active=this.activeStage;if(!active||active.jobId!==request.jobId)throw new Error('此暂存进程不在当前会话运行，请从恢复状态继续处理');const result=this.db.tagWriteJobs.requestStageCancel(request);active.controller.abort(new Error('用户已取消暂存，保留工件等待核对'));this.notify(request.jobId);return result;}
 startInspection(value:unknown):TagWriteJob {
  const request=readTagWriteCancelRequest(value);this.db.restorePolicy.assertTagJob(request.jobId);const known=this.db.tagWriteJobs.inspectionReceipt(request);if(known)return known;
  if(!this.runtime||!this.journal||!this.inspector||!this.writer)throw new Error('文件核对组件尚未配置');
  if(this.activeStage||this.activeInspection||this.activeRecoveryAction||this.activeCommit||this.activeCommitInspection||this.activeReprobe||this.activeRestoreReprobe||this.activeRestoreInspection||this.activeRestore||!this.restorer?.quiescent||!this.committer?.quiescent||!this.writer.quiescent||!this.inspector.quiescent)throw new Error('暂存或核对进程未退出，请等待完成；退出不明确时重启后恢复');
  const job=this.db.tagWriteJobs.beginInspection(request),active={id:request.commandId,jobId:job.id,controller:new AbortController()} as NonNullable<TagWriteManager['activeInspection']>;
  this.activeInspection=active;active.finished=this.runInspection(active.id,job.id,active.controller.signal).finally(()=>{if(this.activeInspection===active)this.activeInspection=null;});void active.finished.catch(()=>{});this.notify(job.id);return job;
 }
 cancelInspection(value:unknown):TagWriteJob {
  const request=readTagRecoveryCancel(value),known=this.db.tagWriteJobs.inspectionCancelReceipt(request);if(known)return known;
  if(!this.activeInspection||this.activeInspection.id!==request.inspectionId)throw new Error('此文件核对不在当前会话运行，请刷新状态');
  const job=this.db.tagWriteJobs.requestInspectionCancel(request);this.activeInspection.controller.abort(new Error('用户已取消文件核对，工件和恢复占用保留'));this.notify(job.id);return job;
 }
 startRecoveryAction(value:unknown):TagWriteJob {
  const request=readTagRecoveryAction(value);this.db.restorePolicy.assertTagJob(request.jobId);const known=this.db.tagWriteJobs.recoveryActionReceipt(request);if(known)return known;
  if(!this.runtime||!this.journal||!this.writer||!this.inspector)throw new Error('文件恢复核对组件尚未配置');
  if(this.activeStage||this.activeInspection||this.activeRecoveryAction||this.activeCommit||this.activeCommitInspection||this.activeReprobe||this.activeRestoreReprobe||this.activeRestoreInspection||this.activeRestore||!this.restorer?.quiescent||!this.committer?.quiescent||!this.writer.quiescent||!this.inspector.quiescent)throw new Error('已有暂存或核对进程运行，或其退出尚未确认');
  const job=this.db.tagWriteJobs.beginRecoveryAction(request),active={id:request.commandId,jobId:job.id,controller:new AbortController()} as NonNullable<TagWriteManager['activeRecoveryAction']>;
  this.activeRecoveryAction=active;active.finished=this.runRecoveryAction(active.id,job.id,active.controller.signal).finally(()=>{if(this.activeRecoveryAction===active)this.activeRecoveryAction=null;});void active.finished.catch(()=>{});this.notify(job.id);return job;
 }
 cancelRecoveryAction(value:unknown):TagWriteJob {
  const request=readTagRecoveryActionCancel(value),known=this.db.tagWriteJobs.recoveryActionCancelReceipt(request);if(known)return known;
  if(!this.activeRecoveryAction||this.activeRecoveryAction.id!==request.actionId)throw new Error('此恢复处理不在当前会话运行，请刷新状态');
  const job=this.db.tagWriteJobs.requestRecoveryActionCancel(request);this.activeRecoveryAction.controller.abort(new Error('用户已停止重新核对，文件和恢复占用保留'));this.notify(job.id);return job;
 }
 releaseResolved(id:string):void {
  if(!this.runtime)throw new Error('恢复运行组件尚未配置');const {descriptor:d,apply}=this.db.tagWriteJobs.recoveryReleaseBinding(id),w=d.worker;this.db.restorePolicy.assertTagJob(w.plan.jobId);
  if(apply){this.parser.releaseRecoveredFile(w.binding.fullPath,w.leaseId);this.runtime.releaseRecovered(w.binding.fullPath,w.leaseId);}
  this.db.tagWriteJobs.confirmRecoveryRelease(id);this.runtime.recovered(w.plan.jobId);this.notify(w.plan.jobId);
 }
 private inspectionInput(id:string,d:TagStageDescriptor):TagInspectionRequest {const w=d.worker,jobId=w.plan.jobId;return {version:1,kind:'inspect',inspectionId:id,sourceRoot:w.binding.realRootPath,backupRoot:w.backupDir,files:[{role:'original',path:w.binding.fullPath},{role:'backup',path:path.join(w.backupDir,`${jobId}-${w.backupArtifactId}.bak`)},{role:'temporary',path:path.join(path.dirname(w.binding.fullPath),`.aural-${jobId}-${w.tempArtifactId}.tmp`)}]};}
 private async runRecoveryAction(id:string,jobId:string,signal:AbortSignal):Promise<void> {
  let lastNotice=performance.now()-2000;
  try{
   const {descriptor:d,report,request}=this.db.tagWriteJobs.recoveryActionBinding(id),w=d.worker;await this.recoveryRoot(d);signal.throwIfAborted();
   const waiting=Promise.all([this.parser.quiesceFile(w.binding.fullPath,w.leaseId),this.runtime!.quiesce(w.plan.fileId,w.binding.fullPath,w.leaseId)]);let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([waiting,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取组件未在35秒内退出，恢复占用保留')),35000);})]);}finally{if(timer)clearTimeout(timer);}
   signal.throwIfAborted();await this.recoveryRoot(d);this.db.tagWriteJobs.recoveryActionBinding(id);
   const actual=await this.inspector!.run(this.inspectionInput(id,d),p=>{if(performance.now()-lastNotice>=2000||p.bytes===p.total){lastNotice=performance.now();this.db.tagWriteJobs.recoveryActionProgress(id,p);this.notify(jobId);}},signal);
   signal.throwIfAborted();await this.recoveryRoot(d);assertTagRecoverySnapshotEqual(report.actual,actual);
   if(request.action==='cancel-unchanged'){
    const journal=await this.journal!.read(jobId);this.db.tagWriteJobs.inspectJournal(w.executionId,journal);const source=journal.history[0];
    if(source?.stage!=='validated'||!actual.files[0].flac||!(['sha256','audioSha256','metadataSha256','byteLength','audioOffset','audioBytes'] as const).every(key=>source.source[key]===actual.files[0].flac![key]))throw new Error('原文件与阶段来源证据不符，请重新核对');
   }
   signal.throwIfAborted();this.db.tagWriteJobs.finishRecoveryAction(id,actual);
   // These locks belong to the completed lease; fresh parsing is required after the native snapshot closes.
   this.releaseResolved(id);
  }catch(e){const message=String(e instanceof Error?e.message:e);try{this.db.tagWriteJobs.failRecoveryAction(id,message,signal.aborted);}catch{}this.notify(jobId,message);}
 }
 private async recoveryRoot(d:TagStageDescriptor):Promise<void>{
  const w=d.worker,binding=this.db.tagWriteRootBinding(w.plan.itemId),anchor=await probeWatchRoot(w.binding.rootPath);
  if(binding.path!==w.binding.rootPath||!sameWatchAnchor(anchor,w.binding.rootAnchor)||binding.anchor&&!sameWatchAnchor(anchor,binding.anchor))throw new Error('恢复文件的授权音乐目录身份已变化，请先核对目录设置');
  const expected=path.join(this.runtime!.dataDir,'tag-backups'),normalize=(s:string)=>process.platform==='win32'?path.resolve(s).toLowerCase():path.resolve(s);
  if(normalize(w.backupDir)!==normalize(expected)||normalize(await fs.realpath(w.backupDir))!==normalize(expected))throw new Error('恢复备份目录身份不可确认');
 }
 private async runInspection(id:string,jobId:string,signal:AbortSignal):Promise<void>{
  let lastNotice=performance.now()-2000;
  try{
   const {descriptor:d}=this.db.tagWriteJobs.inspectionBinding(id),w=d.worker;await this.recoveryRoot(d);signal.throwIfAborted();
   const waiting=Promise.all([this.parser.quiesceFile(w.binding.fullPath,w.leaseId),this.runtime!.quiesce(w.plan.fileId,w.binding.fullPath,w.leaseId)]);let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([waiting,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取组件未在35秒内退出，恢复占用继续保留')),35000);})]);}finally{if(timer)clearTimeout(timer);}
   signal.throwIfAborted();await this.recoveryRoot(d);this.db.tagWriteJobs.inspectionBinding(id);
   const input:TagInspectionRequest={version:1,kind:'inspect',inspectionId:id,sourceRoot:w.binding.realRootPath,backupRoot:w.backupDir,files:[{role:'original',path:w.binding.fullPath},{role:'backup',path:path.join(w.backupDir,`${jobId}-${w.backupArtifactId}.bak`)},{role:'temporary',path:path.join(path.dirname(w.binding.fullPath),`.aural-${jobId}-${w.tempArtifactId}.tmp`)}]};
   const actual=await this.inspector!.run(input,p=>{if(performance.now()-lastNotice>=2000||p.bytes===p.total){lastNotice=performance.now();this.db.tagWriteJobs.inspectionProgress(id,p);this.notify(jobId);}},signal);
   signal.throwIfAborted();await this.recoveryRoot(d);this.db.tagWriteJobs.inspectionBinding(id);
   const report:TagRecoveryReport={classification:'journal-unconfirmed',journal:'unconfirmed',reason:'阶段日志尚未核对；文件摘要只是本次读取时的快照',actual};
   try{
    const journal=await this.journal!.read(jobId);report.journal=this.db.tagWriteJobs.inspectJournal(w.executionId,journal);
    const source=journal.history[0],temporary=journal.history[2];
    if(source?.stage!=='validated'){report.classification='source-baseline-unavailable';report.reason='完整原文件摘要尚未建立，不能宣称当前音频与暂存前一致；文件与恢复占用继续保留';}
    else {
     const [original,backup,temp]=actual.files;
     const classified=(original.state==='present'&&original.flac||original.state==='missing')?classifyTagWriteRecovery(source.source,temporary?.stage==='temp_written'?temporary.temporary:null,{original:original.flac,backup:backup.flac,temporary:temp.flac,replacementVictim:null}):'recovery-required';report.classification=classified==='replacement-verified'?'recovery-required':classified;
     report.reason=report.classification==='unchanged'?'本次完整原文件摘要与已验证源文件一致；保留现有工件，尚未解除恢复占用':report.classification==='staged'?'本次原文件、备份和临时文件与阶段证据一致；尚未执行原文件替换':report.classification==='restore-available'?'原文件明确缺失，备份与已验证源文件一致；仍需后续恢复操作':'实际工件不能证明安全恢复状态；保留文件与恢复占用';
     if(report.journal==='fs-ahead')report.reason+='；文件系统阶段日志先于数据库回执持久化';
    }
   }catch(e){report.classification='journal-unconfirmed';report.journal='unconfirmed';report.reason=`日志证据无法确认，保留工件及恢复占用：${String(e instanceof Error?e.message:e).slice(0,300)}`;}
   signal.throwIfAborted();this.db.tagWriteJobs.finishInspection(id,report);this.notify(jobId);
  }catch(e){const message=String(e instanceof Error?e.message:e);try{this.db.tagWriteJobs.failInspection(id,message,signal.aborted,this.inspector?.quiescent??false);}catch{}this.notify(jobId,message);}
  // Inspection alone never releases the recovery lease or deletes artifacts.
 }
 private async validateOwned(d:TagStageDescriptor):Promise<void>{const {snapshot}=this.db.tagWriteJobs.material(d.worker.plan.jobId);await this.checkSource(snapshot,d.worker.plan.jobId);this.frozenContext(snapshot,d.worker.plan.jobId);}
 private async runStage(executionId:string,jobId:string,signal:AbortSignal):Promise<void> {
  let lastNotice=performance.now()-2000;
  try{
   const d=this.db.tagWriteJobs.descriptor(executionId),w=d.worker,runtime=this.runtime!;
   for(const r of this.requests.values())if((JSON.parse(r.identity) as TagWriteDraft).itemId===w.plan.itemId)r.controller.abort(new Error('歌曲正在准备文件暂存'));
   const quiescing=Promise.all([this.parser.quiesceFile(w.binding.fullPath,w.leaseId),runtime.quiesce(w.plan.fileId,w.binding.fullPath,w.leaseId)]);let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([quiescing,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取组件未在35秒内退出，保留租约等待恢复')),35000);})]);}finally{if(timer)clearTimeout(timer);}
   signal.throwIfAborted();await this.validateOwned(d);let journal=await this.journal!.create(w.plan);this.db.tagWriteJobs.recordJournal(executionId,journal);
   const done=await this.writer!.run(w,async message=>{
    signal.throwIfAborted();await this.validateOwned(d);
    const transition=message.stage==='validated'?{commandId:d.commands.validated,stage:'validated' as const,source:message.evidence,leaseId:w.leaseId,leaseRevision:w.leaseRevision}:message.stage==='backup_ready'?{commandId:d.commands.backup_ready,stage:'backup_ready' as const,artifactId:w.backupArtifactId,backup:message.evidence}:{commandId:d.commands.temp_written,stage:'temp_written' as const,artifactId:w.tempArtifactId,temporary:message.evidence};
    journal=await this.journal!.advance(w.plan.jobId,journal.revision,transition);this.db.tagWriteJobs.recordJournal(executionId,journal);this.notify(w.plan.jobId);
   },message=>{if(performance.now()-lastNotice>=2000||message.bytes===message.total){lastNotice=performance.now();this.db.tagWriteJobs.stageProgress(executionId,message);this.notify(w.plan.jobId);}},signal);
   // run() returns only after the supervisor has confirmed the whole Job exited.
   signal.throwIfAborted();await this.validateOwned(d);journal=await this.journal!.read(w.plan.jobId);this.db.tagWriteJobs.finishStage(executionId,done,journal);
   this.parser.releaseFile(w.binding.fullPath,w.leaseId);runtime.release(w.binding.fullPath,w.leaseId);this.notify(w.plan.jobId);
  }catch(e){const message=String(e instanceof Error?e.message:e);try{this.db.tagWriteJobs.failStage(executionId,message);}catch{}this.notify(jobId,message);/* No unblocking or deletion on an ambiguous/partial stage. */}
 }
}
