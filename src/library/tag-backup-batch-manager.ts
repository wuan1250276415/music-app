import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {LibraryDatabase} from './database.js';
import type {TagWriteManager} from './tag-write-manager.js';
import type {TagBackupStorage} from './tag-backup-storage.js';
import type {TagBackupCleanupManager} from './tag-backup-cleanup-manager.js';
import {tagWriteUuid} from '../shared/tag-write.js';
import {tagCommitCanonical as canonical} from '../shared/tag-commit-journal.js';
import {readTagBackupBatchCommand,type TagBackupBasis,type TagBackupBatch,type TagBackupBatchItem} from '../shared/tag-backup-batch.js';

// Each item uses the same durable, independently checked native cleanup path as
// manual cleanup. The scheduler never interprets inventory as deletion proof.
export class TagBackupBatchManager {
 private timer:ReturnType<typeof setTimeout>|null=null;
 private flight:Promise<void>|null=null;
 private preparing:Promise<TagBackupBatch>|null=null;
 private maintenance:string|null=null;
 private closed=false;
 private suspended=false;
 private suspendFlight:Promise<void>|null=null;
 private nextAutomatic=0;
 private automaticNotice='';
 schedule(){const value=this.db.tagBackupBatches.schedule();return value.effective&&this.automaticNotice?{...value,reason:this.automaticNotice}:value;}
 private readonly backupRoot:string;
 constructor(private readonly db:LibraryDatabase,private readonly tags:TagWriteManager,private readonly storage:TagBackupStorage,private readonly cleanup:TagBackupCleanupManager,dataDir:string,private readonly changed:()=>void,paused=false){this.backupRoot=path.join(dataDir,'tag-backups');if(paused)this.maintenance='startup-paused';else this.wake();}
 wake():void {if(this.closed||this.maintenance||this.suspended||this.timer)return;this.timer=setTimeout(()=>{this.timer=null;void this.tick();},250);this.timer.unref();}
 private again():void {if(this.closed||this.maintenance||this.suspended||this.timer)return;this.timer=setTimeout(()=>{this.timer=null;void this.tick();},5000);this.timer.unref();}
 async suspend():Promise<void>{this.suspended=true;if(this.timer)clearTimeout(this.timer);this.timer=null;if(this.suspendFlight)return this.suspendFlight;const task=this.drain('系统休眠已中断后台清理，需明确继续');this.suspendFlight=task;try{await task;}finally{if(this.suspendFlight===task)this.suspendFlight=null;}}
 async resume():Promise<void>{await this.suspendFlight;if(this.maintenance==='startup-paused')this.maintenance=null;this.suspended=false;this.wake();}
 async preview(id:unknown,source:'manual'|'automatic'='manual'):Promise<TagBackupBatch>{
  if(!tagWriteUuid(id))throw new Error('清理范围核对身份无效');const normalizedId=id.toLowerCase();const known=this.db.tagBackupBatches.knownCreate(normalizedId);if(known)return known;
  if(this.closed||this.maintenance||this.suspended)throw new Error('曲库正在维护，暂不能核对清理范围');if(this.preparing)throw new Error('正在核对清理范围，请等待原请求结果');
  const task=this.prepare(normalizedId,source);this.preparing=task;try{return await task;}finally{if(this.preparing===task)this.preparing=null;}
 }
 private async prepare(id:string,source:'manual'|'automatic'):Promise<TagBackupBatch>{
  if(this.db.tagBackupBatches.active())throw new Error('请先结束现有清理批次');const page=await this.storage.page({filter:'candidates'});
  if(!page.complete)throw new Error('空间清单不完整，不能建立清理范围');
  const origin=this.db.historyExportOrigin(),activation=this.db.restorePolicy.load()?.activationId??null,bases:TagBackupBasis[]=[];let current=page;
  for(;;){for(const item of current.items){if(!item.jobId)continue;const c=this.db.tagBackupCatalog.select(item.jobId,this.backupRoot);bases.push({jobId:c.jobId,jobRevision:c.jobRevision,executionId:c.executionId,backupArtifactId:c.backupArtifactId,stagingJournalSha256:c.stagingJournalSha256,bytes:c.source.byteLength,title:item.title});if(bases.length===100)break;}if(bases.length===100||current.nextOffset===null)break;current=await this.storage.page({snapshotId:page.snapshotId,filter:'candidates',offset:current.nextOffset});}
  if(!bases.length)throw new Error('当前没有达到保留期且允许清理的备份');
  if(this.closed||this.maintenance||this.suspended||this.db.historyExportOrigin()!==origin||(this.db.restorePolicy.load()?.activationId??null)!==activation||this.db.tagBackupPolicies.load().revision!==page.policy.revision)throw new Error('核对期间曲库或保留设置已改变，请重新核对');
  const batch=this.db.tagBackupBatches.create(id,bases,page.policy.revision,source);this.changed();return batch;
 }
 async command(value:unknown):Promise<TagBackupBatch>{const q=readTagBackupBatchCommand(value);if(this.closed||this.maintenance||this.suspended)throw new Error('曲库正在维护，暂不能操作清理批次');let result=this.db.tagBackupBatches.command(q);
  // A persisted active slot after restart is not a live process. Cancelling it
  // must not launch the old inspection or a new removal merely to drain it.
  if(q.action==='cancel'&&!this.flight&&result.activeOrdinal!==null){const item=this.db.tagBackupBatches.members(result.id)[result.activeOrdinal],known=this.db.tagBackupCleanups.known({commandId:item.removeId,action:'remove',inspectionId:item.inspectId,confirmed:true});this.db.tagBackupBatches.settle(result.id,result.activeOrdinal,known?.state==='removed'&&known.exitConfirmed?'removed':'blocked',known?.state==='removed'&&known.exitConfirmed?'原清理已完整结束，批次其余项已取消':'已取消中断项，原文件与清理记录保留');result=this.db.tagBackupBatches.get(result.id);}
  this.changed();this.wake();return result;
 }
 configured():void {this.nextAutomatic=0;this.automaticNotice='';this.changed();this.wake();}
 private assertItem(batch:TagBackupBatch,item:TagBackupBatchItem):void {
  if(this.closed||this.maintenance||this.suspended)throw new Error('曲库维护或退出已开始，尚未授权后续删除');this.db.tagBackupBatches.assertCurrent(batch.id);
  const c=this.db.tagBackupCatalog.select(item.basis.jobId,this.backupRoot),basis={jobId:c.jobId,jobRevision:c.jobRevision,executionId:c.executionId,backupArtifactId:c.backupArtifactId,stagingJournalSha256:c.stagingJournalSha256,bytes:c.source.byteLength,title:item.basis.title};
  if(canonical(basis)!==canonical(item.basis))throw new Error('原清理范围内的任务或备份依据已改变');
 }
 private async step(batch:TagBackupBatch):Promise<void>{
  const repo=this.db.tagBackupBatches;let item=repo.members(batch.id).find(i=>['inspecting','removing'].includes(i.state))??repo.members(batch.id).find(i=>i.state==='pending');
  if(!item){repo.finish(batch.id);return;}
  if(batch.activeOrdinal===null&&batch.state!=='running'){repo.finish(batch.id);return;}
  try{
   if(item.state==='removing'){const known=this.db.tagBackupCleanups.known({commandId:item.removeId,action:'remove',inspectionId:item.inspectId,confirmed:true});if(known?.state==='removed'&&known.exitConfirmed){repo.settle(batch.id,item.ordinal,'removed','依据原完整退出及删除回执接纳结果，未重发删除');repo.finish(batch.id);return;}}
   this.assertItem(batch,item);
   if(item.state==='pending'){repo.phase(batch.id,item.ordinal,'inspecting');item=repo.members(batch.id)[item.ordinal];this.changed();}
   const grant={batchId:batch.id,ordinal:item.ordinal,check:()=>this.assertItem(batch,item!)};
   if(item.state==='inspecting'){
    const started=await this.cleanup.command({commandId:item.inspectId,action:'inspect',jobId:item.basis.jobId},grant),checked=await this.cleanup.wait(started.id);
    if(checked.state!=='verified'||!checked.exitConfirmed)throw new Error(checked.reason||'原备份核对未完整结束，请查看对应记录');
    this.assertItem(batch,item);repo.phase(batch.id,item.ordinal,'removing');item=repo.members(batch.id)[item.ordinal];this.changed();
   }
   const started=await this.cleanup.command({commandId:item.removeId,action:'remove',inspectionId:item.inspectId,confirmed:true},grant),removed=await this.cleanup.wait(started.id);
   if(removed.state!=='removed'||!removed.exitConfirmed)throw new Error(removed.reason||'原清理尚未完整确认，请独立核对原结果');
   repo.settle(batch.id,item.ordinal,'removed','此备份已核对并清理，原操作完整结束');repo.finish(batch.id);
  }catch(error){const message=error instanceof Error?error.message:String(error);if(this.closed||this.maintenance||this.suspended)repo.interrupt(batch.id,message);else if(repo.raw(batch.id).active_ordinal!==null)repo.settle(batch.id,item.ordinal,'blocked',message);else repo.interrupt(batch.id,message);}
  finally{this.changed();}
 }
 private async tick():Promise<void>{
  if(this.closed||this.maintenance||this.suspended||this.flight)return;
  const task=this.drive();this.flight=task;try{await task;}catch(error){this.automaticNotice=(error instanceof Error?error.message:String(error)).slice(0,600);try{const a=this.db.tagBackupBatches.active();if(a&&['running','pausing','cancelling'].includes(a.state))this.db.tagBackupBatches.interrupt(a.id,this.automaticNotice);}catch{/* A damaged database remains unavailable; no deletion is retried here. */}this.changed();}finally{if(this.flight===task)this.flight=null;this.again();}
 }
 private async drive():Promise<void>{
  let batch=this.db.tagBackupBatches.active();
  if(!batch&&process.platform==='win32'&&performance.now()>=this.nextAutomatic){
   this.nextAutomatic=performance.now()+60*60*1000;
   if(this.db.tagBackupBatches.schedule().effective){try{batch=await this.preview(randomUUID(),'automatic');batch=await this.command({commandId:randomUUID(),batchId:batch.id,baseRevision:batch.revision,action:'start',confirmed:true});this.automaticNotice='到期备份批次已建立，正在逐份处理';}catch(error){this.automaticNotice=(error instanceof Error?error.message:String(error)).slice(0,600);this.changed();return;}}
  }
  if(!batch||!['running','pausing','cancelling'].includes(batch.state))return;
  if(this.cleanup.busy||!this.tags.batchIdle)return;
  try{this.db.tagBackupCatalog.assertGlobalIdle();}catch{return;}
  await this.step(batch);
  if(this.db.tagBackupBatches.get(batch.id).state==='completed')this.nextAutomatic=0;
 }
 private async drain(message:string):Promise<void>{
  await this.preparing?.catch(()=>{});const active=this.db.tagBackupBatches.active();
  if(active?.activeOrdinal!==null&&active?.activeOrdinal!==undefined&&this.cleanup.busy){const item=this.db.tagBackupBatches.members(active.id)[active.activeOrdinal],id=item.state==='removing'?item.removeId:item.inspectId;try{await this.cleanup.command({commandId:randomUUID(),action:'stop',operationId:id});}catch{/* The cleaner can already be draining for catalog maintenance. */}}
  await this.flight?.catch(()=>{});const latest=this.db.tagBackupBatches.active();if(latest&&['running','pausing','cancelling'].includes(latest.state))this.db.tagBackupBatches.interrupt(latest.id,message);
 }
 async beginMaintenance(owner:string):Promise<void>{if(!owner||this.maintenance&&this.maintenance!==owner&&this.maintenance!=='startup-paused')throw new Error('后台清理维护身份不符');this.maintenance=owner;if(this.timer)clearTimeout(this.timer);this.timer=null;await this.drain('曲库维护已中断后台清理，需明确继续');}
 endMaintenance(owner:string):void {if(this.maintenance!==owner||this.flight||this.preparing)throw new Error('后台清理尚未排空');this.maintenance=null;this.wake();}
 async close():Promise<void>{this.closed=true;if(this.timer)clearTimeout(this.timer);this.timer=null;await this.drain('应用退出已中断后台清理，需明确继续');}
}
