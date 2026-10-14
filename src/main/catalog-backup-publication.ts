import {promises as fs,constants,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileObservation} from '../platform/file-observation.js';
import type {BackupPackedResult} from '../shared/catalog-backup-worker.js';
import type {CatalogBackupResult} from '../shared/catalog-backup-ui.js';
import type {BackupDestination} from './catalog-backup-ledger.js';
const identity=(s:BigIntStats)=>`${s.dev}:${s.ino}:${s.birthtimeNs}`;
const normalized=(s:string)=>process.platform==='win32'?s.toLowerCase():s;
async function directory(filename:string):Promise<string>{
 const resolved=path.resolve(filename),root=path.parse(resolved).root;let current=root;
 for(const part of resolved.slice(root.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('保存位置包含链接或不是普通目录');}
 if(normalized(await fs.realpath(resolved))!==normalized(resolved))throw new Error('保存目录实际位置不符');return identity(await fs.lstat(resolved,{bigint:true}));
}
// Output path is chosen by a trusted native dialog. It is never supplied by Renderer.
export class CatalogBackupPublication {
 private target='';private parentIdentity='';private prior:string|null=null;private proof:BackupPackedResult|null=null;private published:BackupPackedResult|null=null;
 temporary='';name='';
 descriptor():BackupDestination{if(!this.target||!this.temporary)throw new Error('备份保存位置尚未准备');return {target:this.target,temporary:this.temporary,parentIdentity:this.parentIdentity,prior:this.prior};}
 async publishedProof():Promise<BackupPackedResult>{
  if(!this.published||await directory(path.dirname(this.target))!==this.parentIdentity)throw new Error('备份保存目录身份变化');
  const stat=await fs.lstat(this.target,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size!==BigInt(this.published.bytes)||identity(stat)!==this.published.identity||fileObservation(stat)!==this.published.observation)throw new Error('发布后的备份与保存时证明不符');
  return this.published;
 }
 async prepare(filename:string):Promise<void>{
  if(this.target||!path.isAbsolute(filename)||filename.length>32767||path.extname(filename).toLowerCase()!=='.auralbackup')throw new Error('请选择 .auralbackup 曲库备份文件');
  const parent=path.dirname(filename);this.parentIdentity=await directory(parent);this.target=path.resolve(filename);this.name=path.basename(filename).slice(0,128);
  const stat=await fs.lstat(this.target,{bigint:true}).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;});
  if(stat&&(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n))throw new Error('不能覆盖链接、共享链接或非普通文件');this.prior=stat?fileObservation(stat):null;
  this.temporary=path.join(parent,`.aural-backup-${randomUUID()}.tmp`);
 }
 async adopt(proof:BackupPackedResult):Promise<void>{
  if(!this.temporary||this.proof)throw new Error('备份输出工件状态不符');const stat=await fs.lstat(this.temporary,{bigint:true});
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size!==BigInt(proof.bytes)||identity(stat)!==proof.identity||fileObservation(stat)!==proof.observation)throw new Error('备份文件与进程证明不符');this.proof=proof;
 }
 async budget(bytes:number):Promise<void>{
  if(!this.target||!Number.isSafeInteger(bytes)||bytes<52)throw new Error('备份输出预算无效');
  const free=await fs.statfs(path.dirname(this.target),{bigint:true});if(free.bavail*free.bsize<BigInt(bytes)+64n*1024n*1024n)throw new Error('备份保存位置可用空间不足');
 }
 async publish(check:()=>void,verifyCopy:(filename:string)=>Promise<BackupPackedResult>):Promise<CatalogBackupResult['publication']>{
  if(!this.proof)throw new Error('备份完整工件尚未核对');check();if(await directory(path.dirname(this.target))!==this.parentIdentity)throw new Error('备份保存目录身份已变化');
  const file=await fs.open(this.temporary,'r');try{
   const stat=await file.stat({bigint:true}),named=await fs.lstat(this.temporary,{bigint:true});
   if(!stat.isFile()||stat.nlink!==1n||named.isSymbolicLink()||identity(stat)!==this.proof.identity||fileObservation(stat)!==this.proof.observation||fileObservation(named)!==this.proof.observation)throw new Error('备份工件在发布前变化');
   const current=await fs.lstat(this.target,{bigint:true}).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;});
   if(this.prior?current===null||fileObservation(current)!==this.prior:current!==null)throw new Error('保存位置已变化，请重新选择');check();
   const confirmMoved=async()=>{const actual=await file.stat({bigint:true}),named=await fs.lstat(this.target,{bigint:true});if(named.isSymbolicLink()||named.nlink!==1n||identity(actual)!==this.proof!.identity||actual.size!==BigInt(this.proof!.bytes)||fileObservation(actual)!==fileObservation(named))throw new Error('移动发布后的文件身份未确认');this.published={...this.proof!,identity:identity(actual),observation:fileObservation(actual)};};
   if(this.prior){await fs.rename(this.temporary,this.target);await confirmMoved();return 'rename-existing';}
   let linked=false;try{await fs.link(this.temporary,this.target);linked=true;}
   catch(error){if(!['ENOTSUP','EOPNOTSUPP','EPERM','EXDEV','ENOSYS'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
   if(linked){await fs.unlink(this.temporary);await confirmMoved();return 'atomic-new';}
   try{
    await this.budget(this.proof.bytes);check();
    await fs.copyFile(this.temporary,this.target,constants.COPYFILE_EXCL);
    const copied=await fs.open(this.target,'r+');try{await copied.sync();const after=await copied.stat({bigint:true});if(after.size!==BigInt(this.proof.bytes))throw new Error('备份复制发布长度不符');}finally{await copied.close();}
    const verified=await verifyCopy(this.target),after=await fs.lstat(this.target,{bigint:true});
    if(await directory(path.dirname(this.target))!==this.parentIdentity||identity(after)!==verified.identity||fileObservation(after)!==verified.observation)throw new Error('复制复核后的备份文件或保存目录已变化');
    this.published=verified;
   }catch(error){throw new Error('复制发布未确认完成，保存位置可能留有未完成文件；完整临时工件已保留',{cause:error});}
   // Copy publication is not atomic. A failed sync/copy leaves an unconfirmed target.
   // Retain the original complete temporary for explicit recovery, never delete target.
   return 'exclusive-copy';
  }finally{await file.close();}
 }
}
