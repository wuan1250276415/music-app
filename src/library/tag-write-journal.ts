import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readTagWritePlan,readTagWriteTransition,validateTagWriteAdvance,tagWriteKeys,tagWriteHash,tagWriteUuid,type TagWritePlan,type TagWriteTransition} from '../shared/tag-write.js';
interface Receipt {version:1;jobId:string;revision:number;at:number;previousSha256:string|null;plan:TagWritePlan|null;transition:TagWriteTransition|null;sha256:string}
export interface TagWriteJournalSnapshot {plan:TagWritePlan;revision:number;receiptSha256:string;history:TagWriteTransition[];receiptSha256s?:string[]}
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const digest=(value:unknown)=>createHash('sha256').update(canonical(value),'utf8').digest('hex');
const normalize=(v:string)=>process.platform==='win32'?v.toLowerCase():v;
// Filesystem receipts and DB state are separate resources. Each immutable receipt
// is fsynced before returning. Partial or ambiguous logs are never overwritten.
export class TagWriteJournal {
 private readonly root:string;
 private readonly certificates:ReadonlyMap<string,string>;
 constructor(dataDir:string,certificates:ReadonlyMap<string,string>=new Map()){if(!path.isAbsolute(dataDir))throw new Error('写回日志目录必须为绝对路径');this.root=path.join(dataDir,'tag-write');this.certificates=new Map(certificates);}
 assertPlanBudget(value:unknown):void {const plan=readTagWritePlan(value);this.bytes({version:1,jobId:plan.jobId,revision:0,at:Date.now(),previousSha256:null,plan,transition:null});}
 private async directory(jobId:string,create=false):Promise<string>{
  if(!tagWriteUuid(jobId))throw new Error('写回任务身份无效');await fs.mkdir(this.root,{recursive:true});
  const base=await fs.lstat(this.root);if(!base.isDirectory()||base.isSymbolicLink()||normalize(await fs.realpath(this.root))!==normalize(path.resolve(this.root)))throw new Error('写回日志根目录不可确认');
  const folder=path.join(this.root,jobId.toLowerCase());if(create)await fs.mkdir(folder);
  const stat=await fs.lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink()||normalize(await fs.realpath(folder))!==normalize(path.resolve(folder)))throw new Error('写回日志任务目录不可确认');return folder;
 }
 private bytes(receipt:Omit<Receipt,'sha256'>):Buffer{const b=Buffer.from(canonical({...receipt,sha256:digest(receipt)})+'\n','utf8');if(b.length>65536)throw new Error('写回日志记录超过预算');return b;}
 private async persist(folder:string,revision:number,bytes:Buffer):Promise<void>{
  const filename=path.join(folder,`${String(revision).padStart(4,'0')}.json`),handle=await fs.open(filename,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  if(normalize(await fs.realpath(folder))!==normalize(path.resolve(folder)))throw new Error('写回日志保存后目录发生变化');
 }
 async create(planValue:unknown):Promise<TagWriteJournalSnapshot>{
  const plan=readTagWritePlan(planValue),receipt={version:1 as const,jobId:plan.jobId,revision:0,at:Date.now(),previousSha256:null,plan,transition:null},bytes=this.bytes(receipt);
  if(plan.certificateId!==null&&this.certificates.get(plan.adapter)!==plan.certificateId)throw new Error('写回计划没有受信任的格式认证');
  const existing=await fs.readdir(this.root).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;});if(existing.length>=1024)throw new Error('写回日志任务数量达到上限，请完成归档处理');
  let folder:string;try{folder=await this.directory(plan.jobId,true);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const saved=await this.read(plan.jobId);if(canonical(saved.plan)!==canonical(plan))throw new Error('同一写回任务身份对应不同计划');return saved;}
  await this.persist(folder,0,bytes);return this.read(plan.jobId);
 }
 async read(jobId:string):Promise<TagWriteJournalSnapshot>{
  const folder=await this.directory(jobId),names=(await fs.readdir(folder)).sort();
  if(!names.length||names.length>32||names.some((n,i)=>n!==`${String(i).padStart(4,'0')}.json`))throw new Error('写回日志存在缺口或不明工件，必须保留并恢复');
  let plan:TagWritePlan|null=null,previous:string|null=null;const history:TagWriteTransition[]=[];const receiptSha256s:string[]=[];
  for(let i=0;i<names.length;i++){
   const filename=path.join(folder,names[i]),before=await fs.lstat(filename);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>65536)throw new Error('写回日志工件不可确认');
   const handle=await fs.open(filename,'r');let raw:Buffer;try{const stat=await handle.stat();if(stat.size!==before.size||stat.ino!==before.ino||stat.dev!==before.dev)throw new Error('写回日志工件已变化');raw=await handle.readFile();const after=await handle.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new Error('写回日志读取期间变化');}finally{await handle.close();}
   if(raw.length>65536)throw new Error('写回日志工件超过预算');
   const r:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
   if(!tagWriteKeys(r,['version','jobId','revision','at','previousSha256','plan','transition','sha256'])||r.version!==1||r.jobId!==jobId||r.revision!==i||!Number.isSafeInteger(r.at)||Number(r.at)<0||r.previousSha256!==previous||!tagWriteHash(r.sha256))throw new Error('写回日志身份、顺序或链无效');
   const {sha256,...body}=r;if(digest(body)!==sha256)throw new Error('写回日志内容校验失败');
   if(i===0){if(r.transition!==null||r.plan===null)throw new Error('写回日志缺少初始计划');plan=readTagWritePlan(r.plan);if(plan.jobId!==jobId)throw new Error('写回日志计划身份不符');}
   else {if(r.plan!==null||r.transition===null)throw new Error('写回阶段日志结构无效');const t=validateTagWriteAdvance(plan!,history,r.transition);if(history.some(old=>old.commandId===t.commandId))throw new Error('写回阶段命令重复');history.push(t);}
   previous=sha256;receiptSha256s.push(sha256);
  }
  if(normalize(await fs.realpath(folder))!==normalize(path.resolve(folder)))throw new Error('写回日志目录已变化');return {plan:plan!,revision:names.length-1,receiptSha256:previous!,history,receiptSha256s};
 }
 async advance(jobId:string,baseRevision:number,transitionValue:unknown):Promise<TagWriteJournalSnapshot>{
  if(!Number.isSafeInteger(baseRevision)||baseRevision<0||baseRevision>=31)throw new Error('写回日志修订无效');const t=readTagWriteTransition(transitionValue),before=await this.read(jobId),cached=before.history.find(h=>h.commandId===t.commandId);
  if(cached){if(canonical(cached)!==canonical(t))throw new Error('旧写回命令内容已改变');return before;}
  if(before.revision!==baseRevision)throw new Error('写回日志已更新，请回读原操作');validateTagWriteAdvance(before.plan,before.history,t);
  if(t.stage==='replaced'&&(before.plan.certificateId===null||this.certificates.get(before.plan.adapter)!==before.plan.certificateId))throw new Error('当前格式未认证，不能确认源文件替换');
  const body={version:1 as const,jobId,revision:baseRevision+1,at:Date.now(),previousSha256:before.receiptSha256,plan:null,transition:t},folder=await this.directory(jobId);
  try{await this.persist(folder,baseRevision+1,this.bytes(body));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const saved=await this.read(jobId),receipt=saved.history.find(h=>h.commandId===t.commandId);if(!receipt||canonical(receipt)!==canonical(t))throw new Error('写回日志保存冲突，不能重发旧阶段');return saved;}
  return this.read(jobId);
 }
}
