import {promises as fs,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileObservation} from '../platform/file-observation.js';
import {backupUuid,readCatalogBackupManifest,CATALOG_BACKUP_MAX_MANIFEST,type CatalogBackupManifest} from '../shared/catalog-backup.js';
import {readBackupResult,type CatalogBackupResult} from '../shared/catalog-backup-ui.js';
import {readBackupHistory,type CatalogBackupHistory,type CatalogBackupHistoryEntry} from '../shared/catalog-backup-history.js';
import type {BackupPackedResult} from '../shared/catalog-backup-worker.js';
export type BackupDestination={target:string;temporary:string;parentIdentity:string;prior:string|null};
type FileProof={identity:string;observation:string;bytes:number;sha256:string};
type SnapshotRef={stagePath:string;manifestSha256:string};
type Checkpoint={kind:'created'|'selected'|'snapshot'|'packed'|'publishing'|'completed'|'failed'|'cancelled'|'verified'|'verificationFailed';destination:BackupDestination|null;snapshot:SnapshotRef|null;packed:FileProof|null;published:FileProof|null;result:CatalogBackupResult|null;verification:FileProof|null;message:string};
type RecordEntry={format:'aural-backup-operation';version:1;operationId:string;sequence:number;previous:string|null;at:string;checkpoint:Checkpoint;sha256:string};
export type LoadedBackupOperation={directory:string;directoryIdentity:string;records:RecordEntry[];manifest:CatalogBackupManifest|null};
const MAX_OPERATIONS=256,MAX_RECORDS=32,MAX_RECORD_BYTES=192*1024;
class LedgerReadBudgetError extends Error {}
const digest=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const identity=(s:BigIntStats)=>`${s.dev}:${s.ino}:${s.birthtimeNs}`;
const failure=(e:unknown)=>String(e instanceof Error?e.message:e).slice(0,1024)||'备份记录无法读取';
function fields(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new Error('备份持久记录字段无效');return v as Record<string,unknown>;}
function absolute(v:unknown):string{if(typeof v!=='string'||v.length>32767||!path.isAbsolute(v)||path.resolve(v)!==v||/[\u0000-\u001f]/.test(v))throw new Error('备份私有路径无效');return v;}
function sha(v:unknown):string{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw new Error('备份记录摘要无效');return v;}
function fileId(v:unknown):string{if(typeof v!=='string'||v.length>256||!/^\d+:\d+:-?\d+$/.test(v))throw new Error('备份记录文件身份无效');return v;}
function proof(v:unknown):FileProof{const p=fields(v,['identity','observation','bytes','sha256']);if(typeof p.bytes!=='number'||!Number.isSafeInteger(p.bytes)||p.bytes<52||p.bytes>64*1024**3+CATALOG_BACKUP_MAX_MANIFEST+52)throw new Error('备份记录长度无效');return {identity:fileId(p.identity),observation:sha(p.observation),bytes:p.bytes,sha256:sha(p.sha256)};}
export function backupFileProof(v:BackupPackedResult):FileProof{return proof({identity:v.identity,observation:v.observation,bytes:v.bytes,sha256:v.sha256});}
function destination(v:unknown):BackupDestination{
 const d=fields(v,['target','temporary','parentIdentity','prior']),target=absolute(d.target),temporary=absolute(d.temporary);
 if(path.extname(target).toLowerCase()!=='.auralbackup'||path.dirname(target)!==path.dirname(temporary)||!/^\.aural-backup-[a-f0-9-]{36}\.tmp$/.test(path.basename(temporary)))throw new Error('备份目标登记无效');
 backupUuid(path.basename(temporary).slice(14,-4));return {target,temporary,parentIdentity:fileId(d.parentIdentity),prior:d.prior===null?null:sha(d.prior)};
}
function checkpoint(value:unknown,operationId:string,dataDir:string):Checkpoint{
 const c=fields(value,['kind','destination','snapshot','packed','published','result','verification','message']);
 if(typeof c.kind!=='string'||!['created','selected','snapshot','packed','publishing','completed','failed','cancelled','verified','verificationFailed'].includes(c.kind)||typeof c.message!=='string'||c.message.length>1024)throw new Error('备份检查点无效');
 const d=c.destination===null?null:destination(c.destination);let s:SnapshotRef|null=null;
 if(c.snapshot!==null){const v=fields(c.snapshot,['stagePath','manifestSha256']),stagePath=absolute(v.stagePath);if(path.dirname(stagePath)!==path.join(dataDir,'backups','catalog')||!path.basename(stagePath).startsWith('.aural-backup-'+operationId+'-'))throw new Error('备份快照登记来源无效');s={stagePath,manifestSha256:sha(v.manifestSha256)};}
 const packed=c.packed===null?null:proof(c.packed),published=c.published===null?null:proof(c.published),result=c.result===null?null:readBackupResult(c.result),verification=c.verification===null?null:proof(c.verification);
 if(s&&!d||packed&&!s||published&&!packed||result&&(!published||!packed||result.sha256!==packed.sha256||result.bytes!==packed.bytes||result.name!==path.basename(d!.target).slice(0,128))||published&&(published.sha256!==packed!.sha256||published.bytes!==packed!.bytes)||verification&&(!packed||verification.bytes!==packed.bytes||verification.sha256!==packed.sha256)||c.kind==='completed'&&!result||c.kind==='verified'&&!verification||c.kind==='selected'&&!d||c.kind==='snapshot'&&!s||['packed','publishing'].includes(c.kind)&&!packed)throw new Error('备份检查点证据不完整');
 return {kind:c.kind as Checkpoint['kind'],destination:d,snapshot:s,packed,published,result,verification,message:c.message};
}
function transition(previous:Checkpoint|undefined,next:Checkpoint):void{
 if(!previous){if(next.kind!=='created'||next.destination||next.snapshot||next.packed||next.published||next.result||next.verification)throw new Error('备份记录首项不是空白创建意图');return;}
 const allowed:Record<Checkpoint['kind'],Checkpoint['kind'][]>={created:['selected','failed','cancelled'],selected:['selected','snapshot','failed','cancelled'],snapshot:['packed','failed','cancelled'],packed:['publishing','failed','cancelled','verified','verificationFailed'],publishing:['completed','failed','cancelled','verified','verificationFailed'],completed:['verified','verificationFailed'],failed:['verified','verificationFailed'],cancelled:['verified','verificationFailed'],verified:['verified','verificationFailed'],verificationFailed:['verified','verificationFailed']};
 if(!allowed[previous.kind].includes(next.kind))throw new Error('备份记录状态顺序无效');
 for(const key of ['destination','snapshot','packed','published','result'] as const)if(previous[key]!==null&&JSON.stringify(previous[key])!==JSON.stringify(next[key]))throw new Error('备份原意图或已确认文件证据被改写');
}
// This chain detects truncation, gaps and accidental changes. It is not a signature
// against a local account that can replace the complete chain and its manifest.
export class CatalogBackupLedger {
 private readonly root:string;
 constructor(private readonly dataDir:string){this.root=path.join(dataDir,'backups','operations');}
 private async ordinaryDirectory(filename:string):Promise<string>{
  let current=path.parse(filename).root;for(const part of filename.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const stat=await fs.lstat(current,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('备份登记目录不是普通目录');}
  const actual=await fs.realpath(filename);if((process.platform==='win32'?actual.toLowerCase():actual)!==(process.platform==='win32'?filename.toLowerCase():filename))throw new Error('备份登记目录实际位置变化');return identity(await fs.lstat(filename,{bigint:true}));
 }
 private async names(filename:string,max:number):Promise<string[]>{const names:string[]=[];const dir=await fs.opendir(filename);try{for await(const entry of dir){if(names.length>=max)throw new Error('备份登记数量超过预算，保留现有资料，请先处理保留策略');names.push(entry.name);}}finally{await dir.close().catch(()=>{});}return names.sort();}
 private async readFile(filename:string,max:number,budget?:{remaining:number}):Promise<Buffer>{
  const before=await fs.lstat(filename,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(max))throw new Error('备份登记文件类型或大小无效');
  if(budget){if(before.size>BigInt(budget.remaining))throw new LedgerReadBudgetError('本次记录列表达到64MiB读取预算，后续资料未读取或删除。');budget.remaining-=Number(before.size);}
  const fd=await fs.open(filename,'r');try{const opened=await fd.stat({bigint:true});if(identity(opened)!==identity(before)||fileObservation(opened)!==fileObservation(before))throw new Error('备份登记文件在打开前变化');const bytes=Buffer.alloc(Number(before.size));let offset=0;while(offset<bytes.length){const read=await fd.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw new Error('备份登记文件被截断');offset+=read.bytesRead;}const after=await fd.stat({bigint:true}),named=await fs.lstat(filename,{bigint:true});if(named.isSymbolicLink()||named.nlink!==1n||fileObservation(after)!==fileObservation(before)||fileObservation(named)!==fileObservation(before))throw new Error('备份登记文件在读取期间变化');return bytes;}finally{await fd.close();}
 }
 private async writeNew(filename:string,bytes:Buffer):Promise<void>{
  const fd=await fs.open(filename,'wx',0o600);try{await fd.writeFile(bytes);await fd.sync();const stat=await fd.stat({bigint:true}),named=await fs.lstat(filename,{bigint:true});if(named.isSymbolicLink()||named.nlink!==1n||stat.size!==BigInt(bytes.length)||fileObservation(stat)!==fileObservation(named))throw new Error('备份登记写入身份变化');}finally{await fd.close();}
 }
 async create(value:unknown):Promise<LoadedBackupOperation>{
  const operationId=backupUuid(value);await this.ordinaryDirectory(this.dataDir);await fs.mkdir(path.dirname(this.root)).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});await this.ordinaryDirectory(path.dirname(this.root));await fs.mkdir(this.root).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});await this.ordinaryDirectory(this.root);
  if((await this.names(this.root,MAX_OPERATIONS)).length>=MAX_OPERATIONS)throw new Error('备份记录已达256项保留预算，未开始新备份');
  const directory=path.join(this.root,operationId);await fs.mkdir(directory);const op={directory,directoryIdentity:await this.ordinaryDirectory(directory),records:[],manifest:null} as LoadedBackupOperation;
  await this.append(op,{kind:'created',destination:null,snapshot:null,packed:null,published:null,result:null,verification:null,message:'备份操作已登记，尚未选择保存位置。'});return op;
 }
 async load(value:unknown,readManifest=true,budget?:{remaining:number}):Promise<LoadedBackupOperation>{
  const operationId=backupUuid(value);await this.ordinaryDirectory(this.root);const directory=path.join(this.root,operationId),directoryIdentity=await this.ordinaryDirectory(directory),names=await this.names(directory,MAX_RECORDS+1),records:RecordEntry[]=[];
  const journal=names.filter(n=>/^\d{4}\.json$/.test(n));if(!journal.length||journal.length>MAX_RECORDS||names.some(n=>n!=='manifest.json'&&!journal.includes(n)))throw new Error('备份登记含未知、缺失或超量工件，原资料已保留');
  for(const name of journal){if(name!==String(records.length).padStart(4,'0')+'.json')throw new Error('备份记录链有缺口');const bytes=await this.readFile(path.join(directory,name),MAX_RECORD_BYTES,budget);const v=fields(JSON.parse(bytes.toString('utf8')),['format','version','operationId','sequence','previous','at','checkpoint','sha256']);
   if(v.format!=='aural-backup-operation'||v.version!==1||v.operationId!==operationId||v.sequence!==records.length||v.previous!==(records.at(-1)?.sha256??null)||typeof v.at!=='string'||!Number.isFinite(Date.parse(v.at))||new Date(v.at).toISOString()!==v.at)throw new Error('备份记录身份或前后链无效');
   const entry={format:'aural-backup-operation' as const,version:1 as const,operationId,sequence:records.length,previous:records.at(-1)?.sha256??null,at:v.at,checkpoint:checkpoint(v.checkpoint,operationId,this.dataDir)};
   const declared=sha(v.sha256);if(declared!==digest(JSON.stringify(entry))||!bytes.equals(Buffer.from(JSON.stringify({...entry,sha256:declared}),'utf8')))throw new Error('备份记录规范字节或摘要不符');transition(records.at(-1)?.checkpoint,entry.checkpoint);records.push({...entry,sha256:declared});
  }
  const latest=records.at(-1)!;let manifest:CatalogBackupManifest|null=null;
  if(readManifest&&latest.checkpoint.snapshot){const raw=await this.readFile(path.join(directory,'manifest.json'),CATALOG_BACKUP_MAX_MANIFEST);manifest=readCatalogBackupManifest(JSON.parse(raw.toString('utf8')));if(manifest.backupId!==operationId||digest(raw)!==latest.checkpoint.snapshot.manifestSha256||!raw.equals(Buffer.from(JSON.stringify(manifest),'utf8')))throw new Error('备份登记清单不符');
   const c=latest.checkpoint;if(c.packed&&c.packed.bytes!==12+raw.length+manifest.files.reduce((sum,f)=>sum+f.bytes,0)+40||c.result&&(c.result.items!==manifest.counts.playable_item||c.result.files!==manifest.files.length||c.result.createdAt!==manifest.createdAt))throw new Error('备份回执计数或长度与原清单不符');}
  // A manifest persisted before its journal acknowledgment is retained, not adopted.
  if(directoryIdentity!==await this.ordinaryDirectory(directory))throw new Error('备份操作目录变化');return {directory,directoryIdentity,records,manifest};
 }
 async append(op:LoadedBackupOperation,patch:Partial<Checkpoint>):Promise<void>{
  const operationId=backupUuid(path.basename(op.directory));if(op.directory!==path.join(this.root,operationId)||await this.ordinaryDirectory(op.directory)!==op.directoryIdentity)throw new Error('备份登记目录所有权变化');
  if(op.records.length){const actual=await this.load(operationId);if(actual.directoryIdentity!==op.directoryIdentity||actual.records.length!==op.records.length||actual.records.at(-1)!.sha256!==op.records.at(-1)!.sha256)throw new Error('备份记录已变化，未追加或发布');}
  else if((await this.names(op.directory,MAX_RECORDS+1)).length)throw new Error('备份操作目录已被占用');
  if(op.records.length>=MAX_RECORDS)throw new Error('备份操作已达32条检查点预算');
  const c=checkpoint({...op.records.at(-1)?.checkpoint,...patch},operationId,this.dataDir);
  transition(op.records.at(-1)?.checkpoint,c);
  const body={format:'aural-backup-operation' as const,version:1 as const,operationId,sequence:op.records.length,previous:op.records.at(-1)?.sha256??null,at:new Date().toISOString(),checkpoint:c},entry={...body,sha256:digest(JSON.stringify(body))},bytes=Buffer.from(JSON.stringify(entry));if(bytes.length>MAX_RECORD_BYTES)throw new Error('备份检查点超过预算');
  if(await this.ordinaryDirectory(op.directory)!==op.directoryIdentity)throw new Error('备份登记目录在追加前变化');await this.writeNew(path.join(op.directory,String(entry.sequence).padStart(4,'0')+'.json'),bytes);op.records.push(entry);
 }
 async capture(op:LoadedBackupOperation,stagePath:string,manifest:CatalogBackupManifest):Promise<void>{
  if(op.records.at(-1)?.checkpoint.snapshot||op.manifest)throw new Error('备份清单已经登记');
  const validated=readCatalogBackupManifest(manifest),raw=Buffer.from(JSON.stringify(validated));if(raw.length>CATALOG_BACKUP_MAX_MANIFEST)throw new Error('备份登记清单超过预算');
  // Validate the journal source before persisting a separate bounded manifest.
  await this.append(op,{kind:'selected',message:'保存位置已登记，正在捕获快照。'});
  await this.writeNew(path.join(op.directory,'manifest.json'),raw);op.manifest=validated;
  await this.append(op,{kind:'snapshot',snapshot:{stagePath,manifestSha256:digest(raw)},message:'一致快照已登记，尚未生成完整备份文件。'});
 }
 async assertTarget(op:LoadedBackupOperation,verified?:FileProof):Promise<string>{
  const c=op.records.at(-1)!.checkpoint;if(!c.destination||!c.packed||!c.snapshot||!op.manifest)throw new Error('此记录没有完整备份文件证明，不能核对目标');
  const {target,parentIdentity}=c.destination;if(await this.ordinaryDirectory(path.dirname(target))!==parentIdentity)throw new Error('原保存目录身份已变化');
  const stat=await fs.lstat(target,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size!==BigInt(c.packed.bytes)||c.published&&identity(stat)!==c.published.identity||verified&&(identity(stat)!==verified.identity||fileObservation(stat)!==verified.observation))throw new Error('原备份目标缺失、被替换或核对期间变化');return target;
 }
 verificationInput(op:LoadedBackupOperation):{stagePath:string;manifest:CatalogBackupManifest;proof:FileProof}{const c=op.records.at(-1)!.checkpoint;if(!c.packed||!c.snapshot||!op.manifest)throw new Error('记录缺少完整备份证明');return {stagePath:c.snapshot.stagePath,manifest:op.manifest,proof:c.packed};}
 async list():Promise<CatalogBackupHistory>{
  let names:string[];try{await this.ordinaryDirectory(this.root);names=await this.names(this.root,MAX_OPERATIONS);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {entries:[],notice:''};return {entries:[],notice:failure(error)};}
  const entries:CatalogBackupHistoryEntry[]=[];let unknown=0,notice='';const budget={remaining:64*1024*1024};
  for(const name of names){try{backupUuid(name);}catch{unknown++;continue;}
   try{const op=await this.load(name,false,budget),c=op.records.at(-1)!.checkpoint;const status:CatalogBackupHistoryEntry['status']=c.kind==='verified'?(c.result?'verified':'reconciled'):c.kind==='completed'?'recorded':c.kind==='cancelled'?'cancelled':c.kind==='failed'||c.kind==='verificationFailed'?'failed':'interrupted';entries.push({operationId:name,name:c.destination?path.basename(c.destination.target).slice(0,128):'',updatedAt:op.records.at(-1)!.at,status,message:c.message,canVerify:Boolean(c.packed&&c.snapshot&&op.records.length<MAX_RECORDS-1)});}
   catch(error){if(error instanceof LedgerReadBudgetError){notice=error.message;break;}entries.push({operationId:name,name:'',updatedAt:'',status:'invalid',message:failure(error),canVerify:false});}
  }
  entries.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.operationId.localeCompare(b.operationId));return readBackupHistory({entries,notice:(notice+(unknown?` ${unknown} 项未知目录资料已保留，未作为备份记录读取。`:'')).trim()});
 }
}
