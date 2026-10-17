// Pure file primitives shared by trusted Main and the maintenance service.
import {createHash,timingSafeEqual} from 'node:crypto';
import {promises as fs,type BigIntStats} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {fileObservation} from './file-observation.js';
import type {BackupPackedResult} from '../shared/catalog-backup-worker.js';
import {inspectCatalogBackupDatabase} from '../library/catalog-backup-database.js';
import {backupUuid,backupPathRole,backupFileLimit,readBackupFile,readCatalogBackupManifest,readRendererPendingSnapshot,CATALOG_BACKUP_MAX_FILE,CATALOG_BACKUP_MAX_FILES,CATALOG_BACKUP_MAX_MANIFEST,CATALOG_BACKUP_MAX_PAYLOAD,type BackupFile,type CatalogBackupManifest} from '../shared/catalog-backup.js';

const magic=Buffer.from('AURALBK1'),endMagic=Buffer.from('AURALEND'),chunkSize=1024*1024;
const maxContainer=12+CATALOG_BACKUP_MAX_MANIFEST+CATALOG_BACKUP_MAX_PAYLOAD+40;
export type BackupFileOptions={signal?:AbortSignal;check?:()=>void;progress?:(value:{phase:'hashing'|'packing'|'verifying'|'staging';bytes:number;total:number})=>void};
export type BackupFileResult={manifest:CatalogBackupManifest;bytes:number;sha256:string};
const normalized=(s:string)=>process.platform==='win32'?path.resolve(s).toLowerCase():path.resolve(s);
function absolute(s:string):void{if(!path.isAbsolute(s)||s.length>32767||s.includes('\0'))throw new Error('备份文件位置无效');}
function identity(a:BigIntStats,b:BigIntStats):boolean{return a.dev===b.dev&&a.ino===b.ino&&a.birthtimeNs===b.birthtimeNs;}
function observation(a:BigIntStats,b:BigIntStats):boolean{return identity(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;}
function ordinary(s:BigIntStats,max:number):void{if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size<0n||s.size>BigInt(max))throw new Error('备份来源须为预算内的普通单链接文件');}
function context(options:BackupFileOptions){
 const deadline=Date.now()+45*60*1000;let last=0;
 return {check:()=>{options.check?.();options.signal?.throwIfAborted();if(Date.now()>deadline)throw new Error('备份文件处理超过45分钟预算');},report:(phase:'hashing'|'packing'|'verifying'|'staging',bytes:number,total:number)=>{if(Date.now()-last>=100||bytes===total){last=Date.now();options.progress?.({phase,bytes,total});}}};
}
// Reject links/junctions in every existing component. This is an observation, not
// an OS capability lock against another process replacing a parent directory.
async function directory(filename:string):Promise<BigIntStats>{
 absolute(filename);const resolved=path.resolve(filename),root=path.parse(resolved).root;let current=root;
 const parts=resolved.slice(root.length).split(path.sep).filter(Boolean);
 for(const part of parts){current=path.join(current,part);const stat=await fs.lstat(current,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('备份目录包含链接或不是普通目录');}
 if(normalized(await fs.realpath(resolved))!==normalized(resolved))throw new Error('备份目录实际位置不符');return fs.lstat(resolved,{bigint:true});
}
async function checkedFile(filename:string,max:number):Promise<{handle:FileHandle;before:BigIntStats}>{
 absolute(filename);await directory(path.dirname(filename));const before=await fs.lstat(filename,{bigint:true});ordinary(before,max);
 const handle=await fs.open(filename,'r');try{const current=await handle.stat({bigint:true});ordinary(current,max);if(!observation(before,current))throw new Error('备份来源在打开期间变化');return {handle,before};}catch(error){await handle.close();throw error;}
}
async function unchanged(filename:string,handle:FileHandle,before:BigIntStats):Promise<void>{
 const current=await handle.stat({bigint:true}),named=await fs.lstat(filename,{bigint:true});ordinary(current,maxContainer);ordinary(named,maxContainer);
 if(!observation(before,current)||!observation(current,named))throw new Error('备份文件在处理期间发生变化');await directory(path.dirname(filename));
}
async function readExact(handle:FileHandle,length:number,position:number):Promise<Buffer>{
 const bytes=Buffer.allocUnsafe(length);let at=0;while(at<length){const read=await handle.read(bytes,at,length-at,position+at);if(!read.bytesRead)throw new Error('备份文件截断或缺少完成记录');at+=read.bytesRead;}return bytes;
}
async function writeAll(handle:FileHandle,buffer:Buffer):Promise<void>{let at=0;while(at<buffer.length){const written=await handle.write(buffer,at,buffer.length-at,null);if(!written.bytesWritten)throw new Error('备份文件写入未前进');at+=written.bytesWritten;}}
function encode(manifest:CatalogBackupManifest):Buffer{const bytes=Buffer.from(JSON.stringify(readCatalogBackupManifest(manifest)),'utf8');if(bytes.length>CATALOG_BACKUP_MAX_MANIFEST)throw new Error('备份清单超过2MiB');return bytes;}
function decode(bytes:Buffer):CatalogBackupManifest{
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),manifest=readCatalogBackupManifest(JSON.parse(text));
 if(!encode(manifest).equals(bytes))throw new Error('备份清单不是规范JSON，可能有重复字段或未支持的数据');return manifest;
}
function contained(root:string,relative:string):string{
 backupPathRole(relative);const filename=path.resolve(root,...relative.split('/')),suffix=path.relative(root,filename);
 if(!suffix||suffix.startsWith('..'+path.sep)||suffix==='..'||path.isAbsolute(suffix))throw new Error('备份条目越过暂存目录');return filename;
}
const allowedDirectory=(relative:string)=>relative==='library'||relative==='state'||/^library\/(tag-write|tag-commit|tag-restore|tag-backup-cleanup|tag-backups)$/.test(relative)||/^library\/(tag-write|tag-commit|tag-restore|tag-backup-cleanup)\/[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(relative);
async function tree(root:string,check:()=>void,prefix=''):Promise<string[]>{
 const rootStat=await directory(root),files:string[]=[];let nodes=0;
 async function walk(folder:string,relative:string):Promise<void>{
  check();const before=await directory(folder),entries=await fs.readdir(folder,{withFileTypes:true});if((nodes+=entries.length)>CATALOG_BACKUP_MAX_FILES*3)throw new Error('备份暂存目录数量超过预算');
  for(const entry of entries){
   check();const next=relative?relative+'/'+entry.name:entry.name,filename=path.join(folder,entry.name),stat=await fs.lstat(filename,{bigint:true});
   if(stat.isSymbolicLink())throw new Error('备份暂存目录含有链接');
   if(stat.isDirectory()){if(!allowedDirectory(next))throw new Error('备份暂存目录有未知内容');await walk(filename,next);}
   else{const role=backupPathRole(next);ordinary(stat,backupFileLimit({path:next,role}));files.push(next);if(files.length>CATALOG_BACKUP_MAX_FILES)throw new Error('备份文件数量超过预算');}
  }
  const after=await directory(folder);if(!observation(before,after))throw new Error('备份暂存目录在列举期间变化');
 }
 await walk(root,prefix);if(!identity(rootStat,await directory(root)))throw new Error('备份暂存目录身份变化');return files.sort();
}
// Input is an owned, already quiesced snapshot tree, never the live userData tree.
async function inventoryTree(root:string,ctx:ReturnType<typeof context>):Promise<BackupFile[]>{
 return inventoryFiles(root,ctx,()=>tree(root,ctx.check));
}
async function inventoryFiles(root:string,ctx:ReturnType<typeof context>,list:()=>Promise<string[]>,resolveFile:(name:string)=>string=name=>contained(root,name)):Promise<BackupFile[]>{
 const names=await list(),result:BackupFile[]=[];let total=0,done=0;
 for(const name of names){const stat=await fs.lstat(resolveFile(name),{bigint:true});total+=Number(stat.size);if(total>CATALOG_BACKUP_MAX_PAYLOAD)throw new Error('备份总大小超过64GiB');}
 for(const name of names){
  ctx.check();const filename=resolveFile(name),role=backupPathRole(name),input=await checkedFile(filename,backupFileLimit({path:name,role})),hash=createHash('sha256');
  try{let at=0;while(at<Number(input.before.size)){ctx.check();const buffer=await readExact(input.handle,Math.min(chunkSize,Number(input.before.size)-at),at);hash.update(buffer);at+=buffer.length;done+=buffer.length;ctx.report('hashing',done,total);}await unchanged(filename,input.handle,input.before);result.push(readBackupFile({path:name,role,bytes:at,sha256:hash.digest('hex')}));}finally{await input.handle.close();}
 }
 if(JSON.stringify(await list())!==JSON.stringify(names))throw new Error('备份暂存文件清单发生变化');return result;
}
export async function inventoryCatalogBackupTree(root:string,options:BackupFileOptions={}):Promise<BackupFile[]>{return inventoryTree(root,context(options));}
// Inspect only the fixed library child, never enumerate the surrounding live
// userData as though it were an offline backup tree. WAL/SHM are not allowed.
export async function inventoryCatalogLibraryRoot(library:string,options:BackupFileOptions={}):Promise<BackupFile[]>{
 if(path.basename(library)!=='library')throw new Error('受控曲库根名称无效');return inventoryCatalogLibraryDirectory(library,options);
}
// Trusted restore slots may be named original-library or retired-candidate.
// Keep logical manifest paths under library/ while resolving only this pinned root.
export async function inventoryCatalogLibraryDirectory(library:string,options:BackupFileOptions={}):Promise<BackupFile[]>{
 const ctx=context(options),before=await directory(library),files=await inventoryFiles(library,ctx,()=>tree(library,ctx.check,'library'),name=>{
  backupPathRole(name);if(!name.startsWith('library/'))throw new Error('曲库核对路径未在固定逻辑根内');const filename=path.resolve(library,...name.slice(8).split('/')),relative=path.relative(library,filename);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('曲库核对路径越过原槽位');return filename;
 });
 if(!identity(before,await directory(library)))throw new Error('受控曲库在完整核对期间变化');return files;
}
async function createStageParents(root:string,relative:string):Promise<void>{
 let current=root;for(const part of relative.split('/').slice(0,-1)){
  await directory(current);current=path.join(current,part);
  try{await fs.mkdir(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  await directory(current);
 }
}
export async function prepareCatalogBackupStage(parent:string,id:string):Promise<string>{
 await directory(parent);const folder=await fs.mkdtemp(path.join(parent,'.aural-backup-'+backupUuid(id)+'-'));if(process.platform!=='win32')await fs.chmod(folder,0o700);await directory(folder);return folder;
}
export async function prepareCatalogBackupEntry(root:string,relative:string):Promise<string>{backupPathRole(relative);await directory(root);await createStageParents(root,relative);return contained(root,relative);}
export async function writeCatalogBackupState(root:string,relative:string,buffer:Buffer,options:BackupFileOptions={}):Promise<void>{
 const role=backupPathRole(relative);if(role!=='renderer-pending'&&role!=='history-pending'||buffer.length>backupFileLimit({path:relative,role}))throw new Error('备份状态文件类型或大小无效');
 const ctx=context(options);ctx.check();const filename=await prepareCatalogBackupEntry(root,relative),handle=await fs.open(filename,'wx',0o600);
 try{const before=await handle.stat({bigint:true});await writeAll(handle,buffer);await handle.sync();ctx.check();const after=await handle.stat({bigint:true}),named=await fs.lstat(filename,{bigint:true});ordinary(after,backupFileLimit({path:relative,role}));ordinary(named,backupFileLimit({path:relative,role}));if(!identity(before,after)||!observation(after,named)||after.size!==BigInt(buffer.length))throw new Error('备份状态文件身份不符');}finally{await handle.close();}
}
export async function copyCatalogBackupEntry(source:string,root:string,relative:string,options:BackupFileOptions={}):Promise<void>{
 const ctx=context(options),role=backupPathRole(relative),limit=backupFileLimit({path:relative,role});ctx.check();const input=await checkedFile(source,limit);
 try{
  const target=await prepareCatalogBackupEntry(root,relative),output=await fs.open(target,'wx',0o600);
  try{const created=await output.stat({bigint:true});let at=0;while(at<Number(input.before.size)){ctx.check();const buffer=await readExact(input.handle,Math.min(chunkSize,Number(input.before.size)-at),at);await writeAll(output,buffer);at+=buffer.length;}await unchanged(source,input.handle,input.before);await output.sync();const after=await output.stat({bigint:true}),named=await fs.lstat(target,{bigint:true});ordinary(after,limit);ordinary(named,limit);if(!identity(created,after)||!observation(after,named)||after.size!==input.before.size)throw new Error('备份复制工件身份不符');ctx.check();}finally{await output.close();}
 }finally{await input.handle.close();}
}
// Clone only a verified offline tree into an already reserved empty private
// root. Active library.db/WAL and arbitrary paths are not accepted by callers.
export async function cloneCatalogBackupTree(source:string,target:string,value:unknown,options:BackupFileOptions={}):Promise<void>{
 const manifest=readCatalogBackupManifest(value),ctx=context(options);ctx.check();const sourceIdentity=await directory(source),targetIdentity=await directory(target);
 if(normalized(source)===normalized(target)||JSON.stringify(await tree(target,ctx.check))!=='[]'||(await fs.readdir(target)).length)throw new Error('候选复制目标须为不同的空私有目录');
 const total=manifest.files.reduce((sum,file)=>sum+file.bytes,0),free=await fs.statfs(target,{bigint:true});if(free.bavail*free.bsize<BigInt(total)+64n*1024n*1024n)throw new Error('候选曲库复制空间不足');
 if(JSON.stringify(await inventoryTree(source,ctx))!==JSON.stringify(manifest.files))throw new Error('原恢复暂存内容与完整清单不符');let done=0;
 for(const file of manifest.files){ctx.check();if(!identity(sourceIdentity,await directory(source))||!identity(targetIdentity,await directory(target)))throw new Error('候选复制根身份已变化');await copyCatalogBackupEntry(contained(source,file.path),target,file.path,{signal:options.signal,check:ctx.check});done+=file.bytes;ctx.report('staging',done,total);}
 if(JSON.stringify(await inventoryTree(source,ctx))!==JSON.stringify(manifest.files)||JSON.stringify(await inventoryTree(target,ctx))!==JSON.stringify(manifest.files)||!identity(sourceIdentity,await directory(source))||!identity(targetIdentity,await directory(target)))throw new Error('候选复制后的来源或目标完整摘要不同');
}
export async function readCatalogBackupPendingSnapshot(root:string,value:unknown,options:BackupFileOptions={}):Promise<ReturnType<typeof readRendererPendingSnapshot>>{
 const manifest=readCatalogBackupManifest(value),entry=manifest.files.find(file=>file.role==='renderer-pending');if(!entry)throw new Error('快照缺少界面待核对资料');const ctx=context(options);ctx.check();const filename=contained(root,entry.path),input=await checkedFile(filename,backupFileLimit(entry));
 try{if(input.before.size!==BigInt(entry.bytes))throw new Error('快照待核对资料大小不同');const bytes=await readExact(input.handle,entry.bytes,0);ctx.check();if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error('快照待核对资料摘要不同');const result=readRendererPendingSnapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));await unchanged(filename,input.handle,input.before);ctx.check();return result;}finally{await input.handle.close();}
}
// No publish/overwrite behavior here. The maintenance owner publishes only after
// this complete artifact has been independently verified and its worker has exited.
export async function packCatalogBackup(root:string,filename:string,value:unknown,options:BackupFileOptions={}):Promise<BackupPackedResult>{
 absolute(filename);const ctx=context(options),manifest=readCatalogBackupManifest(value),manifestBytes=encode(manifest),names=await tree(root,ctx.check);
 if(JSON.stringify(names)!==JSON.stringify(manifest.files.map(f=>f.path)))throw new Error('备份清单不完整或暂存区有额外文件');
 ctx.check();inspectCatalogBackupDatabase(contained(root,'library/library.db'),manifest);ctx.check();
 if(normalized(filename)===normalized(root)||!path.relative(root,filename).startsWith('..'+path.sep)&&!path.isAbsolute(path.relative(root,filename)))throw new Error('备份输出不能位于来源暂存区');
 await directory(path.dirname(filename));const out=await fs.open(filename,'wx',0o600),created=await out.stat({bigint:true}),hash=createHash('sha256');let done=0;
 const header=Buffer.alloc(12);magic.copy(header);header.writeUInt32BE(manifestBytes.length,8);
 const total=12+manifestBytes.length+manifest.files.reduce((n,f)=>n+f.bytes,0)+40;
 try{
  for(const buffer of [header,manifestBytes]){ctx.check();await writeAll(out,buffer);hash.update(buffer);done+=buffer.length;}
  for(const file of manifest.files){
   ctx.check();const source=contained(root,file.path),input=await checkedFile(source,backupFileLimit(file)),fileHash=createHash('sha256');
   try{
    if(input.before.size!==BigInt(file.bytes))throw new Error('备份条目大小与清单不符');let at=0;const textParts:Buffer[]=[];
    while(at<file.bytes){ctx.check();const buffer=await readExact(input.handle,Math.min(chunkSize,file.bytes-at),at);await writeAll(out,buffer);hash.update(buffer);fileHash.update(buffer);if(file.role==='renderer-pending')textParts.push(buffer);at+=buffer.length;done+=buffer.length;ctx.report('packing',done,total);}
    if(file.role==='renderer-pending')readRendererPendingSnapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(textParts))));
    if(fileHash.digest('hex')!==file.sha256)throw new Error('备份条目摘要与清单不符');await unchanged(source,input.handle,input.before);
   }finally{await input.handle.close();}
  }
  if(JSON.stringify(await tree(root,ctx.check))!==JSON.stringify(names))throw new Error('备份来源文件清单发生变化');
  ctx.check();const digest=hash.digest();await writeAll(out,Buffer.concat([endMagic,digest]));done+=40;await out.sync();
  const final=await out.stat({bigint:true}),named=await fs.lstat(filename,{bigint:true});ordinary(final,maxContainer);ordinary(named,maxContainer);
  if(!identity(created,final)||!observation(final,named)||final.size!==BigInt(total))throw new Error('备份输出身份或大小不符');await directory(path.dirname(filename));ctx.report('packing',done,total);
  return {manifest,bytes:done,sha256:digest.toString('hex'),identity:`${final.dev}:${final.ino}:${final.birthtimeNs}`,observation:fileObservation(final)};
 }finally{await out.close();} // A failed owned artifact is retained for the coordinator's identity-aware cleanup.
}
async function scanContainer(input:FileHandle,before:BigIntStats,ctx:ReturnType<typeof context>,stage?:{root:string;identity:BigIntStats}):Promise<BackupFileResult>{
 ctx.check();const header=await readExact(input,12,0);if(!header.subarray(0,8).equals(magic))throw new Error('不是Aural曲库备份文件');
 const size=header.readUInt32BE(8);if(!size||size>CATALOG_BACKUP_MAX_MANIFEST)throw new Error('备份清单大小无效');
 const manifestBytes=await readExact(input,size,12),manifest=decode(manifestBytes),expected=12+size+manifest.files.reduce((n,f)=>n+f.bytes,0)+40;
 if(before.size!==BigInt(expected)||expected>maxContainer)throw new Error('备份总长度不符，可能截断或有额外数据');
 const hash=createHash('sha256').update(header).update(manifestBytes);let position=12+size;
 for(const file of manifest.files){
  ctx.check();let output:FileHandle|undefined,outputPath='',created:BigIntStats|undefined;const fileHash=createHash('sha256');
  try{
   if(stage){
    if(!identity(stage.identity,await directory(stage.root)))throw new Error('恢复暂存目录身份变化');outputPath=contained(stage.root,file.path);
    await createStageParents(stage.root,file.path);output=await fs.open(outputPath,'wx',0o600);created=await output.stat({bigint:true});
   }
   let at=0;const textParts:Buffer[]=[];
   while(at<file.bytes){ctx.check();const buffer=await readExact(input,Math.min(chunkSize,file.bytes-at),position);hash.update(buffer);fileHash.update(buffer);if(output)await writeAll(output,buffer);if(file.role==='renderer-pending')textParts.push(buffer);position+=buffer.length;at+=buffer.length;ctx.report(stage?'staging':'verifying',position,expected);}
   if(fileHash.digest('hex')!==file.sha256)throw new Error('备份文件内容摘要不符：'+file.path);
   if(file.role==='renderer-pending')readRendererPendingSnapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(textParts))));
   if(output){await output.sync();const stat=await output.stat({bigint:true}),named=await fs.lstat(outputPath,{bigint:true});ordinary(stat,backupFileLimit(file));ordinary(named,backupFileLimit(file));if(!identity(created!,stat)||!observation(stat,named)||stat.size!==BigInt(file.bytes))throw new Error('恢复暂存文件身份不符');}
  }finally{if(output)await output.close();}
 }
 ctx.check();const footer=await readExact(input,40,position),digest=hash.digest();if(!footer.subarray(0,8).equals(endMagic)||!timingSafeEqual(digest,footer.subarray(8)))throw new Error('备份缺少有效完成摘要');
 position+=40;if(position!==expected)throw new Error('备份完成位置不符');ctx.report(stage?'staging':'verifying',position,expected);
 return {manifest,bytes:position,sha256:digest.toString('hex')};
}
// Byte/container validation is not SQLite integrity validation or permission to restore.
export async function verifyCatalogBackupFile(filename:string,options:BackupFileOptions={}):Promise<BackupFileResult>{
 const ctx=context(options),input=await checkedFile(filename,maxContainer);
 try{const result=await scanContainer(input.handle,input.before,ctx);await unchanged(filename,input.handle,input.before);return result;}finally{await input.handle.close();}
}
export class CatalogBackupStageError extends Error{
 constructor(readonly stagePath:string,cause:unknown){super('备份恢复暂存未完成，保留暂存资料供核对',{cause});this.name='CatalogBackupStageError';}
}
// Always creates a fresh private child; there is no API that extracts into live data.
export async function stageCatalogBackupFile(filename:string,parent:string,options:BackupFileOptions&{inspectDatabase?:(filename:string,manifest:CatalogBackupManifest)=>void}={}):Promise<BackupFileResult&{stagePath:string}>{
 const ctx=context(options);await directory(parent);const input=await checkedFile(filename,maxContainer);let stagePath='';
 try{
  const verified=await scanContainer(input.handle,input.before,ctx);await unchanged(filename,input.handle,input.before);ctx.check();
  stagePath=await fs.mkdtemp(path.join(parent,'.aural-restore-'+verified.manifest.backupId+'-'));if(process.platform!=='win32')await fs.chmod(stagePath,0o700);
  const stage={root:stagePath,identity:await directory(stagePath)},result=await scanContainer(input.handle,input.before,ctx,stage);await unchanged(filename,input.handle,input.before);
  if(result.sha256!==verified.sha256||!identity(stage.identity,await directory(stagePath))||JSON.stringify(await tree(stagePath,ctx.check))!==JSON.stringify(result.manifest.files.map(f=>f.path)))throw new Error('恢复暂存与已校验备份不符');
  ctx.check();if(options.inspectDatabase)options.inspectDatabase(contained(stagePath,'library/library.db'),result.manifest);else inspectCatalogBackupDatabase(contained(stagePath,'library/library.db'),result.manifest);ctx.check();
  const staged=await inventoryTree(stagePath,ctx);ctx.check();
  if(JSON.stringify(staged)!==JSON.stringify(result.manifest.files)||!identity(stage.identity,await directory(stagePath)))throw new Error('数据库核对后的恢复暂存与清单不符');return {...result,stagePath};
 }catch(error){if(stagePath)throw new CatalogBackupStageError(stagePath,error);throw error;}finally{await input.handle.close();}
}
