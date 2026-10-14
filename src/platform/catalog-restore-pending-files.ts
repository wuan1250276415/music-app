import {promises as fs,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileObservation} from './file-observation.js';
import {readRestorePendingIntent,type RestorePendingIntent,type RestorePendingFile} from '../shared/catalog-restore-pending.js';
import {readRendererPendingSnapshot,type RendererPendingSnapshot} from '../shared/catalog-backup.js';

const identity=(s:BigIntStats)=>`${s.dev}:${s.ino}:${s.birthtimeNs}`;
const sha256=(raw:Uint8Array)=>createHash('sha256').update(raw).digest('hex');
export async function pendingDirectory(folder:string):Promise<string>{
 if(!path.isAbsolute(folder)||path.resolve(folder)!==folder||folder.length>32767)throw new Error('恢复资料目录无效');let current=path.parse(folder).root;
 for(const part of folder.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const s=await fs.lstat(current,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())throw new Error('恢复资料目录含链接或非目录');}
 const before=await fs.lstat(folder,{bigint:true});if((await fs.realpath(folder)).toLowerCase()!==folder.toLowerCase()||identity(await fs.lstat(folder,{bigint:true}))!==identity(before))throw new Error('恢复资料目录身份变化');return identity(before);
}
export async function checkedPendingFile(filename:string,entry:Pick<RestorePendingFile,'bytes'|'sha256'>,check:()=>void):Promise<void>{
 check();const parent=await pendingDirectory(path.dirname(filename)),before=await fs.lstat(filename,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size!==BigInt(entry.bytes))throw new Error('恢复资料文件类型或大小不同');
 const input=await fs.open(filename,'r');try{
  if(fileObservation(await input.stat({bigint:true}))!==fileObservation(before))throw new Error('恢复资料打开期间变化');const digest=createHash('sha256');let at=0;
  while(at<entry.bytes){check();const buffer=Buffer.alloc(Math.min(1024*1024,entry.bytes-at)),r=await input.read(buffer,0,buffer.length,at);if(!r.bytesRead)throw new Error('恢复资料文件截断');digest.update(buffer.subarray(0,r.bytesRead));at+=r.bytesRead;}
  if(digest.digest('hex')!==entry.sha256||fileObservation(await input.stat({bigint:true}))!==fileObservation(before)||fileObservation(await fs.lstat(filename,{bigint:true}))!==fileObservation(before)||await pendingDirectory(path.dirname(filename))!==parent)throw new Error('恢复资料摘要或原身份变化');check();
 }finally{await input.close();}
}
export async function copyPendingFile(source:string,target:string,entry:RestorePendingFile,check:()=>void):Promise<void>{
 await checkedPendingFile(source,entry,check);const sourceParent=await pendingDirectory(path.dirname(source)),targetParent=await pendingDirectory(path.dirname(target)),before=await fs.lstat(source,{bigint:true});
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size!==BigInt(entry.bytes))throw new Error('恢复资料复制来源身份或类型变化');const input=await fs.open(source,'r');try{
  if(fileObservation(await input.stat({bigint:true}))!==fileObservation(before))throw new Error('恢复资料复制前身份变化');const output=await fs.open(target,'wx',0o600);
  try{let at=0;while(at<entry.bytes){check();const buffer=Buffer.alloc(Math.min(1024*1024,entry.bytes-at)),r=await input.read(buffer,0,buffer.length,at);if(!r.bytesRead)throw new Error('恢复资料复制来源截断');await output.writeFile(buffer.subarray(0,r.bytesRead));at+=r.bytesRead;}await output.sync();
   if(fileObservation(await output.stat({bigint:true}))!==fileObservation(await fs.lstat(target,{bigint:true})))throw new Error('恢复资料副本写入未确认');
  }finally{await output.close();}
  if(fileObservation(await input.stat({bigint:true}))!==fileObservation(before)||fileObservation(await fs.lstat(source,{bigint:true}))!==fileObservation(before)||await pendingDirectory(path.dirname(source))!==sourceParent||await pendingDirectory(path.dirname(target))!==targetParent)throw new Error('恢复资料复制过程中身份变化');
 }finally{await input.close();}await checkedPendingFile(target,entry,check);
}
async function readPinnedPendingFile(filename:string,entry:RestorePendingFile,check:()=>void):Promise<Buffer>{
 check();const parent=await pendingDirectory(path.dirname(filename)),before=await fs.lstat(filename,{bigint:true});
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size!==BigInt(entry.bytes))throw new Error('恢复资料读取大小或身份不同');
 const input=await fs.open(filename,'r');try{
  if(fileObservation(await input.stat({bigint:true}))!==fileObservation(before))throw new Error('恢复资料读取句柄不同');
  const raw=Buffer.alloc(entry.bytes);let at=0;while(at<raw.length){check();const result=await input.read(raw,at,Math.min(1024*1024,raw.length-at),at);if(!result.bytesRead)throw new Error('恢复资料读取截断');at+=result.bytesRead;}
  if(sha256(raw)!==entry.sha256||fileObservation(await input.stat({bigint:true}))!==fileObservation(before)||fileObservation(await fs.lstat(filename,{bigint:true}))!==fileObservation(before)||await pendingDirectory(path.dirname(filename))!==parent)throw new Error('恢复资料读取期间变化');check();return raw;
 }finally{await input.close();}
}
async function originalPendingSnapshot(folder:string,intent:RestorePendingIntent,check:()=>void):Promise<RendererPendingSnapshot>{
 const file=intent.files.find(f=>f.name==='original-renderer.json')!,raw=await readPinnedPendingFile(path.join(folder,file.name),file,check);
 const snapshot=readRendererPendingSnapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));
 if(sha256(Buffer.from(JSON.stringify(snapshot)))!==file.sha256||sha256(Buffer.from(JSON.stringify(snapshot.values)))!==intent.originalValuesSha256)throw new Error('原界面快照与隔离登记不同');return snapshot;
}
export async function verifyPendingArchive(folder:string,value:unknown,check:()=>void):Promise<void>{
 const intent=readRestorePendingIntent(value);check();if(await pendingDirectory(folder)!==intent.directoryIdentity)throw new Error('恢复资料隔离目录身份不同');
 const names=(await fs.readdir(folder)).sort();if(JSON.stringify(names)!==JSON.stringify(intent.files.map(f=>f.name)))throw new Error('恢复资料隔离文件缺失或有未知内容');
 for(const file of intent.files)await checkedPendingFile(path.join(folder,file.name),file,check);
 await originalPendingSnapshot(folder,intent,check);
 if(await pendingDirectory(folder)!==intent.directoryIdentity||JSON.stringify((await fs.readdir(folder)).sort())!==JSON.stringify(names))throw new Error('恢复资料隔离目录读取期间变化');check();
}
export async function readOriginalPending(folder:string,intent:RestorePendingIntent,check:()=>void):Promise<RendererPendingSnapshot>{
 await verifyPendingArchive(folder,intent,check);const snapshot=await originalPendingSnapshot(folder,intent,check);if(await pendingDirectory(folder)!==intent.directoryIdentity)throw new Error('原界面快照读取后目录身份变化');check();return snapshot;
}
