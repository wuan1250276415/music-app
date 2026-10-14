import path from 'node:path';
import {promises as fs} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {readNormalLibraryPermission,type NormalLibraryPermission} from '../shared/catalog-normal-open.js';
import {restoreTransactionDirectory} from '../main/catalog-restore-transaction-store.js';
import {fileObservation} from '../platform/file-observation.js';
import {RELEASE} from '../shared/release.js';

// Before ordinary constructors/migrations/tasks, verify that a completed
// namespace still contains an existing database with the certified origin.
export async function verifyCompletedNormalOpen(folder:string,value:unknown):Promise<NormalLibraryPermission>{
 const permission=readNormalLibraryPermission(value);if(path.basename(folder)!=='library'||path.resolve(folder)!==folder||await restoreTransactionDirectory(folder)!==permission.libraryIdentity)throw new Error('已完成恢复的当前曲库目录不同');
 const filename=path.join(folder,'library.db'),before=await fs.lstat(filename,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<100n||before.size>64n*1024n**3n)throw new Error('已完成恢复缺少现有普通数据库，禁止创建空库');
 const held=await fs.open(filename,'r');let inspection:DatabaseSync|null=null;
 try{
  if(fileObservation(await held.stat({bigint:true}))!==fileObservation(before))throw new Error('已完成曲库数据库打开期间变化');inspection=new DatabaseSync(filename,{readOnly:true,allowExtension:false});inspection.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000;');
  const schema=(inspection.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,origin=inspection.prepare('SELECT id FROM rule_transfer_origin WHERE slot=1').get() as {id:string}|undefined;
  if(!Number.isInteger(schema)||schema<1||schema>RELEASE.librarySchema.max||origin?.id!==permission.origin||(inspection.prepare('PRAGMA integrity_check(1)').get() as {integrity_check:string}).integrity_check!=='ok'||inspection.prepare('PRAGMA foreign_key_check').get())throw new Error('已完成恢复的现有数据库来源、版本或完整性不同');
  const after=await fs.lstat(filename,{bigint:true});if(!after.isFile()||after.isSymbolicLink()||after.nlink!==1n||fileObservation(after)!==fileObservation(before)||fileObservation(await held.stat({bigint:true}))!==fileObservation(before)||await restoreTransactionDirectory(folder)!==permission.libraryIdentity)throw new Error('已完成曲库读取期间文件或目录变化');return permission;
 }finally{try{inspection?.close();}finally{await held.close();}}
}
