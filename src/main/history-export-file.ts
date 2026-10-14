import {promises as fs,constants} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileObservation} from '../platform/file-observation.js';
import {HISTORY_EXPORT_MAX_BYTES,type HistoryExportFormat,type HistoryExportResult} from '../shared/history-export.js';

export class HistoryExportFile {
 private file:FileHandle|null=null;private owned=false;private target='';private temporary='';private prior:string|null=null;
 private temporaryIdentity:string|null=null;
 private identity(stat:BigIntStats):string{return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;}
 bytes=0;name='';
 async open(filename:string,format:HistoryExportFormat):Promise<void>{
  if(this.file||this.owned)throw new Error('历史导出文件已打开');
  if(!path.isAbsolute(filename)||filename.length>32767)throw new Error('历史导出保存路径无效');
  if(path.extname(filename).toLowerCase()!=='.'+format)throw new Error(`请选择 .${format} 导出文件`);
  const directory=await fs.realpath(path.dirname(filename));this.target=path.join(directory,path.basename(filename));this.name=path.basename(filename).slice(0,128);
  const existing=await fs.lstat(this.target,{bigint:true}).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;});
  if(existing&&(!existing.isFile()||existing.isSymbolicLink()))throw new Error('不能覆盖链接或非普通文件');
  this.prior=existing?fileObservation(existing):null;this.temporary=path.join(directory,`.aural-history-${randomUUID()}.tmp`);
  this.file=await fs.open(this.temporary,'wx',0o600);this.owned=true;this.temporaryIdentity=this.identity(await this.file.stat({bigint:true}));
 }
 async write(bytes:Buffer):Promise<void>{
  if(!this.file)throw new Error('历史导出文件未打开');if(this.bytes+bytes.length>HISTORY_EXPORT_MAX_BYTES)throw new Error('导出超过512MiB，请缩小检索范围后导出');
  await this.file.writeFile(bytes);this.bytes+=bytes.length;
 }
 async publish(authorize:()=>void):Promise<HistoryExportResult['publication']>{
  if(!this.file)throw new Error('历史导出文件未打开');await this.file.sync();const finished=await this.file.stat({bigint:true});await this.file.close();this.file=null;authorize();
  const staged=await fs.lstat(this.temporary,{bigint:true});
  if(!staged.isFile()||staged.isSymbolicLink()||this.identity(staged)!==this.temporaryIdentity||fileObservation(staged)!==fileObservation(finished)||staged.size!==BigInt(this.bytes))throw new Error('历史导出临时文件已变化');
  const current=await fs.lstat(this.target,{bigint:true}).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;});
  if(this.prior?current===null||fileObservation(current)!==this.prior:current!==null)throw new Error('保存位置已变化，请重新选择文件');
  if(this.prior){await fs.rename(this.temporary,this.target);this.owned=false;return 'rename-existing';}
  let publication:HistoryExportResult['publication']='atomic-new';
  try{await fs.link(this.temporary,this.target);}catch(e){
   if(!['ENOTSUP','EOPNOTSUPP','EPERM','EXDEV','ENOSYS'].includes((e as NodeJS.ErrnoException).code??''))throw e;
   await fs.copyFile(this.temporary,this.target,constants.COPYFILE_EXCL);publication='exclusive-copy';
   const copied=await fs.open(this.target,'r+');try{await copied.sync();}finally{await copied.close();}
  }
  // Publication succeeded; a cleanup failure cannot turn a completed file into a failed export.
  try{await this.discard();}catch{/* Publication is already complete. */}
  return publication;
 }
 async discard():Promise<void>{
  if(this.file){await this.file.close().catch(()=>{});this.file=null;}
  if(this.owned){
   const current=await fs.lstat(this.temporary,{bigint:true}).catch(()=>null);
   if(current?.isFile()&&!current.isSymbolicLink()&&this.temporaryIdentity!==null&&this.identity(current)===this.temporaryIdentity)await fs.unlink(this.temporary).catch(()=>{});
   this.owned=false;
  }
 }
}
