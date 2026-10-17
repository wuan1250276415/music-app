import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {LibraryDatabase} from './database.js';
import type {TagWriteManager} from './tag-write-manager.js';
import {TagWriteJournal} from './tag-write-journal.js';
import {TagBackupCleaner} from './tag-backup-cleaner.js';
import {TagBackupCleanupJournal} from './tag-backup-cleanup-journal.js';
import {tagCommitCanonical as canonical} from '../shared/tag-commit-journal.js';
import {readTagBackupCleanupCommand,type TagBackupCleanupBinding,type TagBackupCleanupCommand,type TagBackupCleanupView} from '../shared/tag-backup-cleanup.js';

const normalize=(v:string)=>process.platform==='win32'?path.resolve(v).toLowerCase():path.resolve(v);
export class TagBackupCleanupManager {
 private readonly cleaner:TagBackupCleaner;private readonly journal:TagBackupCleanupJournal;private readonly original:TagWriteJournal;private readonly root:string;
 private preparation:Promise<TagBackupCleanupView>|null=null;
 private active:{id:string;kind:TagBackupCleanupBinding['request']['kind'];controller:AbortController;finished:Promise<void>}|null=null;
 private closed=false;private maintenanceOwner:string|null=null;
 constructor(private readonly db:LibraryDatabase,private readonly tags:TagWriteManager,dataDir:string,executable:string,private readonly changed:(id:string)=>void){this.root=path.join(dataDir,'tag-backups');this.cleaner=new TagBackupCleaner(executable);this.journal=new TagBackupCleanupJournal(dataDir);this.original=new TagWriteJournal(dataDir);}
 get busy():boolean{return Boolean(this.preparation||this.active);}
 async command(value:unknown):Promise<TagBackupCleanupView>{
  const q=readTagBackupCleanupCommand(value),known=this.db.tagBackupCleanups.known(q);if(known)return this.get(known.id);
  if(this.closed||this.maintenanceOwner)throw new Error('曲库正在维护，暂不能开始备份清理');
  if(q.action==='stop'){const view=this.db.tagBackupCleanups.stop(q);if(this.active?.id===view.id&&this.active.kind!=='delete-backup')this.active.controller.abort(new Error('已请求停止备份核对'));this.changed(view.id);return view;}
  if(this.preparation||this.active||!this.cleaner.quiescent)throw new Error('请先等待当前备份操作完整结束');
  const task=this.prepare(q);this.preparation=task;try{return await task;}finally{if(this.preparation===task)this.preparation=null;}
 }
 get(id:string):TagBackupCleanupView{const row=this.db.tagBackupCleanups.raw(id);if(!this.active&&!this.preparation&&['reserved','running'].includes(row.state))this.db.tagBackupCleanups.fail(row.id,'原意图没有当前进程的在途执行，不会自动重发；请核对原结果');return this.db.tagBackupCleanups.get(row.id);}
 private async prepare(q:Exclude<TagBackupCleanupCommand,{action:'stop'}>):Promise<TagBackupCleanupView>{
  this.db.tagBackupCatalog.assertGlobalIdle();if(!this.tags.batchIdle)throw new Error('标签任务或文件核对仍在进行，请等待原操作结束');const owner=randomUUID();await this.tags.beginMaintenance(owner);let launched=false;
  try{
   let binding:TagBackupCleanupBinding;
   if(q.action==='observe'){
    this.get(q.operationId);const old=this.db.tagBackupCleanups.binding(q.operationId),row=this.db.tagBackupCleanups.raw(q.operationId);
    if(old.request.kind!=='delete-backup'||!['interrupted','failed'].includes(row.state)||old.catalogOrigin!==this.db.historyExportOrigin()||normalize(old.request.backupRoot)!==normalize(this.root))throw new Error('原清理不属于当前曲库与备份目录，或尚未中断');
    try{const saved=await this.journal.read(row.id);this.db.tagBackupCleanups.accept(row.id,saved,()=>{});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    binding={...old,request:{...old.request,kind:'observe-backup',operationId:q.commandId}};
   }else{
    const inspection=q.action==='remove'?this.db.tagBackupCleanups.raw(q.inspectionId):null,prior=inspection?this.db.tagBackupCleanups.binding(inspection.id):null;
    const jobId=q.action==='inspect'?q.jobId:inspection!.job_id,candidate=this.db.tagBackupCatalog.select(jobId,this.root),policy=this.db.tagBackupPolicies.load();
    await this.checkOriginal(candidate.jobId,candidate.stagingJournalSha256);
    if(inspection&&(inspection.state!=='verified'||!inspection.exit_confirmed||Date.now()-inspection.updated_at>15*60000||Date.now()<inspection.updated_at))throw new Error('原备份核对已过期，请重新核对后再确认清理');
    binding={version:1,catalogOrigin:this.db.historyExportOrigin(),executionId:candidate.executionId,jobRevision:candidate.jobRevision,policyRevision:policy.revision,stagingJournalSha256:candidate.stagingJournalSha256,request:{version:1,kind:q.action==='inspect'?'inspect-backup':'delete-backup',operationId:q.commandId,jobId:candidate.jobId,backupArtifactId:candidate.backupArtifactId,backupRoot:candidate.backupRoot,source:candidate.source,expected:inspection?.final_json?JSON.parse(inspection.final_json):null}};
    if(prior&&(prior.executionId!==binding.executionId||prior.jobRevision!==binding.jobRevision||prior.policyRevision!==binding.policyRevision||prior.stagingJournalSha256!==binding.stagingJournalSha256))throw new Error('原核对后的任务或保留设置已改变，请重新核对');
    this.authorize(binding,q.action==='remove');
   }
   if(this.closed||this.maintenanceOwner)throw new Error('曲库维护已开始，未启动新清理');
   const view=this.db.tagBackupCleanups.create(q,binding),controller=new AbortController();this.db.tagBackupCleanups.start(view.id);
   const finished=Promise.resolve().then(()=>this.execute(binding,controller.signal)).finally(()=>{this.tags.endMaintenance(owner);this.active=null;this.changed(view.id);});
   void finished.catch(()=>this.changed(view.id));this.active={id:view.id,kind:binding.request.kind,controller,finished};launched=true;this.changed(view.id);return this.db.tagBackupCleanups.get(view.id);
  }finally{if(!launched)this.tags.endMaintenance(owner);}
 }
 private async checkOriginal(jobId:string,expectedSha:string):Promise<void>{
  const candidate=this.db.tagBackupCatalog.select(jobId,this.root),saved=await this.original.read(jobId),source=saved.history[0],backup=saved.history[1];
  if(saved.receiptSha256s?.[2]!==expectedSha||canonical(saved.plan)!==canonical(candidate.plan)||source?.stage!=='validated'||backup?.stage!=='backup_ready'||backup.artifactId!==candidate.backupArtifactId||canonical(source.source)!==canonical(candidate.source)||canonical(backup.backup)!==canonical(candidate.source))throw new Error('原备份日志与冻结任务不同，已保留文件');
 }
 private authorize(binding:TagBackupCleanupBinding,expiry:boolean):void{
  const current=this.db.tagBackupCatalog.select(binding.request.jobId,this.root),policy=this.db.tagBackupPolicies.load();
  if(binding.catalogOrigin!==this.db.historyExportOrigin()||current.executionId!==binding.executionId||current.jobRevision!==binding.jobRevision||policy.revision!==binding.policyRevision||current.stagingJournalSha256!==binding.stagingJournalSha256||current.backupArtifactId!==binding.request.backupArtifactId||normalize(current.backupRoot)!==normalize(binding.request.backupRoot)||canonical(current.source)!==canonical(binding.request.source))throw new Error('备份清理依据已改变，请重新核对');
  if(expiry){const identity=binding.request.expected?.backup.identity;if(!identity)throw new Error('缺少独立备份创建时间');const createdAt=Number(BigInt(identity.creation)/10000n-11644473600000n),start=Math.max(createdAt,current.endedAt),now=Date.now();if(!Number.isSafeInteger(start)||start>now||now-start<policy.keepDays*86400000)throw new Error(`任务结束后至少保留 ${policy.keepDays} 天，当前不能清理`);}
 }
 private async execute(binding:TagBackupCleanupBinding,signal:AbortSignal):Promise<void>{
  const id=binding.request.operationId;
  try{
   let snapshot=await this.journal.create(binding);this.db.tagBackupCleanups.accept(id,snapshot,()=>{});
   const proof=await this.cleaner.run(binding.request,async stage=>{
    if(stage.phase==='delete_ready'){if(this.db.tagBackupCleanups.raw(id).stop_requested)throw new Error('已停止，尚未授权删除');await this.checkOriginal(binding.request.jobId,binding.stagingJournalSha256);}
    snapshot=await this.journal.advance(id,snapshot.revision,stage);
    const digest=this.db.tagBackupCleanups.accept(id,snapshot,()=>this.authorize(binding,true));this.changed(id);return digest;
   },()=>{},signal);
   this.db.tagBackupCleanups.finish(id,proof);this.changed(id);
  }catch(error){this.db.tagBackupCleanups.fail(id,error instanceof Error?error.message:String(error));this.changed(id);}
 }
 private async halt():Promise<void>{
  await this.preparation?.catch(()=>{});const active=this.active;if(!active)return;
  this.db.tagBackupCleanups.stop({commandId:randomUUID(),action:'stop',operationId:active.id});
  if(active.kind!=='delete-backup')active.controller.abort(new Error('备份核对已停止，保留原记录'));
  await active.finished;
 }
 async beginMaintenance(owner:string):Promise<void>{if(!owner||this.maintenanceOwner&&this.maintenanceOwner!==owner)throw new Error('备份清理维护身份不符');this.maintenanceOwner=owner;await this.halt();}
 endMaintenance(owner:string):void{if(this.maintenanceOwner!==owner||this.active||this.preparation)throw new Error('备份清理尚未完整排空');this.maintenanceOwner=null;}
 async close():Promise<void>{this.closed=true;await this.halt();}
}
