import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {validFileObservation} from './file-observation.js';
import type {ScanJob,ScanJobCommand,ScanJobResult,ScanJobPage,ScanIssuePage} from '../shared/contracts.js';

export const scanJobSchema=`
 CREATE TABLE scan_job(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,root_id TEXT NOT NULL,root_path TEXT NOT NULL,real_path TEXT,generation INTEGER,pass INTEGER NOT NULL DEFAULT 0 CHECK(pass>=0),status TEXT NOT NULL CHECK(status IN('queued','running','cancelling','succeeded','failed','cancelled','interrupted')),phase TEXT NOT NULL DEFAULT 'enumerating' CHECK(phase IN('enumerating','media','cue','finalizing')),revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),attempts INTEGER NOT NULL DEFAULT 0,owner TEXT,lease_until INTEGER,cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN(0,1)),scanned INTEGER NOT NULL DEFAULT 0,imported INTEGER NOT NULL DEFAULT 0,errors INTEGER NOT NULL DEFAULT 0,directories INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 1 CHECK(pending>=0),inventory_count INTEGER NOT NULL DEFAULT 1 CHECK(inventory_count>=1 AND inventory_count<=300000),unsafe INTEGER NOT NULL DEFAULT 0 CHECK(unsafe IN(0,1)),message TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE UNIQUE INDEX scan_job_root_active ON scan_job(root_id) WHERE status IN('queued','running','cancelling','interrupted');
 CREATE INDEX scan_job_pending ON scan_job(status,seq);
 CREATE TABLE scan_entry(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES scan_job(id),pass INTEGER NOT NULL,relative_path TEXT NOT NULL,path_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('directory','audio','cue')),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','done')),message TEXT NOT NULL DEFAULT '',unsafe INTEGER NOT NULL DEFAULT 0 CHECK(unsafe IN(0,1)),UNIQUE(job_id,pass,path_key));
 CREATE INDEX scan_entry_pending ON scan_entry(job_id,pass,kind,status,id);
 CREATE INDEX scan_entry_issues ON scan_entry(job_id,id) WHERE message<>'';
 CREATE TABLE scan_command(command_id TEXT PRIMARY KEY,request_json TEXT NOT NULL CHECK(json_valid(request_json)),result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at INTEGER NOT NULL);
 CREATE TRIGGER scan_command_immutable BEFORE UPDATE ON scan_command BEGIN SELECT RAISE(ABORT,'扫描操作回执不可修改'); END;
 CREATE TRIGGER scan_command_no_delete BEFORE DELETE ON scan_command BEGIN SELECT RAISE(ABORT,'扫描操作回执不可删除'); END;
 CREATE TRIGGER scan_job_identity BEFORE UPDATE OF id,seq,root_id,root_path,created_at ON scan_job BEGIN SELECT RAISE(ABORT,'扫描任务身份不可修改'); END;
`;
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function validateScanCommand(value:unknown):ScanJobCommand{
 const r=value as ScanJobCommand;if(!r||typeof r.commandId!=='string'||!uuid.test(r.commandId))throw new Error('无效扫描操作');
 if(r.action==='start'){if(typeof r.rootId!=='string'||!r.rootId||r.rootId.length>128)throw new Error('无效音乐目录');return {commandId:r.commandId,action:r.action,rootId:r.rootId};}
 if(!['cancel','resume'].includes(r.action)||typeof r.jobId!=='string'||!uuid.test(r.jobId)||!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0)throw new Error('无效扫描控制');
 return {commandId:r.commandId,action:r.action,jobId:r.jobId,baseRevision:r.baseRevision};
}
export class ScanCancelled extends Error{constructor(){super('扫描取消已确认');}}
export type ScanEntry={id:number;relative_path:string;kind:'directory'|'audio'|'cue';observation_hash:string|null;observed_at:number|null};
export type ScanInventoryEntry={path:string;kind:ScanEntry['kind'];observation?:string;observedAt?:number};
type Row={seq:number;id:string;root_id:string;root_path:string;real_path:string|null;generation:number|null;pass:number;status:ScanJob['status'];phase:ScanJob['phase'];revision:number;attempts:number;owner:string|null;lease_until:number|null;cancel_requested:number;scanned:number;imported:number;errors:number;directories:number;pending:number;inventory_count:number;unsafe:number;message:string;created_at:number;updated_at:number};
type Root={id:string;path:string;scan_generation:number;status:string};
export class ScanJobRepository{
 constructor(private readonly db:DatabaseSync,private readonly catalog:{root:(id:string)=>Root|undefined;begin:(id:string)=>number;continue:(id:string,generation:number)=>void;end:(id:string,complete:boolean)=>void;offline:(id:string)=>void;authorized?:(root:Root)=>void;scanAllowed?:(sequence:number)=>boolean;scanFloor?:()=>number}){}
 private transaction<T>(action:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=action();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 private raw(id:string):Row{if(typeof id!=='string'||!uuid.test(id))throw new Error('无效扫描任务');const r=this.db.prepare('SELECT * FROM scan_job WHERE id=?').get(id) as Row|undefined;if(!r)throw new Error('扫描任务不存在');return r;}
 private view(r:Row):ScanJob{
  const root=this.catalog.root(r.root_id),other=this.db.prepare("SELECT id FROM scan_job WHERE root_id=? AND id<>? AND status IN('queued','running','cancelling','interrupted') LIMIT 1").get(r.root_id,r.id);
  const pending=r.pending;
  return {id:r.id,rootId:r.root_id,path:r.root_path,status:r.status,phase:r.phase,pass:r.pass,generation:r.generation,revision:r.revision,attempts:r.attempts,scanned:r.scanned,imported:r.imported,errors:r.errors,directories:r.directories,pending,unsafe:!!r.unsafe,message:r.message,createdAt:r.created_at,updatedAt:r.updated_at,canResume:this.catalog.scanAllowed?.(r.seq)!==false&&['failed','cancelled','interrupted'].includes(r.status)&&!!root&&root.path===r.root_path&&(r.generation===null||root.scan_generation===r.generation)&&!other};
 }
 get(id:string):ScanJob{return this.view(this.raw(id));}
 activeForRoot(rootId:string):ScanJob|null{const row=this.db.prepare("SELECT id FROM scan_job WHERE root_id=? AND status IN('queued','running','cancelling','interrupted') ORDER BY seq DESC LIMIT 1").get(rootId) as {id:string}|undefined;return row?this.get(row.id):null;}
 lastBoundPath(rootId:string):string|null{return (this.db.prepare('SELECT real_path FROM scan_job WHERE root_id=? AND real_path IS NOT NULL ORDER BY seq DESC LIMIT 1').get(rootId) as {real_path:string}|undefined)?.real_path??null;}
 startReceipt(commandId:unknown):{rootId:string;jobId:string}|null{
  if(typeof commandId!=='string'||!uuid.test(commandId))throw new Error('无效扫描回执');
  const old=this.db.prepare('SELECT request_json,result_json FROM scan_command WHERE command_id=?').get(commandId) as {request_json:string;result_json:string}|undefined;
  if(!old)return null;const request=JSON.parse(old.request_json) as ScanJobCommand,result=JSON.parse(old.result_json) as ScanJobResult;
  if(request.action!=='start'||result.status!=='saved'||!result.job)throw new Error('扫描回执类型不匹配');return {rootId:request.rootId,jobId:result.job.id};
 }
 context(id:string):{realPath:string|null;path:string;rootId:string;generation:number|null;pass:number}{const r=this.raw(id);return {realPath:r.real_path,path:r.root_path,rootId:r.root_id,generation:r.generation,pass:r.pass};}
 command(value:unknown,authorizedRealPath?:string):ScanJobResult{
  const request=validateScanCommand(value),json=JSON.stringify(request);
  if(request.action==='start'){const root=this.catalog.root(request.rootId);if(!root)throw new Error('目录已被移除');this.catalog.authorized?.(root);}
  else if(request.action==='resume'){const row=this.raw(request.jobId),root=this.catalog.root(row.root_id);if(!root||this.catalog.scanAllowed?.(row.seq)===false)throw new Error('此扫描检查点来自恢复备份，请确认目录后发起新的扫描');this.catalog.authorized?.(root);}
  if(authorizedRealPath!==undefined&&(request.action!=='start'||typeof authorizedRealPath!=='string'||!path.isAbsolute(authorizedRealPath)||authorizedRealPath.length>4096||authorizedRealPath.includes('\0')))throw new Error('无效授权目录目标');
  return this.transaction(()=>{
   const old=this.db.prepare('SELECT request_json,result_json FROM scan_command WHERE command_id=?').get(request.commandId) as {request_json:string;result_json:string}|undefined;
   if(old){if(old.request_json!==json)throw new Error('同一扫描操作不可更改内容');return JSON.parse(old.result_json) as ScanJobResult;}
   const now=Date.now();let id:string;
   if(request.action==='start'){
    const root=this.catalog.root(request.rootId);if(!root)throw new Error('目录已被移除');
    let active=this.db.prepare("SELECT id FROM scan_job WHERE root_id=? AND status IN('queued','running','cancelling','interrupted')").get(root.id) as {id:string}|undefined;
    if(active){const current=this.raw(active.id);if(current.status==='interrupted'&&!this.view(current).canResume){this.db.prepare("UPDATE scan_job SET status='cancelled',revision=revision+1,updated_at=?,message='原范围已被替代，用户发起新的扫描' WHERE id=?").run(now,current.id);active=undefined;}}
    if(active){id=active.id;const existing=this.raw(id);if(existing.status==='interrupted')this.db.prepare("UPDATE scan_job SET status='queued',cancel_requested=0,revision=revision+1,updated_at=?,message='用户请求继续扫描' WHERE id=?").run(now,id);}
    else{
     const waiting=Number((this.db.prepare("SELECT count(*) n FROM scan_job WHERE status IN('queued','running','cancelling','interrupted')").get() as {n:number}).n);if(waiting>=64)throw new Error('待处理扫描超过 64 项，请先处理已有任务');
     id=randomUUID();this.db.prepare('INSERT INTO scan_job(id,root_id,root_path,status,created_at,updated_at) VALUES(?,?,?,\'queued\',?,?)').run(id,root.id,root.path,now,now);this.seed(id,0);
    }
    if(authorizedRealPath!==undefined){const current=this.raw(id);if(current.real_path!==null&&current.real_path!==authorizedRealPath)throw new Error('原任务的授权目录目标不同，请在任务中心处理');this.db.prepare('UPDATE scan_job SET real_path=? WHERE id=?').run(authorizedRealPath,id);}
   }else{
    const r=this.raw(request.jobId);id=r.id;
    if(r.revision!==request.baseRevision)throw new Error('扫描任务已变化，请刷新后再操作');
    if(request.action==='cancel'){
     if(!['queued','running','interrupted'].includes(r.status))throw new Error('当前任务状态无法取消');
     const status=r.status==='running'?'cancelling':'cancelled';
     if(status==='cancelled'&&r.generation!==null)this.endRoot(r,false,false);
     this.db.prepare('UPDATE scan_job SET status=?,cancel_requested=1,revision=revision+1,updated_at=?,message=? WHERE id=?').run(status,now,status==='cancelling'?'等待当前读取结束后确认取消':'用户已取消',id);
    }else{
     if(!this.view(r).canResume)throw new Error('原扫描范围已被新任务替代或目录已变化，请重新扫描');
     this.db.prepare("UPDATE scan_job SET status='queued',cancel_requested=0,owner=NULL,lease_until=NULL,revision=revision+1,updated_at=?,message='等待继续检查点' WHERE id=?").run(now,id);
    }
   }
   const result:ScanJobResult={status:'saved',job:this.get(id),error:''};this.db.prepare('INSERT INTO scan_command VALUES(?,?,?,?)').run(request.commandId,json,JSON.stringify(result),now);return result;
  });
 }
 private seed(id:string,pass:number):void{this.db.prepare("INSERT INTO scan_entry(job_id,pass,relative_path,path_key,kind) VALUES(?,?,'','','directory')").run(id,pass);}
 recover():void{
  this.transaction(()=>{
   const rows=this.db.prepare("SELECT * FROM scan_job WHERE status IN('running','cancelling')").all() as Row[];
   for(const r of rows){this.endRoot(r,false,false);this.db.prepare("UPDATE scan_job SET status=?,owner=NULL,lease_until=NULL,revision=revision+1,updated_at=?,message=? WHERE id=?").run(r.cancel_requested?'cancelled':'interrupted',Date.now(),r.cancel_requested?'重启后确认原取消请求':'扫描进程中断，安全检查点已保留',r.id);}
   // Legacy builds did not persist scans. Clear their stale running flag without missing reconciliation.
   this.db.prepare("UPDATE library_root SET status='online' WHERE status='scanning' AND id NOT IN(SELECT root_id FROM scan_job WHERE status IN('queued','running','cancelling'))").run();
  });
 }
 next():string|null{return (this.db.prepare("SELECT id FROM scan_job WHERE status='queued' AND seq>? ORDER BY seq LIMIT 1").get(this.catalog.scanFloor?.()??0) as {id:string}|undefined)?.id??null;}
 interruptForMaintenance(id:string,owner:string):void{
  this.transaction(()=>{const r=this.raw(id);if(r.owner!==owner||!['running','cancelling'].includes(r.status))throw new Error('维护扫描租约身份已变化');this.endRoot(r,false,false);
   this.db.prepare('UPDATE scan_job SET status=?,owner=NULL,lease_until=NULL,revision=revision+1,updated_at=?,message=? WHERE id=?').run(r.cancel_requested?'cancelled':'interrupted',Date.now(),r.cancel_requested?'维护时确认已有取消请求':'曲库维护中断扫描，安全检查点保留；可在任务中心明确继续',id);
  });
 }
 claim(id:string,owner:string):void{
  const before=this.raw(id),root=this.catalog.root(before.root_id);if(!root||this.catalog.scanAllowed?.(before.seq)===false)throw new Error('恢复前的扫描任务已隔离，不能启动');this.catalog.authorized?.(root);
  this.transaction(()=>{const r=this.raw(id),root=this.catalog.root(r.root_id);if(r.status!=='queued'||!root||root.path!==r.root_path)throw new Error('扫描目录或状态已变化');
   let generation=r.generation;
   if(generation===null)generation=this.catalog.begin(root.id);else this.catalog.continue(root.id,generation);
   this.db.prepare("UPDATE scan_job SET generation=?,status='running',owner=?,lease_until=?,attempts=attempts+1,revision=revision+1,updated_at=? WHERE id=?").run(generation,owner,Date.now()+60000,Date.now(),id);
  });
 }
 private owned(id:string,owner:string):Row{const r=this.raw(id);if(r.owner!==owner||!['running','cancelling'].includes(r.status))throw new Error('扫描租约身份已变化');if(r.cancel_requested)throw new ScanCancelled();return r;}
 heartbeat(id:string,owner:string):void{this.owned(id,owner);this.db.prepare('UPDATE scan_job SET lease_until=? WHERE id=?').run(Date.now()+60000,id);}
 workerFault(id:string,owner:string,message:string):void{const r=this.raw(id);if(r.owner!==owner||!['running','cancelling'].includes(r.status))throw new Error('扫描租约身份已变化');this.db.prepare('UPDATE scan_job SET message=?,revision=revision+1,updated_at=? WHERE id=?').run(message.slice(0,500),Date.now(),id);}
 bind(id:string,owner:string,realPath:string):void{const r=this.owned(id,owner);if(r.real_path!==null&&r.real_path!==realPath)throw new Error('授权目录目标已变化');this.db.prepare('UPDATE scan_job SET real_path=? WHERE id=?').run(realPath,id);}
 mediaChecked(id:string,relative:string):boolean{const r=this.raw(id);return !!this.db.prepare("SELECT id FROM scan_entry WHERE job_id=? AND pass=? AND path_key=? AND kind='audio' AND status='done' AND message=''").get(id,r.pass,relative.normalize('NFKC').toLocaleLowerCase().trim());}
 containsCue(id:string,relative:string):boolean {
  const r=this.raw(id),row=this.db.prepare('SELECT kind FROM scan_entry WHERE job_id=? AND pass=? AND path_key=?').get(id,r.pass,relative.normalize('NFKC').toLocaleLowerCase().trim()) as {kind:string}|undefined;
  if(row&&row.kind!=='cue')throw new Error('历史CUE来源与本轮其他类型路径冲突，保留原记录');return Boolean(row);
 }
 pending(id:string,kind:ScanEntry['kind']):ScanEntry|null{const r=this.raw(id);return this.db.prepare("SELECT id,relative_path,kind,observation_hash,observed_at FROM scan_entry WHERE job_id=? AND pass=? AND kind=? AND status='pending' ORDER BY id LIMIT 1").get(id,r.pass,kind) as ScanEntry|undefined??null;}
 observe(id:string,owner:string,entry:ScanEntry,stamp:string,at:number):void{
  const r=this.owned(id,owner);if(!validFileObservation(stamp)||!Number.isSafeInteger(at)||at<0)throw new Error('扫描稳定观察无效');
  const saved=this.db.prepare("UPDATE scan_entry SET observation_hash=?,observed_at=? WHERE id=? AND job_id=? AND pass=? AND status='pending'").run(stamp,at,entry.id,id,r.pass);if(Number(saved.changes)!==1)throw new Error('扫描观察检查点已变化');entry.observation_hash=stamp;entry.observed_at=at;
 }
 add(id:string,owner:string,entries:ScanInventoryEntry[]):void{
  if(entries.length>256)throw new Error('扫描目录批次过大');
  this.transaction(()=>{const r=this.owned(id,owner);let added=0;
   const insert=this.db.prepare('INSERT OR IGNORE INTO scan_entry(job_id,pass,relative_path,path_key,kind,observation_hash,observed_at) VALUES(?,?,?,?,?,?,?)');
   for(const entry of entries){if(typeof entry.path!=='string'||entry.path.length>32768||!['directory','audio','cue'].includes(entry.kind)||entry.observation!==undefined&&(!validFileObservation(entry.observation)||!Number.isSafeInteger(entry.observedAt)||entry.observedAt!<0)||entry.observation===undefined&&entry.observedAt!==undefined)throw new Error('扫描清单条目无效');const key=entry.path.normalize('NFKC').toLocaleLowerCase().trim();const old=this.db.prepare('SELECT relative_path,kind FROM scan_entry WHERE job_id=? AND pass=? AND path_key=?').get(id,r.pass,key) as {relative_path:string;kind:string}|undefined;if(old&&(old.relative_path!==entry.path||old.kind!==entry.kind))throw new Error('扫描路径规范化冲突，未执行缺失判定');added+=Number(insert.run(id,r.pass,entry.path,key,entry.kind,entry.observation??null,entry.observedAt??null).changes);}
   if(r.inventory_count+added>300000)throw new Error('本轮目录清单超过 30 万项，未执行缺失判定');
   this.db.prepare('UPDATE scan_job SET pending=pending+?,inventory_count=inventory_count+?,lease_until=?,updated_at=? WHERE id=?').run(added,added,Date.now()+60000,Date.now(),id);
  });
 }
 checkpoint(id:string,owner:string,entry:ScanEntry,result:{imported:number;message?:string;unsafe?:boolean},apply:()=>void=()=>{}):void{
  this.transaction(()=>{const r=this.owned(id,owner),current=this.db.prepare("SELECT id FROM scan_entry WHERE id=? AND job_id=? AND pass=? AND status='pending'").get(entry.id,id,r.pass);if(!current)throw new Error('扫描检查点已变化');apply();
   const message=(result.message??'').slice(0,500);this.db.prepare("UPDATE scan_entry SET status='done',message=?,unsafe=? WHERE id=?").run(message,result.unsafe?1:0,entry.id);
   this.db.prepare('UPDATE scan_job SET pending=pending-1,scanned=scanned+?,directories=directories+?,imported=imported+?,errors=errors+?,unsafe=max(unsafe,?),message=?,updated_at=?,lease_until=? WHERE id=?').run(entry.kind==='audio'?1:0,entry.kind==='directory'?1:0,result.imported,message?1:0,result.unsafe?1:0,message,Date.now(),Date.now()+60000,id);
  });
 }
 phase(id:string,owner:string,phase:ScanJob['phase']):void{this.owned(id,owner);this.db.prepare('UPDATE scan_job SET phase=?,revision=revision+1,updated_at=? WHERE id=?').run(phase,Date.now(),id);}
 verification(id:string,owner:string):void{
  this.transaction(()=>{const r=this.owned(id,owner),root=this.catalog.root(r.root_id);if(!root||root.scan_generation!==r.generation)throw new Error('扫描代次已变化');const generation=this.catalog.begin(root.id),pass=r.pass+1;this.seed(id,pass);this.db.prepare("UPDATE scan_job SET pass=?,generation=?,phase='enumerating',pending=1,inventory_count=1,unsafe=0,revision=revision+1,message='重新枚举并完成缺失对账',updated_at=? WHERE id=?").run(pass,generation,Date.now(),id);});
 }
 private endRoot(r:Row,complete:boolean,offline:boolean):void{const root=this.catalog.root(r.root_id);if(root&&root.path===r.root_path&&root.scan_generation===r.generation){this.catalog.end(root.id,complete);if(offline)this.catalog.offline(root.id);}}
 finish(id:string,owner:string,status:'succeeded'|'failed'|'cancelled',message:string,offline=false):void{
  this.transaction(()=>{const r=this.raw(id);if(r.owner!==owner||!['running','cancelling','queued'].includes(r.status))throw new Error('扫描结束身份已变化');const cancelled=!!r.cancel_requested;if(cancelled)status='cancelled';const complete=status==='succeeded'&&r.pass>=1&&!r.unsafe&&r.phase==='finalizing'&&r.pending===0;if(status==='succeeded'&&!complete){status='failed';message='扫描检查点尚未完整，未执行缺失对账';}this.endRoot(r,complete,offline);this.db.prepare('UPDATE scan_job SET status=?,owner=NULL,lease_until=NULL,revision=revision+1,message=?,updated_at=? WHERE id=?').run(status,message.slice(0,500),Date.now(),id);});
 }
 failQueued(id:string,message:string):void{this.transaction(()=>{const r=this.raw(id);if(r.status!=='queued')return;this.db.prepare("UPDATE scan_job SET status='failed',revision=revision+1,message=?,updated_at=? WHERE id=?").run(message.slice(0,500),Date.now(),id);});}
 list(cursor?:string):ScanJobPage{let end:number|null=null;if(cursor!==undefined){end=Number(cursor);if(!/^\d{1,16}$/.test(cursor)||!Number.isSafeInteger(end)||end<1)throw new Error('无效任务分页');}const rows=this.db.prepare(`SELECT * FROM scan_job ${end===null?'':'WHERE seq<?'} ORDER BY seq DESC LIMIT 21`).all(...(end===null?[]:[end])) as Row[];return {items:rows.slice(0,20).map(r=>this.view(r)),nextCursor:rows.length>20?String(rows[19].seq):null};}
 issues(id:string,cursor?:string):ScanIssuePage{this.raw(id);let end=0;if(cursor!==undefined){if(cursor.length>512)throw new Error('无效扫描异常分页');try{const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(c.jobId!==id||!Number.isSafeInteger(c.id)||c.id<1)throw new Error();end=c.id;}catch{throw new Error('扫描异常分页不匹配');}}const rows=this.db.prepare("SELECT id,relative_path,kind,message,pass,unsafe FROM scan_entry WHERE job_id=? AND message<>'' AND id>? ORDER BY id LIMIT 21").all(id,end) as Array<{id:number;relative_path:string;kind:ScanEntry['kind'];message:string;pass:number;unsafe:number}>;return {items:rows.slice(0,20).map(r=>({id:r.id,path:r.relative_path,kind:r.kind,message:r.message,pass:r.pass,unsafe:!!r.unsafe})),nextCursor:rows.length>20?Buffer.from(JSON.stringify({jobId:id,id:rows[19].id})).toString('base64url'):null};}
}
