import type {DatabaseSync} from 'node:sqlite';
import {tagRestoreSchema} from './tag-restore-schema.js';

// Rebuild the parent table using SQLite's documented generalized ALTER procedure.
// Existing receipts and child foreign keys retain their original names and rows.
export function migrateTagRestoreAttempts(db:DatabaseSync,transaction:<T>(action:()=>T)=>T,verify:()=>void=()=>{}):void {
 if(db.isTransaction||Number((db.prepare('PRAGMA foreign_keys').get() as {foreign_keys:number}).foreign_keys)!==1)throw new Error('恢复尝试迁移要求独立且已启用外键的连接');
 const end=tagRestoreSchema.indexOf(' CREATE INDEX tag_restore_recent'),receipt=tagRestoreSchema.indexOf(' CREATE TABLE tag_restore_receipt');
 const canonical=(sql:string)=>sql.replace(/\s+/g,' ').trim().replace(/;$/,'');
 const prior=db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='tag_restore_operation'").get() as {sql:string}|undefined;
 if(!prior||canonical(prior.sql)!==canonical(tagRestoreSchema.slice(0,end)))throw new Error('恢复尝试迁移前的父表结构与已知版本不符');
 const create=tagRestoreSchema.slice(0,end).replace('CREATE TABLE tag_restore_operation','CREATE TABLE new_tag_restore_operation').replaceAll('NOT NULL UNIQUE REFERENCES','NOT NULL REFERENCES').replace('  inspection_id TEXT','  predecessor_id TEXT REFERENCES tag_restore_operation(id) ON DELETE RESTRICT,resume_inspection_id TEXT REFERENCES tag_restore_inspection(id) ON DELETE RESTRICT,attempt_number INTEGER NOT NULL DEFAULT 0 CHECK(attempt_number BETWEEN 0 AND 15),\n  inspection_id TEXT').replace("  CHECK(state<>","  CHECK((attempt_number=0 AND predecessor_id IS NULL AND resume_inspection_id IS NULL) OR(attempt_number>0 AND predecessor_id IS NOT NULL AND resume_inspection_id IS NOT NULL)),\n  CHECK(state<>");
 let objects=tagRestoreSchema.slice(end,receipt);
 objects=objects.replace(/ CREATE TRIGGER tag_restore_owner[\s\S]*? END;/,'');
 objects=objects.replace('UPDATE OF id,','UPDATE OF predecessor_id,resume_inspection_id,attempt_number,id,');
 const owner=`
 CREATE UNIQUE INDEX tag_restore_one_root ON tag_restore_operation(job_id) WHERE predecessor_id IS NULL;
 CREATE UNIQUE INDEX tag_restore_one_successor ON tag_restore_operation(predecessor_id) WHERE predecessor_id IS NOT NULL;
 CREATE TRIGGER tag_restore_owner BEFORE INSERT ON tag_restore_operation WHEN
  NOT EXISTS(SELECT 1 FROM tag_commit_operation c JOIN tag_write_job j ON j.id=c.job_id WHERE c.id=NEW.commit_operation_id AND c.job_id=NEW.job_id AND c.file_id=NEW.file_id AND c.lease_id=NEW.lease_id AND j.revision=NEW.base_revision AND j.state='recovery_required') OR
  (NEW.predecessor_id IS NULL AND NOT EXISTS(SELECT 1 FROM tag_commit_inspection i WHERE i.id=NEW.inspection_id AND i.operation_id=NEW.commit_operation_id AND i.base_revision=NEW.base_revision AND i.state='completed' AND i.exit_confirmed=1)) OR
  (NEW.predecessor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tag_restore_operation p JOIN tag_restore_inspection i ON i.operation_id=p.id JOIN tag_write_file_state f ON f.file_id=p.file_id WHERE p.id=NEW.predecessor_id AND p.job_id=NEW.job_id AND p.file_id=NEW.file_id AND p.commit_operation_id=NEW.commit_operation_id AND p.inspection_id=NEW.inspection_id AND p.state='recovery_required' AND p.attempt_number+1=NEW.attempt_number AND p.lease_id=NEW.lease_id AND p.lease_revision+1=NEW.lease_revision AND i.id=NEW.resume_inspection_id AND i.base_revision=NEW.base_revision AND i.state='completed' AND i.exit_confirmed=1 AND f.lease_state='recovery' AND f.lease_id=p.lease_id AND f.lease_revision=p.lease_revision))
 BEGIN SELECT RAISE(ABORT,'恢复尝试不属于当前提交、前次尝试和核对'); END;`;
 const known=new Set([...tagRestoreSchema.slice(0,receipt).matchAll(/\bCREATE (?:UNIQUE )?(?:INDEX|TRIGGER) (\w+)/gi)].map(match=>match[1]));
 const external=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND type IN('index','trigger','view')").all() as Array<{type:string;name:string;tbl_name:string;sql:string}>;
 const dependent=external.filter(row=>row.tbl_name==='tag_restore_operation'?!known.has(row.name):/\btag_restore_operation\b/i.test(row.sql));
 if(dependent.some(row=>!/^[A-Za-z0-9_]+$/.test(row.name)))throw new Error('恢复迁移依赖对象名称不可确认');
 const columns=(db.prepare('PRAGMA table_info(tag_restore_operation)').all() as {name:string}[]).map(row=>row.name);
 if(columns.some(name=>!/^[a-z_][a-z0-9_]*$/.test(name)))throw new Error('恢复迁移字段不可确认');
 db.exec('PRAGMA foreign_keys=OFF');
 try{transaction(()=>{
  db.exec(create);db.exec(`INSERT INTO new_tag_restore_operation(${columns.join(',')}) SELECT ${columns.join(',')} FROM tag_restore_operation`);
  for(const row of dependent)db.exec(`DROP ${row.type.toUpperCase()} "${row.name}"`);
  db.exec('DROP TABLE tag_restore_operation; ALTER TABLE new_tag_restore_operation RENAME TO tag_restore_operation');
  db.exec(objects+owner);for(const row of dependent)db.exec(row.sql);
  if(db.prepare('PRAGMA foreign_key_check').get()||(db.prepare('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check!=='ok')throw new Error('恢复尝试迁移完整性核对失败');
  verify();db.exec('PRAGMA user_version=80');
 });}finally{db.exec('PRAGMA foreign_keys=ON');}
 if(Number((db.prepare('PRAGMA foreign_keys').get() as {foreign_keys:number}).foreign_keys)!==1)throw new Error('恢复迁移后外键未重新启用');
}
