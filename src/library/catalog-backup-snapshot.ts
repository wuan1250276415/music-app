import {backup,DatabaseSync} from 'node:sqlite';
import {promises as fs,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {backupUuid,backupPathRole,backupFileLimit,readCatalogBackupManifest,readRendererPendingSnapshot,readBackupCounts,CATALOG_BACKUP_SCHEMA,CATALOG_BACKUP_COUNT_TABLES,CATALOG_BACKUP_MAX_FILE,CATALOG_BACKUP_MAX_FILES,CATALOG_BACKUP_MAX_PAYLOAD,CATALOG_BACKUP_PENDING_BYTES,type BackupPlugin,type CatalogBackupManifest} from '../shared/catalog-backup.js';
import {inspectCatalogBackupDatabase,type BackupDatabaseMetadata} from './catalog-backup-database.js';
import {prepareCatalogBackupStage,prepareCatalogBackupEntry,copyCatalogBackupEntry,writeCatalogBackupState,inventoryCatalogBackupTree} from '../platform/catalog-backup-file.js';
import type {LibraryDatabase} from './database.js';
import type {CatalogCaptureRequest,CatalogCapturedSnapshot} from '../shared/catalog-maintenance.js';

const normal=(s:string)=>process.platform==='win32'?path.resolve(s).toLowerCase():path.resolve(s);
const identity=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev&&a.ino===b.ino&&a.birthtimeNs===b.birthtimeNs;
const observed=(a:BigIntStats,b:BigIntStats)=>identity(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;
async function directory(filename:string):Promise<BigIntStats>{
 if(!path.isAbsolute(filename)||filename.length>32767)throw new Error('备份资料目录无效');const root=path.parse(path.resolve(filename)).root;let current=root;
 for(const part of path.resolve(filename).slice(root.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const stat=await fs.lstat(current,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('备份资料目录有链接或不是普通目录');}
 if(normal(await fs.realpath(filename))!==normal(filename))throw new Error('备份资料目录实际位置不符');return fs.lstat(filename,{bigint:true});
}
export function catalogSnapshotEstimate(db:DatabaseSync):number{
 if(db.isTransaction||Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version)!==CATALOG_BACKUP_SCHEMA)throw new Error('曲库事务尚未结束或版本不适合备份');
 const count=Number((db.prepare('PRAGMA page_count').get() as {page_count:number}).page_count),size=Number((db.prepare('PRAGMA page_size').get() as {page_size:number}).page_size),bytes=count*size;
 if(!Number.isSafeInteger(bytes)||bytes<512||bytes>CATALOG_BACKUP_MAX_FILE)throw new Error('曲库快照大小超过预算');return bytes;
}
export function sourceMetadata(db:DatabaseSync):BackupDatabaseMetadata{
 catalogSnapshotEstimate(db);const row=db.prepare('SELECT id FROM rule_transfer_origin WHERE slot=1').get() as {id:string}|undefined;if(!row)throw new Error('曲库备份来源身份缺失');
 const raw:Record<string,number>={};for(const name of CATALOG_BACKUP_COUNT_TABLES)raw[name]=Number((db.prepare(`SELECT COUNT(*) n FROM ${name}`).get() as {n:number}).n);
 return {schema:CATALOG_BACKUP_SCHEMA,origin:backupUuid(row.id),counts:readBackupCounts(raw)};
}
// Only the Library maintenance owner may call this with its frozen connection.
// It uses sqlite3_backup through Node; never copies an active library.db alone.
export async function createCatalogDatabaseSnapshot(db:DatabaseSync,filename:string,check:()=>void):Promise<BackupDatabaseMetadata>{
 check();const expected=sourceMetadata(db);if(path.basename(filename)!=='library.db')throw new Error('曲库快照目标名称无效');await directory(path.dirname(filename));
 const reservation=await fs.open(filename,'wx',0o600);let target:DatabaseSync|undefined;
 try{
  const created=await reservation.stat({bigint:true});check();await backup(db,filename,{rate:128});check();
  if(db.isTransaction||JSON.stringify(sourceMetadata(db))!==JSON.stringify(expected))throw new Error('曲库在一致快照期间发生变化');
  const copied=await fs.lstat(filename,{bigint:true});if(!copied.isFile()||copied.isSymbolicLink()||copied.nlink!==1n||!identity(created,copied)||copied.size>BigInt(CATALOG_BACKUP_MAX_FILE))throw new Error('曲库快照文件身份不符');
  target=new DatabaseSync(filename,{allowExtension:false,timeout:1000});target.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE');target.close();target=undefined;await reservation.sync();check();
  const named=await fs.lstat(filename,{bigint:true}),held=await reservation.stat({bigint:true});if(!identity(created,named)||!observed(named,held))throw new Error('规范后的曲库快照身份不符');
  const result=inspectCatalogBackupDatabase(filename,expected);check();return result;
 }finally{try{if(target)target.close();}finally{await reservation.close();}}
}
type Managed={relative:string;source:string;before:BigIntStats};
const managedFolders=['tag-backups','tag-write','tag-commit','tag-restore','tag-backup-cleanup'] as const;
async function managedFiles(library:string,check:()=>void):Promise<Managed[]>{
 await directory(library);const files:Managed[]=[];let nodes=0;
 async function walk(source:string,relative:string):Promise<void>{
  check();const before=await directory(source),entries=await fs.readdir(source,{withFileTypes:true});if((nodes+=entries.length)>CATALOG_BACKUP_MAX_FILES*3)throw new Error('写回恢复目录数量超过备份预算');
  for(const entry of entries){
   check();const filename=path.join(source,entry.name),name=relative+'/'+entry.name,stat=await fs.lstat(filename,{bigint:true});if(stat.isSymbolicLink())throw new Error('写回恢复资料包含链接');
   if(stat.isDirectory()){
    if(relative.split('/').length!==2||relative.endsWith('/tag-backups'))throw new Error('写回恢复资料有未知目录');backupUuid(entry.name);await walk(filename,name);
   }else{
    const role=backupPathRole(name);if(!stat.isFile()||stat.nlink!==1n||stat.size<0n||stat.size>BigInt(backupFileLimit({path:name,role})))throw new Error('写回恢复工件类型或大小无法确认');
    files.push({relative:name,source:filename,before:stat});if(files.length>CATALOG_BACKUP_MAX_FILES-3)throw new Error('写回恢复文件超过备份预算');
   }
  }
  if(!observed(before,await directory(source)))throw new Error('写回恢复目录在列举期间变化');
 }
 for(const name of managedFolders){const folder=path.join(library,name);const stat=await fs.lstat(folder,{bigint:true}).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});if(stat)await walk(folder,'library/'+name);}
 return files.sort((a,b)=>a.relative<b.relative?-1:a.relative>b.relative?1:0);
}
async function storeDirectory(userData:string):Promise<string>{
 await directory(userData);let current=userData;
 for(const part of ['backups','catalog']){await directory(current);current=path.join(current,part);try{await fs.mkdir(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}await directory(current);}return current;
}
export class CatalogSnapshotError extends Error{constructor(readonly stagePath:string,cause:unknown){super('曲库快照未完成，保留独立暂存资料供核对',{cause});this.name='CatalogSnapshotError';}}
export async function captureQuiescedCatalog(input:{db:LibraryDatabase;dataDir:string;request:CatalogCaptureRequest;appVersion:string;components:BackupPlugin[];check:()=>void}):Promise<CatalogCapturedSnapshot>{
 const deadline=Date.now()+45*60*1000,check=()=>{input.check();if(Date.now()>deadline)throw new Error('曲库快照捕获超过45分钟预算');};check();
 const pending=readRendererPendingSnapshot(input.request.pending),pendingBytes=Buffer.from(JSON.stringify(pending),'utf8'),owned=await managedFiles(input.dataDir,check),userData=path.dirname(input.dataDir),parent=await storeDirectory(userData);
 if(pendingBytes.length>CATALOG_BACKUP_PENDING_BYTES)throw new Error('编码后的界面待核对资料超过4MiB预算');
 const historyPath=path.join(userData,'playback-history-pending.json'),historyStat=await fs.lstat(historyPath,{bigint:true}).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
 if(historyStat&&(!historyStat.isFile()||historyStat.isSymbolicLink()||historyStat.nlink!==1n||historyStat.size>16n*1024n*1024n))throw new Error('Main待保存播放历史无法完整纳入备份');
 const expectedSize=input.db.catalogBackupSize()+pendingBytes.length+owned.reduce((n,file)=>n+Number(file.before.size),0)+(historyStat?Number(historyStat.size):0);
 if(!Number.isSafeInteger(expectedSize)||expectedSize>CATALOG_BACKUP_MAX_PAYLOAD)throw new Error('完整曲库快照超过64GiB预算');
 const space=await fs.statfs(parent,{bigint:true});if(space.bavail*space.bsize<BigInt(expectedSize)+64n*1024n*1024n)throw new Error('一致快照的可用磁盘空间不足');check();
 const stagePath=await prepareCatalogBackupStage(parent,input.request.operationId),stageIdentity=await directory(stagePath);
 try{
  const filename=await prepareCatalogBackupEntry(stagePath,'library/library.db'),metadata=await input.db.createCatalogBackupDatabase(filename,check);check();
  await writeCatalogBackupState(stagePath,'state/renderer-pending.json',pendingBytes,{check});
  if(historyStat){await copyCatalogBackupEntry(historyPath,stagePath,'state/playback-history-pending.json',{check});if(!observed(historyStat,await fs.lstat(historyPath,{bigint:true})))throw new Error('Main待保存播放历史在捕获期间变化');}
  else if(await fs.lstat(historyPath).then(()=>true).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}))throw new Error('捕获期间新增Main待保存播放历史，必须重新冻结');
  for(const file of owned){check();await copyCatalogBackupEntry(file.source,stagePath,file.relative,{check});}
  const after=await managedFiles(input.dataDir,check);if(after.length!==owned.length||after.some((file,index)=>file.relative!==owned[index].relative||!observed(file.before,owned[index].before)))throw new Error('写回恢复资料在快照期间变化');
  const files=await inventoryCatalogBackupTree(stagePath,{check});check();if(!identity(stageIdentity,await directory(stagePath)))throw new Error('曲库快照暂存区身份变化');
  const manifest:CatalogBackupManifest=readCatalogBackupManifest({format:'aural-catalog-backup',version:1,backupId:input.request.operationId,createdAt:new Date().toISOString(),appVersion:input.appVersion,schema:metadata.schema,origin:metadata.origin,capture:'quiesced-v1',counts:metadata.counts,plugins:input.components,cache:'database-resident',externalMedia:'excluded',systemCredentials:'excluded',externalWriteback:'requires-original-source',files});
  return {stagePath,manifest};
 }catch(error){throw new CatalogSnapshotError(stagePath,error);}
}
