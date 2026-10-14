import {promises as fs,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {backupUuid} from '../shared/catalog-backup.js';
import {fileObservation} from '../platform/file-observation.js';
import {readDirectoryMoveRequest,readDirectoryMoveMessage,readDirectoryMoveProof,DIRECTORY_MOVE_SLOTS,type CatalogDirectoryMoveRequest,type CatalogDirectoryMoveMessage,type CatalogDirectoryMoveProof} from '../shared/catalog-directory-move.js';
type Stage=Extract<CatalogDirectoryMoveMessage,{kind:'stage'}>;
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const id=(s:BigIntStats)=>`${s.dev}:${s.ino}:${s.birthtimeNs}`;
export function directoryMovePaths(request:CatalogDirectoryMoveRequest):{transaction:string;data:string;candidate:string;source:string;target:string}{
 const transaction=path.join(request.userData,'backups','restore-transactions',request.transactionId),data=path.join(transaction,'data'),candidate=path.join(data,'candidate'),slots={live:path.join(request.userData,'library'),candidate:path.join(candidate,'library'),original:path.join(data,'original-library'),'retired-candidate':path.join(data,'retired-candidate')},[a,b]=DIRECTORY_MOVE_SLOTS[request.action];return {transaction,data,candidate,source:slots[a],target:slots[b]};
}
async function directory(filename:string):Promise<string>{
 if(!path.isAbsolute(filename)||path.resolve(filename)!==filename)throw new Error('目录切换登记位置无效');let current=path.parse(filename).root;
 for(const part of filename.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const s=await fs.lstat(current,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())throw new Error('目录切换登记含链接或非目录');}
 if((await fs.realpath(filename)).toLowerCase()!==filename.toLowerCase())throw new Error('目录切换实际位置不同');return id(await fs.lstat(filename,{bigint:true}));
}
async function names(folder:string,max:number):Promise<string[]>{const out:string[]=[],dir=await fs.opendir(folder);try{for await(const entry of dir){if(out.length>=max)throw new Error('目录切换记录达到保留预算');out.push(entry.name);}}finally{await dir.close().catch(()=>{});}return out.sort();}
async function read(filename:string,max:number):Promise<Buffer>{
 const s=await fs.lstat(filename,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size>BigInt(max))throw new Error('目录切换记录类型或大小无效');const f=await fs.open(filename,'r');
 try{if(fileObservation(await f.stat({bigint:true}))!==fileObservation(s))throw new Error('目录切换记录打开时变化');const raw=Buffer.alloc(Number(s.size));let at=0;while(at<raw.length){const r=await f.read(raw,at,raw.length-at,at);if(!r.bytesRead)throw new Error('目录切换记录截断');at+=r.bytesRead;}
  const named=await fs.lstat(filename,{bigint:true});if(named.isSymbolicLink()||named.nlink!==1n||fileObservation(named)!==fileObservation(s)||fileObservation(await f.stat({bigint:true}))!==fileObservation(s))throw new Error('目录切换记录读取时变化');return raw;
 }finally{await f.close();}
}
async function write(filename:string,raw:Buffer):Promise<string>{const f=await fs.open(filename,'wx',0o600);try{await f.writeFile(raw);await f.sync();const a=await f.stat({bigint:true}),b=await fs.lstat(filename,{bigint:true});if(!b.isFile()||b.isSymbolicLink()||b.nlink!==1n||a.size!==BigInt(raw.length)||fileObservation(a)!==fileObservation(b))throw new Error('目录切换记录写入未确认');}finally{await f.close();}return hash(raw);}
const parse=(raw:Buffer)=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
function canonical(raw:Buffer,body:unknown):void{if(!raw.equals(Buffer.from(JSON.stringify({...body as Record<string,unknown>,sha256:hash(Buffer.from(JSON.stringify(body)))}))))throw new Error('目录切换固定字段字节顺序不同');}
function checkedBody(value:unknown,names:string[],raw:Buffer):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==names.length||names.some(n=>!Object.hasOwn(value,n)))throw new Error('目录切换持久字段无效');const v=value as Record<string,unknown>,{sha256,...body}=v;if(typeof sha256!=='string'||sha256!==hash(Buffer.from(JSON.stringify(body)))||!raw.equals(Buffer.from(JSON.stringify({...body,sha256}))))throw new Error('目录切换记录摘要或规范字节无效');return body;
}
export type LoadedDirectoryMove={request:CatalogDirectoryMoveRequest;requestSha256:string;stages:Stage[];lastSha256:string;completed:boolean;exitSha256:string|null;proof:CatalogDirectoryMoveProof|null};
// This ledger never moves, overwrites, adopts or deletes a directory. Native
// operations require a new exclusive request reservation and each durable ACK.
export class CatalogDirectoryMoveJournal{
 private readonly request:CatalogDirectoryMoveRequest;private readonly paths:ReturnType<typeof directoryMovePaths>;private readonly moves:string;private readonly folder:string;
 constructor(value:CatalogDirectoryMoveRequest){this.request=readDirectoryMoveRequest(value);this.paths=directoryMovePaths(this.request);this.moves=path.join(this.paths.transaction,'moves');this.folder=path.join(this.moves,this.request.operationId);}
 static async reopen(userData:string,transactionId:string,operationId:string):Promise<LoadedDirectoryMove>{
  const transaction=backupUuid(transactionId),operation=backupUuid(operationId),folder=path.join(userData,'backups','restore-transactions',transaction,'moves',operation);
  const originalFolder=await directory(folder),raw=await read(path.join(folder,'request.json'),131072),body=checkedBody(parse(raw),['format','version','request','movesIdentity','folderIdentity','sha256'],raw),request=readDirectoryMoveRequest(body.request);
  if(request.userData!==userData||request.transactionId!==transaction||request.operationId!==operation||body.folderIdentity!==originalFolder)throw new Error('目录切换记录不属于当前应用或原操作');
  const loaded=await new CatalogDirectoryMoveJournal(request).load();if(loaded.requestSha256!==hash(raw)||await directory(folder)!==originalFolder)throw new Error('目录切换原请求在重开期间变化');return loaded;
 }
 private async roots():Promise<void>{const r=this.request;if(await directory(r.userData)!==r.userDataIdentity||await directory(this.paths.transaction)!==r.transactionIdentity||await directory(this.paths.data)!==r.dataIdentity||await directory(this.paths.candidate)!==r.candidateIdentity)throw new Error('目录切换原登记根身份已变化');}
 async reserve():Promise<void>{
  await this.roots();if(await directory(this.paths.source)!==this.request.sourceIdentity)throw new Error('目录切换来源身份不同');
  const exists=await fs.lstat(this.paths.target).then(()=>true).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;});if(exists)throw new Error('目录切换目标已经存在，不允许覆盖');
  await fs.mkdir(this.moves,{mode:0o700}).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});await directory(this.moves);if((await names(this.moves,16)).length>=16)throw new Error('目录切换操作达到16项保留预算');
  await fs.mkdir(this.folder,{mode:0o700});const folderIdentity=await directory(this.folder),movesIdentity=await directory(this.moves);await this.roots();const body={format:'aural-directory-move-request',version:1,request:this.request,movesIdentity,folderIdentity};await write(path.join(this.folder,'request.json'),Buffer.from(JSON.stringify({...body,sha256:hash(Buffer.from(JSON.stringify(body)))})));
 }
 async load():Promise<LoadedDirectoryMove>{
  await this.roots();const movesIdentity=await directory(this.moves),folderIdentity=await directory(this.folder),children=await names(this.folder,6),raw=await read(path.join(this.folder,'request.json'),131072),body=checkedBody(parse(raw),['format','version','request','movesIdentity','folderIdentity','sha256'],raw);
  if(body.format!=='aural-directory-move-request'||body.version!==1||body.movesIdentity!==movesIdentity||body.folderIdentity!==folderIdentity||JSON.stringify(readDirectoryMoveRequest(body.request))!==JSON.stringify(this.request))throw new Error('目录切换原请求或登记目录所有权已变化');
  canonical(raw,{format:'aural-directory-move-request',version:1,request:this.request,movesIdentity,folderIdentity});
  const requestSha256=hash(raw),stages:Stage[]=[];let lastSha256=requestSha256;
  for(let n=1;n<=4;n++){const name=String(n).padStart(4,'0')+'.json';if(!children.includes(name))break;const bytes=await read(path.join(this.folder,name),65536),v=checkedBody(parse(bytes),['format','version','requestSha256','previous','frame','sha256'],bytes);
   if(v.format!=='aural-directory-move-stage'||v.version!==1||v.requestSha256!==requestSha256||v.previous!==lastSha256)throw new Error('目录切换阶段链不连续');const frame=readDirectoryMoveMessage(v.frame,this.request,stages.length,stages.length);if(frame.kind!=='stage')throw new Error('目录切换阶段不是持久证明');canonical(bytes,{format:'aural-directory-move-stage',version:1,requestSha256,previous:lastSha256,frame});stages.push(frame);lastSha256=hash(bytes);
  }
  if(children.some(n=>!['request.json','exit.json',...stages.map((_,i)=>String(i+1).padStart(4,'0')+'.json')].includes(n)))throw new Error('目录切换记录含缺口或未知文件');let completed=false,exitSha256:string|null=null,proof:CatalogDirectoryMoveProof|null=null;
  if(children.includes('exit.json')){const bytes=await read(path.join(this.folder,'exit.json'),65536),v=checkedBody(parse(bytes),['format','version','operationId','requestSha256','previous','proof','closedAt','sha256'],bytes);
   if(v.format!=='aural-directory-move-exit'||v.version!==1||v.operationId!==this.request.operationId||v.requestSha256!==requestSha256||v.previous!==lastSha256||stages.length!==4||typeof v.closedAt!=='string'||!Number.isFinite(Date.parse(v.closedAt))||new Date(v.closedAt).toISOString()!==v.closedAt)throw new Error('目录切换实际退出回执无效');proof=readDirectoryMoveProof(v.proof,this.request,true);canonical(bytes,{format:'aural-directory-move-exit',version:1,operationId:this.request.operationId,requestSha256,previous:lastSha256,proof,closedAt:v.closedAt});completed=true;exitSha256=hash(bytes);
  }await this.roots();if(await directory(this.moves)!==movesIdentity||await directory(this.folder)!==folderIdentity)throw new Error('目录切换登记在读取期间变化');return {request:this.request,requestSha256,stages,lastSha256,completed,exitSha256,proof};
 }
 async append(value:Stage):Promise<string>{
  const current=await this.load();if(current.completed||current.stages.length>=4)throw new Error('目录切换原阶段不可再次执行');const frame=readDirectoryMoveMessage(value,this.request,current.stages.length,current.stages.length);if(frame.kind!=='stage')throw new Error('目录切换阶段证明无效');
  const body={format:'aural-directory-move-stage',version:1,requestSha256:current.requestSha256,previous:current.lastSha256,frame};await this.roots();const raw=Buffer.from(JSON.stringify({...body,sha256:hash(Buffer.from(JSON.stringify(body)))}));return write(path.join(this.folder,String(frame.sequence).padStart(4,'0')+'.json'),raw);
 }
 async complete(proof:CatalogDirectoryMoveProof):Promise<void>{
  const current=await this.load();if(current.completed||current.stages.length!==4)throw new Error('目录切换未取得完整阶段或已完成');const checked=readDirectoryMoveProof(proof,this.request,true);
  if(await directory(this.paths.target)!==this.request.sourceIdentity)throw new Error('目录切换进程退出后的目标身份不同');if(await fs.lstat(this.paths.source).then(()=>true).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}))throw new Error('目录切换来源在退出后仍存在');
  await this.roots();const body={format:'aural-directory-move-exit',version:1,operationId:this.request.operationId,requestSha256:current.requestSha256,previous:current.lastSha256,proof:checked,closedAt:new Date().toISOString()};await write(path.join(this.folder,'exit.json'),Buffer.from(JSON.stringify({...body,sha256:hash(Buffer.from(JSON.stringify(body)))})));
 }
}
