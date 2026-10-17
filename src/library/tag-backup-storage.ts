import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {LibraryDatabase} from './database.js';
import {readTagBackupStorageRequest,type TagBackupEntry,type TagBackupStoragePage,type TagBackupStorageRequest} from '../shared/tag-backup-storage.js';

const LIMIT=65536,PAGE=20,TTL=15*60*1000;
const normalized=(name:string)=>process.platform==='win32'?path.resolve(name).toLowerCase():path.resolve(name);
type Snapshot=Omit<TagBackupStoragePage,'items'|'nextOffset'|'filter'>&{items:TagBackupEntry[]};

// This is a bounded, read-only observation. File identity and hashes must be
// independently rechecked by the eventual cleaner before any removal.
export class TagBackupStorage {
 private snapshot:Snapshot|null=null;
 private flight:Promise<Snapshot>|null=null;
 private controller:AbortController|null=null;
 private maintenanceOwner:string|null=null;
 private closed=false;
 private readonly root:string;
 constructor(private readonly db:LibraryDatabase,private readonly dataDir:string){
  if(!path.isAbsolute(dataDir))throw new Error('备份空间目录必须为绝对路径');
  this.root=path.join(dataDir,'tag-backups');
 }
 async beginMaintenance(owner:string):Promise<void>{
  if(!owner||this.maintenanceOwner&&this.maintenanceOwner!==owner)throw new Error('备份空间维护身份不符');
  this.maintenanceOwner=owner;this.controller?.abort(new Error('曲库正在维护，请稍后重新核对空间'));
  await this.flight?.catch(()=>{});this.snapshot=null;
 }
 endMaintenance(owner:string):void{if(this.maintenanceOwner!==owner||this.flight)throw new Error('备份空间维护尚未结束');this.maintenanceOwner=null;}
 async close():Promise<void>{this.closed=true;this.controller?.abort(new Error('备份空间核对已停止'));await this.flight?.catch(()=>{});this.snapshot=null;}
 async page(value?:TagBackupStorageRequest):Promise<TagBackupStoragePage>{
  if(this.closed||this.maintenanceOwner)throw new Error('曲库正在维护，请稍后核对备份空间');
  const q=readTagBackupStorageRequest(value);let snapshot:Snapshot;
  if(q.snapshotId){
   if(!this.snapshot||this.snapshot.snapshotId!==q.snapshotId||Date.now()-this.snapshot.observedAt>TTL)throw new Error('空间清单已过期，请重新核对');
   snapshot=this.snapshot;
  }else{
   if(!this.flight){
    const controller=new AbortController();this.controller=controller;
    this.flight=this.inspect(controller.signal).then(result=>{if(!controller.signal.aborted)this.snapshot=result;return result;}).finally(()=>{this.controller=null;this.flight=null;});
   }
   snapshot=await this.flight;
  }
  const items=snapshot.items.filter(item=>q.filter==='all'||q.filter==='candidates'&&item.disposition==='candidate'||q.filter==='protected'&&item.disposition==='protected'||q.filter==='unmanaged'&&['unmanaged','unreadable'].includes(item.disposition));
  const {items:_all,...summary}=snapshot;
  return {...summary,items:items.slice(q.offset,q.offset+PAGE),nextOffset:q.offset+PAGE<items.length?q.offset+PAGE:null,filter:q.filter};
 }
 private async inspect(signal:AbortSignal):Promise<Snapshot>{
  const deadline=performance.now()+50000,observedAt=Date.now(),policy=this.db.tagBackupPolicies.load(),owned=await this.db.tagBackupCatalog.ownership(this.root,signal,deadline),items:TagBackupEntry[]=[];
  const summary:TagBackupStoragePage['summary']={entries:0,knownBackups:0,candidates:0,protected:0,unmanaged:0,unreadable:0,knownBytes:'0',candidateBytes:'0',otherFileBytes:'0',overBudgetBytes:'0',availableBytes:null};
  let complete=true,message='文件大小为当前观察值；清理前仍需重新核对文件。',knownBytes=0n,candidateBytes=0n,otherBytes=0n;
  try{const s=await fs.statfs(this.dataDir,{bigint:true});if(s.bavail>=0n&&s.bsize>0n)summary.availableBytes=String(s.bavail*s.bsize);}catch{/* Unavailable is different from zero free space. */}
  signal.throwIfAborted();
  let before:Awaited<ReturnType<typeof this.rootIdentity>>;
  try{before=await this.rootIdentity();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return {snapshotId:randomUUID(),observedAt,policy,complete:owned.size===0,message:owned.size?'备份目录不存在，已有任务的备份位置须到恢复页面核对。':'当前还没有标签备份文件。',summary,items,cleanupReady:false};}
  const dir=await fs.opendir(this.root);
  try{
   for await(const entry of dir){
    signal.throwIfAborted();if(summary.entries>=LIMIT||performance.now()>deadline){complete=false;message='本次空间核对达到时间或文件数量上限，以下只显示已核对部分；不能据此清理。';break;}
    summary.entries++;const item:TagBackupEntry={name:entry.name,jobId:null,title:entry.name,bytes:null,modifiedAt:null,disposition:'unmanaged',reason:'未能对应当前曲库的备份任务，原文件保留'};
    const owner=owned.get(entry.name);if(owner){item.jobId=owner.jobId;item.title=owner.title;summary.knownBackups++;}
    try{
     const stat=await fs.lstat(path.join(this.root,entry.name),{bigint:true});signal.throwIfAborted();
     if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n){item.reason='目录、重解析点或共享链接不会作为可清理备份';if(owner)item.disposition='protected';complete=false;}
     else{
      item.bytes=String(stat.size);const modified=Number(stat.mtimeMs);item.modifiedAt=Number.isFinite(modified)?modified:null;
      if(owner){
       knownBytes+=stat.size;item.disposition='protected';
       const retainedFrom=Math.max(owner.endedAt??Infinity,Number(stat.birthtimeMs));
       if(owner.reason)item.reason=owner.reason;
       else if(item.bytes!==owner.expectedBytes)item.reason='文件大小与原备份计划不一致，须独立核对';
       else if(!Number.isFinite(retainedFrom)||retainedFrom>observedAt)item.reason='备份保留起点不可确认';
       else if(observedAt-retainedFrom<policy.keepDays*86400000)item.reason=`任务结束后至少保留 ${policy.keepDays} 天`;
       else{item.disposition='candidate';item.reason='任务已结束且达到保留期；仍需独立核对后才能清理';candidateBytes+=stat.size;}
      }else otherBytes+=stat.size;
     }
    }catch(error){signal.throwIfAborted();item.disposition='unreadable';item.reason='本次无法读取，文件仍保留';complete=false;}
    if(item.disposition==='candidate')summary.candidates++;else if(item.disposition==='protected')summary.protected++;else if(item.disposition==='unreadable')summary.unreadable++;else summary.unmanaged++;
    items.push(item);
   }
  }finally{await dir.close().catch(error=>{if((error as NodeJS.ErrnoException).code!=='ERR_DIR_CLOSED')throw error;});}
  signal.throwIfAborted();const after=await this.rootIdentity();
  if(before.dev!==after.dev||before.ino!==after.ino)throw new Error('备份目录身份已变化，本次清单无效');
  if(before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs){complete=false;message='核对期间备份目录发生变化，请重新核对后再处理。';}
  summary.knownBytes=String(knownBytes);summary.candidateBytes=String(candidateBytes);summary.otherFileBytes=String(otherBytes);
  summary.overBudgetBytes=policy.maxBytes!=='0'&&knownBytes>BigInt(policy.maxBytes)?String(knownBytes-BigInt(policy.maxBytes)):'0';
  items.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  return {snapshotId:randomUUID(),observedAt,policy,complete,message,summary,items,cleanupReady:false};
 }
 private async rootIdentity(){
  const stat=await fs.lstat(this.root,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink()||normalized(await fs.realpath(this.root))!==normalized(this.root))throw new Error('备份目录是链接或身份不可确认，已保留全部文件');
  return stat;
 }
}
