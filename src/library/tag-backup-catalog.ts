import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {TagWriteJobs} from './tag-write-jobs.js';
import {readTagWriteFileEvidence,readTagWriteTransition,tagWriteUuid,type TagWritePlan,type TagWriteFileEvidence} from '../shared/tag-write.js';
import {tagCommitCanonical as canonical} from '../shared/tag-commit-journal.js';
const LIMIT=65536;
const normalized=(name:string)=>process.platform==='win32'?path.resolve(name).toLowerCase():path.resolve(name);
export type TagBackupOwned={jobId:string;title:string;expectedBytes:string;endedAt:number|null;reason:string};
export interface TagBackupCleanupCandidate {jobId:string;jobRevision:number;executionId:string;backupArtifactId:string;backupRoot:string;endedAt:number;source:TagWriteFileEvidence;stagingJournalSha256:string;plan:TagWritePlan}
type JobRow={id:string;file_id:string;title:string;state:string;updated_at:string;execution_id:string};
export class TagBackupCatalog {
 constructor(private readonly db:DatabaseSync,private readonly jobs:TagWriteJobs,private readonly assertOrigin:(id:string)=>void){}
 assertGlobalIdle():void{if(this.db.prepare("SELECT 1 FROM tag_stage_batch WHERE owner IS NOT NULL OR status IN('running','pausing','cancelling') UNION ALL SELECT 1 FROM tag_commit_batch WHERE owner IS NOT NULL OR status IN('running','pausing','cancelling') LIMIT 1").get())throw new Error('后台标签批次仍在运行，请等待批次结束后再清理');}
 select(jobId:string,root:string):TagBackupCleanupCandidate {
  if(!tagWriteUuid(jobId))throw new Error('备份任务身份无效');jobId=jobId.toLowerCase();this.assertOrigin(jobId);
  const row=this.db.prepare('SELECT j.id,j.file_id,j.state,j.revision,j.updated_at,e.id execution_id FROM tag_write_job j JOIN tag_write_execution e ON e.job_id=j.id WHERE j.id=?').get(jobId) as {id:string;file_id:string;state:string;revision:number;updated_at:string;execution_id:string}|undefined;
  if(!row||!['completed','cancelled'].includes(row.state))throw new Error('此任务尚未结束或仍需恢复，备份必须保留');
  this.jobs.assertReadable(row.file_id);
  if(!this.db.prepare("SELECT 1 FROM media_file f JOIN library_root r ON r.id=f.root_id WHERE f.id=? AND f.status='online' AND r.status='online'").get(row.file_id))throw new Error('当前音乐文件或目录不在线，保留备份以便恢复');
  if(this.db.prepare("SELECT 1 FROM tag_stage_batch_item i JOIN tag_stage_batch b ON b.id=i.batch_id WHERE i.job_id=? AND b.status NOT IN('completed','cancelled') UNION ALL SELECT 1 FROM tag_commit_batch_item i JOIN tag_commit_batch b ON b.id=i.batch_id WHERE i.job_id=? AND b.status NOT IN('completed','cancelled') LIMIT 1").get(jobId,jobId))throw new Error('此备份仍属于尚未结束的批次');
  for(const table of ['tag_recovery_inspection','tag_recovery_action','tag_commit_inspection','tag_commit_reprobe','tag_restore_inspection','tag_restore_reprobe'])if(this.db.prepare(`SELECT 1 FROM ${table} WHERE job_id=? AND state='running' LIMIT 1`).get(jobId))throw new Error('此备份仍在核对或恢复处理中');
  const descriptor=this.jobs.descriptor(row.execution_id),d=descriptor.worker,plan=this.jobs.material(jobId).plan,endedAt=Date.parse(row.updated_at);
  if(normalized(d.backupDir)!==normalized(root)||canonical(plan)!==canonical(d.plan)||!Number.isFinite(endedAt)||new Date(endedAt).toISOString()!==row.updated_at)throw new Error('备份目录、计划或任务结束时间不可确认');
  const receipts=this.db.prepare('SELECT revision,sha256,payload_json FROM tag_write_stage_receipt WHERE execution_id=? AND revision IN(1,2) ORDER BY revision').all(row.execution_id) as {revision:number;sha256:string;payload_json:string}[];
  if(receipts.length!==2||receipts[0].revision!==1||receipts[1].revision!==2)throw new Error('此备份缺少原核对及生成回执');
  const source=readTagWriteTransition(JSON.parse(receipts[0].payload_json).transition),backup=readTagWriteTransition(JSON.parse(receipts[1].payload_json).transition);
  if(source.stage!=='validated'||backup.stage!=='backup_ready'||backup.artifactId!==d.backupArtifactId||source.commandId!==descriptor.commands.validated||backup.commandId!==descriptor.commands.backup_ready||canonical(source.source)!==canonical(backup.backup))throw new Error('备份证据与原暂存回执不同');
  const evidence=readTagWriteFileEvidence(backup.backup);
  return {jobId,jobRevision:row.revision,executionId:row.execution_id,backupArtifactId:d.backupArtifactId,backupRoot:d.backupDir,endedAt,source:evidence,stagingJournalSha256:receipts[1].sha256,plan};
 }
 async ownership(root:string,signal:AbortSignal,deadline:number):Promise<Map<string,TagBackupOwned>>{
  const result=new Map<string,TagBackupOwned>();
  const rows=this.db.prepare('SELECT j.id,j.file_id,j.title,j.state,j.updated_at,e.id execution_id FROM tag_write_execution e JOIN tag_write_job j ON j.id=e.job_id ORDER BY e.id LIMIT 65537').all() as JobRow[];
  if(rows.length>LIMIT)throw new Error('备份任务超过单次核对预算，原文件和备份均保留');
  for(const [index,row] of rows.entries()){
   if(index%128===0){signal.throwIfAborted();if(performance.now()>=deadline)throw new Error('备份任务核对达到时限，请稍后重试；文件均保留');await new Promise<void>(resolve=>setImmediate(resolve));}
   const d=this.jobs.descriptor(row.execution_id).worker;
   if(normalized(d.backupDir)!==normalized(root))continue;
   const name=`${row.id}-${d.backupArtifactId}.bak`.toLowerCase();
   let reason='';try{this.assertOrigin(row.id);}catch(error){if(error instanceof Error&&'code' in error)throw error;reason='恢复曲库中的旧备份任务已隔离，文件保留';}const endedAt=Date.parse(row.updated_at);
   if(!reason&&!['completed','cancelled'].includes(row.state))reason=row.state==='recovery_required'?'此任务仍需恢复，备份必须保留':'此任务尚未结束，备份仍被任务使用';
   else if(!reason&&(!Number.isFinite(endedAt)||new Date(endedAt).toISOString()!==row.updated_at))reason='任务结束时间不可确认';
   if(!reason){try{this.jobs.assertReadable(row.file_id);}catch{reason='此文件仍有写入、恢复或读取协调占用';}}
   if(!reason&&!this.db.prepare("SELECT 1 FROM media_file f JOIN library_root r ON r.id=f.root_id WHERE f.id=? AND f.status='online' AND r.status='online'").get(row.file_id))reason='当前音乐文件或目录不在线，保留备份以便恢复';
   if(!reason&&this.db.prepare("SELECT 1 FROM tag_stage_batch_item i JOIN tag_stage_batch b ON b.id=i.batch_id WHERE i.job_id=? AND b.status NOT IN('completed','cancelled') UNION ALL SELECT 1 FROM tag_commit_batch_item i JOIN tag_commit_batch b ON b.id=i.batch_id WHERE i.job_id=? AND b.status NOT IN('completed','cancelled') LIMIT 1").get(row.id,row.id))reason='此备份仍属于尚未结束的批次';
   if(!reason){
    for(const table of ['tag_recovery_inspection','tag_recovery_action','tag_commit_inspection','tag_commit_reprobe','tag_restore_inspection','tag_restore_reprobe']){
     if(this.db.prepare(`SELECT 1 FROM ${table} WHERE job_id=? AND state='running' LIMIT 1`).get(row.id)){reason='此备份仍在核对或恢复处理中';break;}
    }
   }
   const owned={jobId:row.id,title:row.title.slice(0,512),expectedBytes:d.plan.preview.sourceFileBytes,endedAt:Number.isFinite(endedAt)?endedAt:null,reason};
   if(result.has(name)){const prior=result.get(name)!;prior.reason='同一备份名称对应多个任务，须保留并核对';}else result.set(name,owned);
  }
  return result;
 }
}
