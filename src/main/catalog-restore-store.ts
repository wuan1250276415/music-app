import {promises as fs,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileObservation} from '../platform/file-observation.js';
import {backupUuid} from '../shared/catalog-backup.js';
import {RESTORE_FRAME_BYTES,readRestoreFile,readRestoreIdentity,readRestorePrepared,readRestorePreview,type RestoreFileEvidence,type CatalogRestorePreview,type CatalogRestorePrepared} from '../shared/catalog-restore.js';
import {readRestoreHistory,type CatalogRestoreHistory,type CatalogRestoreHistoryEntry} from '../shared/catalog-restore-history.js';
import {assertRestoreCompatibility,type CatalogRestoreCompatibility} from '../shared/catalog-restore-compatibility.js';
import {RELEASE} from '../shared/release.js';
export type RestoreReservation={operationId:string;directory:string;directoryIdentity:string;filename:string;source:RestoreFileEvidence;sourceParentIdentity:string;parent:string;parentIdentity:string;name:string};
type CheckRecord={format:'aural-restore-check';version:1|2;operationId:string;sequence:number;previous:string|null;checkedAt:string;preparedSha256:string;stageIdentity:string;pendingValues:number;compatibility?:CatalogRestoreCompatibility;sha256:string};
export type LoadedRestorePrepared={reservation:RestoreReservation;prepared:CatalogRestorePrepared;preview:CatalogRestorePreview;preparedSha256:string;checkedAt:string;checks:CheckRecord[]};
class RestoreReadBudgetError extends Error {}
const id=(s:BigIntStats)=>`${s.dev}:${s.ino}:${s.birthtimeNs}`;
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function directory(filename:string):Promise<string>{
 let current=path.parse(filename).root;for(const part of filename.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const s=await fs.lstat(current,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())throw new Error('恢复登记或暂存目录不是普通目录');}
 const actual=await fs.realpath(filename),normalize=(s:string)=>process.platform==='win32'?s.toLowerCase():s;if(normalize(actual)!==normalize(filename))throw new Error('恢复目录实际位置不符');return id(await fs.lstat(filename,{bigint:true}));
}
async function names(folder:string,max:number):Promise<string[]>{const result:string[]=[];const dir=await fs.opendir(folder);try{for await(const entry of dir){if(result.length>=max)throw new Error('恢复登记数量超过预算，原资料保留');result.push(entry.name);}}finally{await dir.close().catch(()=>{});}return result.sort();}
async function read(filename:string,max:number,budget?:{remaining:number}):Promise<Buffer>{
 const before=await fs.lstat(filename,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(max))throw new Error('恢复登记文件类型或大小无效');const fd=await fs.open(filename,'r');
 try{if(budget){if(before.size>BigInt(budget.remaining))throw new RestoreReadBudgetError('本次恢复列表达到128MiB读取预算，剩余资料未读取或删除。');budget.remaining-=Number(before.size);}if(fileObservation(await fd.stat({bigint:true}))!==fileObservation(before))throw new Error('恢复登记打开期间变化');const bytes=Buffer.alloc(Number(before.size));let at=0;while(at<bytes.length){const r=await fd.read(bytes,at,bytes.length-at,at);if(!r.bytesRead)throw new Error('恢复登记截断');at+=r.bytesRead;}const current=await fd.stat({bigint:true}),named=await fs.lstat(filename,{bigint:true});if(named.isSymbolicLink()||named.nlink!==1n||fileObservation(current)!==fileObservation(before)||fileObservation(named)!==fileObservation(before))throw new Error('恢复登记读取期间变化');return bytes;}finally{await fd.close();}
}
async function write(filename:string,bytes:Buffer):Promise<void>{const fd=await fs.open(filename,'wx',0o600);try{await fd.writeFile(bytes);await fd.sync();const a=await fd.stat({bigint:true}),b=await fs.lstat(filename,{bigint:true});if(b.isSymbolicLink()||b.nlink!==1n||a.size!==BigInt(bytes.length)||fileObservation(a)!==fileObservation(b))throw new Error('恢复登记写入身份未确认');}finally{await fd.close();}}
async function source(filename:string):Promise<RestoreFileEvidence>{const stat=await fs.lstat(filename,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n)throw new Error('备份来源须为普通单链接文件');return readRestoreFile({identity:id(stat),observation:fileObservation(stat),bytes:Number(stat.size)});}
// Reservations are conservative input-byte accounting, not a filesystem quota.
// Interrupted or unknown operations remain counted or block new staging.
export class CatalogRestoreStore {
 private readonly root:string;constructor(private readonly dataDir:string){this.root=path.join(dataDir,'backups','restore-operations');}
 private async loadReservation(value:unknown,budget?:{remaining:number}):Promise<RestoreReservation>{
  const operationId=backupUuid(value),folder=path.join(this.root,operationId);await directory(this.root);const owner=await directory(folder),children=await names(folder,4);if(!children.includes('source.json')||children.some(n=>!['source.json','data','prepared.json','checks'].includes(n)))throw new Error('恢复操作含未知或缺失登记，原资料保留');
  const raw=await read(path.join(folder,'source.json'),256*1024,budget),v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) as RestoreReservation;
  if(!v||typeof v!=='object'||Object.keys(v).length!==9||['operationId','directory','directoryIdentity','filename','source','sourceParentIdentity','parent','parentIdentity','name'].some(k=>!Object.hasOwn(v,k))||v.operationId!==operationId||v.directory!==folder||typeof v.filename!=='string'||!path.isAbsolute(v.filename)||path.resolve(v.filename)!==v.filename||v.filename.length>32767||path.extname(v.filename).toLowerCase()!=='.auralbackup'||typeof v.name!=='string'||!v.name||v.name.length>128||/[\u0000-\u001f\\/]/.test(v.name)||v.name!==path.basename(v.filename).slice(0,128)||v.parent!==path.join(folder,'data'))throw new Error('恢复来源登记内容无效');
  const result={operationId,directory:folder,directoryIdentity:readRestoreIdentity(v.directoryIdentity),filename:v.filename,source:readRestoreFile(v.source),sourceParentIdentity:readRestoreIdentity(v.sourceParentIdentity),parent:v.parent,parentIdentity:readRestoreIdentity(v.parentIdentity),name:v.name};
  if(owner!==result.directoryIdentity||await directory(result.parent)!==result.parentIdentity||!raw.equals(Buffer.from(JSON.stringify(result))))throw new Error('恢复来源规范字节或目录所有权已变化');return result;
 }
 async load(value:unknown,budget?:{remaining:number}):Promise<LoadedRestorePrepared>{
  const reservation=await this.loadReservation(value,budget),raw=await read(path.join(reservation.directory,'prepared.json'),RESTORE_FRAME_BYTES,budget),v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  if(!v||typeof v!=='object'||Object.keys(v).length!==6||['format','version','checkedAt','prepared','preview','sha256'].some(k=>!Object.hasOwn(v,k))||v.format!=='aural-restore-prepared'||v.version!==1||typeof v.checkedAt!=='string'||!Number.isFinite(Date.parse(v.checkedAt))||new Date(v.checkedAt).toISOString()!==v.checkedAt)throw new Error('恢复准备回执无效');
  const prepared=readRestorePrepared(v.prepared),preview=readRestorePreview(v.preview),body={format:'aural-restore-prepared',version:1,checkedAt:v.checkedAt,prepared,preview};
  if(v.sha256!==sha(Buffer.from(JSON.stringify(body)))||!raw.equals(Buffer.from(JSON.stringify({...body,sha256:v.sha256})))||prepared.operationId!==reservation.operationId||JSON.stringify(prepared.source)!==JSON.stringify(reservation.source)||preview.operationId!==reservation.operationId||preview.name!==reservation.name||preview.backupId!==prepared.manifest.backupId||preview.createdAt!==prepared.manifest.createdAt||preview.appVersion!==prepared.manifest.appVersion||preview.bytes!==prepared.bytes||preview.sha256!==prepared.sha256||preview.files!==prepared.manifest.files.length||JSON.stringify(preview.counts)!==JSON.stringify(prepared.manifest.counts)||preview.writebackFiles!==prepared.manifest.files.filter(f=>f.role==='writeback-artifact'||f.role==='writeback-journal').length)throw new Error('恢复准备回执与原来源及清单不符');
  if(path.dirname(prepared.stagePath)!==reservation.parent||!path.basename(prepared.stagePath).startsWith('.aural-restore-'+prepared.manifest.backupId+'-')||await directory(prepared.stagePath)!==prepared.stageIdentity||JSON.stringify(await names(reservation.parent,1))!==JSON.stringify([path.basename(prepared.stagePath)]))throw new Error('已准备暂存目录身份变化或含有未知工件');
  const preparedSha256=sha(raw),checks:CheckRecord[]=[],checkDir=path.join(reservation.directory,'checks');let checkNames:string[]=[];
  try{await directory(checkDir);checkNames=await names(checkDir,16);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  for(const name of checkNames){if(name!==String(checks.length).padStart(4,'0')+'.json')throw new Error('恢复核对回执含缺口或未知文件');const bytes=await read(path.join(checkDir,name),32768,budget),c=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   const keys=['format','version','operationId','sequence','previous','checkedAt','preparedSha256','stageIdentity','pendingValues','sha256'];if(c?.version===2)keys.push('compatibility');
   if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).length!==keys.length||keys.some(k=>!Object.hasOwn(c,k))||c.format!=='aural-restore-check'||c.version!==1&&c.version!==2||c.operationId!==reservation.operationId||c.sequence!==checks.length||c.previous!==(checks.at(-1)?.sha256??null)||c.preparedSha256!==preparedSha256||c.stageIdentity!==prepared.stageIdentity||c.pendingValues!==preview.pendingValues||typeof c.checkedAt!=='string'||!Number.isFinite(Date.parse(c.checkedAt))||new Date(c.checkedAt).toISOString()!==c.checkedAt)throw new Error('恢复核对回执身份或顺序不符');
   const compatibility=c.version===2?assertRestoreCompatibility(c.compatibility,prepared.manifest):undefined;
   const b={format:'aural-restore-check' as const,version:c.version as 1|2,operationId:reservation.operationId,sequence:checks.length,previous:checks.at(-1)?.sha256??null,checkedAt:c.checkedAt,preparedSha256,stageIdentity:prepared.stageIdentity,pendingValues:preview.pendingValues,...(compatibility?{compatibility}:{})};
   if(c.sha256!==sha(Buffer.from(JSON.stringify(b)))||!bytes.equals(Buffer.from(JSON.stringify({...b,sha256:c.sha256}))))throw new Error('恢复核对回执摘要不符');checks.push({...b,sha256:c.sha256});
  }
  if(await directory(reservation.directory)!==reservation.directoryIdentity||await directory(reservation.parent)!==reservation.parentIdentity||await directory(prepared.stagePath)!==prepared.stageIdentity)throw new Error('恢复资料在读取期间变化');return {reservation,prepared,preview,preparedSha256,checkedAt:checks.at(-1)?.checkedAt??v.checkedAt,checks};
 }
 async checked(loaded:LoadedRestorePrepared,value:unknown,pendingValues:number,report:CatalogRestoreCompatibility):Promise<CatalogRestorePreview>{
  const prepared=readRestorePrepared(value),actual=await this.load(loaded.reservation.operationId);if(actual.preparedSha256!==loaded.preparedSha256||actual.checks.length!==loaded.checks.length||actual.checks.at(-1)?.sha256!==loaded.checks.at(-1)?.sha256||JSON.stringify(prepared)!==JSON.stringify(loaded.prepared)||pendingValues!==loaded.preview.pendingValues)throw new Error('再次核对后的恢复资料与原准备证明不符');
  if(loaded.checks.length>=16)throw new Error('恢复核对回执达到16条预算，原资料已保留');const checkDir=path.join(loaded.reservation.directory,'checks');await fs.mkdir(checkDir).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});await directory(checkDir);
  const compatibility=assertRestoreCompatibility(report,prepared.manifest);if(compatibility.appVersion!==RELEASE.appVersion)throw new Error('恢复兼容性报告并非当前构建产生');
  const body={format:'aural-restore-check',version:2,operationId:loaded.reservation.operationId,sequence:loaded.checks.length,previous:loaded.checks.at(-1)?.sha256??null,checkedAt:new Date().toISOString(),preparedSha256:loaded.preparedSha256,stageIdentity:prepared.stageIdentity,pendingValues,compatibility};
  await write(path.join(checkDir,String(body.sequence).padStart(4,'0')+'.json'),Buffer.from(JSON.stringify({...body,sha256:sha(Buffer.from(JSON.stringify(body)))})));return loaded.preview;
 }
 async list():Promise<CatalogRestoreHistory>{
  let opNames:string[];try{await directory(this.root);opNames=await names(this.root,64);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {entries:[],notice:''};return {entries:[],notice:String(e instanceof Error?e.message:e).slice(0,1024)};}
  const entries:CatalogRestoreHistoryEntry[]=[],budget={remaining:128*1024*1024};let notice='',unknown=0;
  for(const operationId of opNames){try{backupUuid(operationId);}catch{unknown++;continue;}
   try{const r=await this.loadReservation(operationId,budget),children=await names(r.directory,4);if(!children.includes('prepared.json')){entries.push({operationId,name:r.name,status:'interrupted',checkedAt:'',message:'原操作没有完整准备回执，暂存资料保留，不能据文件名使用。',preview:null});continue;}
    const loaded=await this.load(operationId,budget),compatible=loaded.checks.at(-1)?.compatibility;entries.push({operationId,name:loaded.preview.name,status:loaded.checks.length?'checked':'prepared',checkedAt:loaded.checkedAt,message:compatible?'此前已核对数据库结构及部分设置；使用前须按当前版本重新检查。':'记录只代表当时内容校验；使用前须补充当前版本的兼容性检查。',preview:loaded.preview});
   }catch(e){if(e instanceof RestoreReadBudgetError){notice=e.message;break;}entries.push({operationId,name:'',status:'invalid',checkedAt:'',message:String(e instanceof Error?e.message:e).slice(0,1024),preview:null});}
  }
  entries.sort((a,b)=>b.checkedAt.localeCompare(a.checkedAt)||a.operationId.localeCompare(b.operationId));return readRestoreHistory({entries,notice:(notice+(unknown?` ${unknown} 项未知目录已保留，未采用。`:'')).trim()});
 }
 private async reservationBytes():Promise<number>{
  let total=0;for(const opId of await names(this.root,64)){
   const reservation=await this.loadReservation(opId);total+=reservation.source.bytes;if(!Number.isSafeInteger(total)||total>128*1024**3)throw new Error('恢复暂存保留预算已超过128GiB');
  }return total;
 }
 async begin(value:unknown,filename:string):Promise<RestoreReservation>{
  const operationId=backupUuid(value);if(!path.isAbsolute(filename)||path.resolve(filename)!==filename||filename.length>32767||path.extname(filename).toLowerCase()!=='.auralbackup')throw new Error('请选择 .auralbackup 文件');
  const name=path.basename(filename).slice(0,128);if(!name||/[\u0000-\u001f\\/]/.test(name))throw new Error('备份文件名称无效');
  const sourceParentIdentity=await directory(path.dirname(filename)),evidence=await source(filename);if(evidence.bytes<52)throw new Error('备份文件长度无效');
  await directory(this.dataDir);const backups=path.dirname(this.root);await fs.mkdir(backups).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});await directory(backups);await fs.mkdir(this.root).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});await directory(this.root);
  if((await names(this.root,64)).length>=64)throw new Error('恢复预览已达64项保留预算，未创建新暂存');if(await this.reservationBytes()+evidence.bytes>128*1024**3)throw new Error('恢复暂存保留预算不足，原资料未删除');
  const free=await fs.statfs(this.root,{bigint:true});if(free.bavail*free.bsize<BigInt(evidence.bytes)+64n*1024n*1024n)throw new Error('恢复暂存位置可用空间不足');
  const folder=path.join(this.root,operationId);await fs.mkdir(folder,{mode:0o700});const directoryIdentity=await directory(folder),parent=path.join(folder,'data');await fs.mkdir(parent,{mode:0o700});const parentIdentity=await directory(parent);
  const result={operationId,directory:folder,directoryIdentity,filename,source:evidence,sourceParentIdentity,parent,parentIdentity,name};await write(path.join(folder,'source.json'),Buffer.from(JSON.stringify(result)));return result;
 }
 async complete(reservation:RestoreReservation,value:unknown,pendingValues:number,report:CatalogRestoreCompatibility):Promise<CatalogRestorePreview>{
  const prepared=readRestorePrepared(value);if(prepared.operationId!==reservation.operationId||JSON.stringify(prepared.source)!==JSON.stringify(reservation.source)||path.dirname(prepared.stagePath)!==reservation.parent||!path.basename(prepared.stagePath).startsWith('.aural-restore-'+prepared.manifest.backupId+'-'))throw new Error('恢复暂存证明与原来源登记不符');
  if(await directory(reservation.directory)!==reservation.directoryIdentity||await directory(reservation.parent)!==reservation.parentIdentity||await directory(prepared.stagePath)!==prepared.stageIdentity||await directory(path.dirname(reservation.filename))!==reservation.sourceParentIdentity||JSON.stringify(await source(reservation.filename))!==JSON.stringify(reservation.source))throw new Error('恢复暂存或来源在进程退出后变化');
  const raw=await read(path.join(reservation.directory,'source.json'),256*1024);if(!raw.equals(Buffer.from(JSON.stringify(reservation))))throw new Error('恢复原来源意图已变化');
  const preview=readRestorePreview({operationId:prepared.operationId,name:reservation.name,backupId:prepared.manifest.backupId,createdAt:prepared.manifest.createdAt,appVersion:prepared.manifest.appVersion,schema:prepared.manifest.schema,counts:prepared.manifest.counts,files:prepared.manifest.files.length,bytes:prepared.bytes,sha256:prepared.sha256,pendingValues,writebackFiles:prepared.manifest.files.filter(f=>f.role==='writeback-journal'||f.role==='writeback-artifact').length});
  assertRestoreCompatibility(report,prepared.manifest);if(report.appVersion!==RELEASE.appVersion)throw new Error('恢复兼容性报告并非当前构建产生');
  const body={format:'aural-restore-prepared',version:1,checkedAt:new Date().toISOString(),prepared,preview},bytes=Buffer.from(JSON.stringify(body));await write(path.join(reservation.directory,'prepared.json'),Buffer.from(JSON.stringify({...body,sha256:sha(bytes)})));
  return this.checked(await this.load(reservation.operationId),prepared,pendingValues,report);
 }
}
