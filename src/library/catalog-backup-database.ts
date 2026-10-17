import {DatabaseSync} from 'node:sqlite';
import {openSync,closeSync,readSync,lstatSync,fstatSync,realpathSync,existsSync,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {backupUuid,readBackupCounts,CATALOG_BACKUP_SCHEMA,CATALOG_BACKUP_COUNT_TABLES,CATALOG_BACKUP_MAX_FILE,type BackupCounts,type CatalogBackupManifest} from '../shared/catalog-backup.js';
import {cuePathKey} from './cue-history.js';

export type BackupDatabaseMetadata={schema:68|69|70|71|72|73|74|75|76|77|78|79|80|81|82|83|84|85|86;origin:string;counts:BackupCounts};
const normalized=(s:string)=>process.platform==='win32'?path.resolve(s).toLowerCase():path.resolve(s);
const same=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev&&a.ino===b.ino&&a.birthtimeNs===b.birthtimeNs&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;
function ordinary(s:BigIntStats):void{if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size<512n||s.size>BigInt(CATALOG_BACKUP_MAX_FILE))throw new Error('备份数据库须为预算内的普通独立快照文件');}
function filenameCheck(filename:string):void{
 if(!path.isAbsolute(filename)||filename.length>32767||path.basename(filename)!=='library.db')throw new Error('暂存曲库位置无效');
 const resolved=path.resolve(filename),root=path.parse(resolved).root;let current=root;
 for(const part of resolved.slice(root.length).split(path.sep).filter(Boolean).slice(0,-1)){current=path.join(current,part);const stat=lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('暂存曲库目录有链接或位置无效');}
 if(normalized(realpathSync(filename))!==normalized(filename))throw new Error('暂存曲库实际位置不符');
 for(const suffix of ['-wal','-shm','-journal'])if(existsSync(filename+suffix))throw new Error('备份曲库必须是无需WAL或日志文件的独立一致快照');
}
// Call only for an owned offline snapshot in a supervised maintenance worker.
// This does not open LibraryDatabase, register repositories, migrate, or repair data.
export function inspectCatalogBackupDatabase(filename:string,expected?:Pick<CatalogBackupManifest,'schema'|'origin'|'counts'>,inspect?:(db:DatabaseSync)=>void,inspectData?:(db:DatabaseSync)=>void):BackupDatabaseMetadata{
 filenameCheck(filename);const before=lstatSync(filename,{bigint:true});ordinary(before);const fd=openSync(filename,'r');let db:DatabaseSync|undefined;
 try{
  if(!same(before,fstatSync(fd,{bigint:true})))throw new Error('暂存曲库在打开期间变化');
  const header=Buffer.alloc(100);if(readSync(fd,header,0,100,0)!==100||!header.subarray(0,16).equals(Buffer.from('SQLite format 3\0'))||header[18]!==1||header[19]!==1)throw new Error('备份曲库头部不是独立回滚日志模式快照');
  db=new DatabaseSync(filename,{readOnly:true,allowExtension:false,timeout:1000});
  // The existing deterministic expression index uses this fixed, read-only function.
  db.function('aural_cue_path_key_v1',{deterministic:true},value=>{if(typeof value!=='string')throw new Error('备份CUE路径键无效');return cuePathKey(value);});
  db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA cache_size=-4096; BEGIN');
  inspect?.(db);
  const schema=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
  if(![68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,CATALOG_BACKUP_SCHEMA].includes(schema)||expected&&expected.schema!==schema)throw new Error('备份数据库版本不受当前恢复实现支持');
  const mode=(db.prepare('PRAGMA journal_mode').get() as {journal_mode:string}).journal_mode;
  if(mode!=='delete')throw new Error('暂存曲库尚未规范为独立DELETE日志模式');
  for(const name of [...CATALOG_BACKUP_COUNT_TABLES,'rule_transfer_origin','playback_counting_setting']){
   const row=db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(name) as {type:string;sql:string}|undefined;
   if(!row||row.type!=='table'||typeof row.sql!=='string'||/\bVIRTUAL\b/i.test(row.sql))throw new Error('备份曲库缺少必要的普通数据表：'+name);
  }
  const integrity=db.prepare('PRAGMA integrity_check(1)').all() as Array<{integrity_check:string}>;
  if(integrity.length!==1||integrity[0].integrity_check!=='ok')throw new Error('备份曲库完整性检查失败');
  for(const _row of db.prepare('PRAGMA foreign_key_check').iterate())throw new Error('备份曲库外键检查失败');
  const pageSize=Number((db.prepare('PRAGMA page_size').get() as {page_size:number}).page_size),pageCount=Number((db.prepare('PRAGMA page_count').get() as {page_count:number}).page_count);
  if(!Number.isSafeInteger(pageCount)||pageCount<1||pageSize<512||pageSize>65536||!Number.isInteger(Math.log2(pageSize))||BigInt(pageCount)*BigInt(pageSize)!==before.size)throw new Error('备份曲库页面尺寸或文件边界不符');
  const origins=db.prepare('SELECT slot,id FROM rule_transfer_origin LIMIT 2').all() as Array<{slot:number;id:string}>;
  if(origins.length!==1||origins[0].slot!==1)throw new Error('备份曲库来源身份缺失或重复');const origin=backupUuid(origins[0].id);
  const raw={} as Record<string,number>;
  // SQL identifiers come exclusively from the compile-time list, never the manifest.
  for(const name of CATALOG_BACKUP_COUNT_TABLES)raw[name]=Number((db.prepare(`SELECT COUNT(*) n FROM ${name}`).get() as {n:number}).n);
  const counts=readBackupCounts(raw);
  if(expected&&(origin!==expected.origin||CATALOG_BACKUP_COUNT_TABLES.some(key=>counts[key]!==expected.counts[key])))throw new Error('备份来源或关键用户数据计数与清单不符');
  inspectData?.(db);
  db.exec('ROLLBACK');db.close();db=undefined;
  filenameCheck(filename);if(!same(before,fstatSync(fd,{bigint:true}))||!same(before,lstatSync(filename,{bigint:true})))throw new Error('暂存曲库在检查期间变化');return {schema:schema as 68|69|70|71|72|73|74|75|76|77|78|79|80|81|82|83|84|85|86,origin,counts};
 }finally{try{if(db){try{if(db.isTransaction)db.exec('ROLLBACK');}finally{db.close();}}}finally{closeSync(fd);}}
}
