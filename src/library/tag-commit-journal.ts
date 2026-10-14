import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {tagWriteKeys,tagWriteUuid,tagWriteHash} from '../shared/tag-write.js';
import {assertTagCommitCertified} from '../shared/tag-commit.js';
import {tagCommitCanonical,readTagCommitBinding,readTagCommitStage,type TagCommitBinding,type TagCommitJournalSnapshot,type TagCommitStageMessage} from '../shared/tag-commit-journal.js';
const hash=(v:unknown)=>createHash('sha256').update(tagCommitCanonical(v)).digest('hex');
const normalize=(v:string)=>process.platform==='win32'?path.resolve(v).toLowerCase():path.resolve(v);
// Each phase is a separate immutable, fsynced file. DB receipts follow reread;
// gaps, partial records and unknown files remain evidence rather than cleanup.
export class TagCommitJournal {
 private readonly root:string;
 constructor(dataDir:string){if(!path.isAbsolute(dataDir))throw new Error('提交日志目录必须为绝对路径');this.root=path.join(dataDir,'tag-commit');}
 private async folder(id:string,create=false):Promise<string>{
  if(!tagWriteUuid(id))throw new Error('提交日志身份无效');await fs.mkdir(this.root,{recursive:true});
  const base=await fs.lstat(this.root);if(!base.isDirectory()||base.isSymbolicLink()||normalize(await fs.realpath(this.root))!==normalize(this.root))throw new Error('提交日志根目录不可确认');
  const folder=path.join(this.root,id);if(create){if((await fs.readdir(this.root)).length>=1024)throw new Error('提交日志数量达到预算，需完成保留策略处理');await fs.mkdir(folder);}
  const stat=await fs.lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink()||normalize(await fs.realpath(folder))!==normalize(folder))throw new Error('提交日志目录不可确认');return folder;
 }
 private async persist(folder:string,revision:number,body:unknown):Promise<void>{
  const bytes=Buffer.from(tagCommitCanonical({...body as object,sha256:hash(body)})+'\n');if(bytes.length>(revision===0?524288:65536))throw new Error('提交日志记录超过预算');const handle=await fs.open(path.join(folder,`${String(revision).padStart(4,'0')}.json`),'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}if(normalize(await fs.realpath(folder))!==normalize(folder))throw new Error('提交日志保存期间目录变化');
 }
 async create(value:unknown):Promise<TagCommitJournalSnapshot>{const binding=readTagCommitBinding(value);assertTagCommitCertified(binding.request.certificateId);const id=binding.request.operationId;let folder:string;
  try{folder=await this.folder(id,true);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const saved=await this.read(id);if(tagCommitCanonical(saved.binding)!==tagCommitCanonical(binding))throw new Error('提交日志身份已用于其他内容');return saved;}
  await this.persist(folder,0,{version:1,operationId:id,revision:0,at:Date.now(),previousSha256:null,binding,stage:null});return this.read(id);
 }
 async read(id:string):Promise<TagCommitJournalSnapshot>{
  const folder=await this.folder(id),names=(await fs.readdir(folder)).sort();if(!names.length||names.length>6||names.some((n,i)=>n!==`${String(i).padStart(4,'0')}.json`))throw new Error('提交日志存在缺口、部分记录或不明工件');
  let binding:TagCommitBinding|null=null,previous:string|null=null;const stages:TagCommitStageMessage[]=[],hashes:string[]=[];
  for(let i=0;i<names.length;i++){
   const filename=path.join(folder,names[i]),before=await fs.lstat(filename,{bigint:true}),max=i===0?524288n:65536n;if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>max)throw new Error('提交日志文件不可确认');
   const handle=await fs.open(filename,'r');let bytes:Buffer;try{const opened=await handle.stat({bigint:true});if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.mtimeNs!==before.mtimeNs||opened.ctimeNs!==before.ctimeNs)throw new Error('提交日志打开期间变化');bytes=Buffer.alloc(Number(opened.size));let at=0;while(at<bytes.length){const read=await handle.read(bytes,at,bytes.length-at,at);if(!read.bytesRead)throw new Error('提交日志读取不完整');at+=read.bytesRead;}const after=await handle.stat({bigint:true}),current=await fs.lstat(filename,{bigint:true});if([after,current].some(s=>s.dev!==opened.dev||s.ino!==opened.ino||s.size!==opened.size||s.mtimeNs!==opened.mtimeNs||s.ctimeNs!==opened.ctimeNs||s.nlink!==1n))throw new Error('提交日志读取期间变化');}finally{await handle.close();}
   const r:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!tagWriteKeys(r,['version','operationId','revision','at','previousSha256','binding','stage','sha256'])||r.version!==1||r.operationId!==id||r.revision!==i||!Number.isSafeInteger(r.at)||Number(r.at)<0||r.previousSha256!==previous||!tagWriteHash(r.sha256))throw new Error('提交日志身份、修订或链无效');const {sha256,...body}=r;if(hash(body)!==sha256)throw new Error('提交日志摘要无效');
   if(i===0){if(r.stage!==null)throw new Error('提交日志初始阶段无效');binding=readTagCommitBinding(r.binding);if(binding.request.operationId!==id)throw new Error('提交日志初始请求身份不符');}
   else {if(r.binding!==null)throw new Error('提交阶段不能重写初始绑定');stages.push(readTagCommitStage(r.stage,binding!,stages));}previous=sha256;hashes.push(sha256);
  }
  if(normalize(await fs.realpath(folder))!==normalize(folder))throw new Error('提交日志读取后目录变化');return {binding:binding!,revision:names.length-1,sha256:previous!,hashes,stages};
 }
 async advance(id:string,baseRevision:number,value:unknown):Promise<TagCommitJournalSnapshot>{
  const before=await this.read(id),raw=value as {sequence?:unknown},existing=before.stages.find(s=>s.sequence===raw?.sequence);if(existing){if(tagCommitCanonical(existing)!==tagCommitCanonical(value))throw new Error('已持久提交回执内容不可更改');return before;}
  if(before.revision!==baseRevision||!Number.isSafeInteger(baseRevision)||baseRevision<0||baseRevision>=5)throw new Error('提交日志修订已变化或已完成');assertTagCommitCertified(before.binding.request.certificateId);const stage=readTagCommitStage(value,before.binding,before.stages),folder=await this.folder(id);
  try{await this.persist(folder,baseRevision+1,{version:1,operationId:id,revision:baseRevision+1,at:Date.now(),previousSha256:before.sha256,binding:null,stage});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const saved=await this.read(id),old=saved.stages.find(s=>s.sequence===stage.sequence);if(!old||tagCommitCanonical(old)!==tagCommitCanonical(stage))throw new Error('提交日志保存冲突，保留证据等待恢复');return saved;}return this.read(id);
 }
}
