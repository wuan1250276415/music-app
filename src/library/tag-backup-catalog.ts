import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {TagWriteJobs} from './tag-write-jobs.js';
const LIMIT=65536;
const normalized=(name:string)=>process.platform==='win32'?path.resolve(name).toLowerCase():path.resolve(name);
export type TagBackupOwned={jobId:string;title:string;expectedBytes:string;endedAt:number|null;reason:string};
type JobRow={id:string;file_id:string;title:string;state:string;updated_at:string;execution_id:string};
export class TagBackupCatalog {
 constructor(private readonly db:DatabaseSync,private readonly jobs:TagWriteJobs){}
 async ownership(root:string,signal:AbortSignal,deadline:number):Promise<Map<string,TagBackupOwned>>{
  const result=new Map<string,TagBackupOwned>();
  const rows=this.db.prepare('SELECT j.id,j.file_id,j.title,j.state,j.updated_at,e.id execution_id FROM tag_write_execution e JOIN tag_write_job j ON j.id=e.job_id ORDER BY e.id LIMIT 65537').all() as JobRow[];
  if(rows.length>LIMIT)throw new Error('备份任务超过单次核对预算，原文件和备份均保留');
  for(const [index,row] of rows.entries()){
   if(index%128===0){signal.throwIfAborted();if(performance.now()>=deadline)throw new Error('备份任务核对达到时限，请稍后重试；文件均保留');await new Promise<void>(resolve=>setImmediate(resolve));}
   const d=this.jobs.descriptor(row.execution_id).worker;
   if(normalized(d.backupDir)!==normalized(root))continue;
   const name=`${row.id}-${d.backupArtifactId}.bak`.toLowerCase();
   let reason='';const endedAt=Date.parse(row.updated_at);
   if(!['completed','cancelled'].includes(row.state))reason=row.state==='recovery_required'?'此任务仍需恢复，备份必须保留':'此任务尚未结束，备份仍被任务使用';
   else if(!Number.isFinite(endedAt)||new Date(endedAt).toISOString()!==row.updated_at)reason='任务结束时间不可确认';
   if(!reason){try{this.jobs.assertReadable(row.file_id);}catch{reason='此文件仍有写入、恢复或读取协调占用';}}
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
