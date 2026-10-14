import {promises as fs,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {backupUuid} from '../shared/catalog-backup.js';
import {CatalogDirectoryMoveJournal,directoryMovePaths} from './catalog-directory-move-journal.js';
import type {DirectoryMoveAction,DirectoryMoveSlot} from '../shared/catalog-directory-move.js';
import {CatalogRestoreTransactionStore,type LoadedRestoreTransaction} from './catalog-restore-transaction-store.js';
import {readRestoreCompleted,orderCompletedLineage,type RestoreCompleted} from '../platform/catalog-restore-completion.js';
import {planRestoreLineage,type RestoreLineageRow,type RestoreOpening} from './catalog-restore-lineage.js';
import {readNormalLibraryPermission,type NormalLibraryPermission} from '../shared/catalog-normal-open.js';
import type {RestoreRecoveryRecord} from '../shared/catalog-restore-recovery.js';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';

const identity=(stat:BigIntStats)=>`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
type SlotObservation={slot:DirectoryMoveSlot;identity:string|null};
type MoveObservation={operationId:string;action:DirectoryMoveAction;stages:number;recordedExit:boolean;namespace:'before'|'after'|'source-reoccupied'|'conflict'};
export type RestoreStartupTransaction={transactionId:string;record:RestoreRecoveryRecord|null;slots:SlotObservation[];moves:MoveObservation[];error:string|null;opening:RestoreOpening};
export type RestoreStartupInspection={transactions:RestoreStartupTransaction[];safeToOpen:boolean;permission:NormalLibraryPermission|null};
export class RestoreStartupBlocked extends Error{constructor(message:string,readonly inspection:RestoreStartupInspection|null){super(message);this.name='RestoreStartupBlocked';}}

// Read-only namespace observations. No database open, migrations, directory
// adoption, automatic replay, cleanup or inference of a successful new boot.
async function directory(filename:string,optional=false):Promise<string|null>{
 if(!path.isAbsolute(filename)||path.resolve(filename)!==filename)throw new Error('曲库恢复登记位置无效');
 let current=path.parse(filename).root;
 for(const part of filename.slice(current.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);const stat=await fs.lstat(current,{bigint:true}).catch((error:NodeJS.ErrnoException)=>{if(optional&&error.code==='ENOENT')return null;throw error;});
  if(!stat)return null;if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('曲库恢复登记含链接或非目录');
 }
 const first=await fs.lstat(filename,{bigint:true});
 if((await fs.realpath(filename)).toLowerCase()!==filename.toLowerCase())throw new Error('曲库恢复登记实际位置不同');
 const last=await fs.lstat(filename,{bigint:true});if(!last.isDirectory()||last.isSymbolicLink()||identity(first)!==identity(last))throw new Error('曲库恢复目录观察期间变化');return identity(last);
}
async function entries(folder:string,max:number):Promise<string[]>{
 const values:string[]=[],handle=await fs.opendir(folder);
 try{for await(const entry of handle){if(values.length>=max)throw new Error('曲库恢复登记超过保留预算');values.push(entry.name);}}
 finally{await handle.close().catch(()=>{});}return values.sort();
}
const sameNames=(a:string[],b:string[])=>a.length===b.length&&a.every((value,index)=>value===b[index]);
const errorText=(error:unknown)=>String(error instanceof Error?error.message:error).slice(0,512);

async function inspect(userData:string,prospective?:RestoreCompleted,check:()=>void=()=>{}):Promise<RestoreStartupInspection>{
 check();
 const root=path.join(userData,'backups','restore-transactions'),rootIdentity=await directory(root,true);
 if(rootIdentity===null)return {transactions:[],safeToOpen:true,permission:null};
 const children=await entries(root,64),transactions:RestoreStartupTransaction[]=[],rows:RestoreLineageRow[]=[];let permission:NormalLibraryPermission|null=null;
 for(const name of children){
  check();
  const transaction:RestoreStartupTransaction={transactionId:name,record:null,slots:[],moves:[],error:null,opening:'blocked'};transactions.push(transaction);
  try{
   const transactionId=backupUuid(name),folder=path.join(root,transactionId),folderIdentity=await directory(folder),data=path.join(folder,'data'),candidate=path.join(data,'candidate');
   // A missing slot is evidence about this observation only, never permission
   // to create an empty live library or choose a rollback direction.
   const slots:Record<DirectoryMoveSlot,string>={live:path.join(userData,'library'),candidate:path.join(candidate,'library'),original:path.join(data,'original-library'),'retired-candidate':path.join(data,'retired-candidate')};
   for(const slot of ['live','candidate','original','retired-candidate'] as const)transaction.slots.push({slot,identity:await directory(slots[slot],true)});
   const moves=path.join(folder,'moves'),movesIdentity=await directory(moves,true),names=movesIdentity===null?[]:await entries(moves,16);
   for(const name of names){
    const operationId=backupUuid(name),loaded=await CatalogDirectoryMoveJournal.reopen(userData,transactionId,operationId),locations=directoryMovePaths(loaded.request);
    const source=await directory(locations.source,true),target=await directory(locations.target,true),expected=loaded.request.sourceIdentity;
    const namespace=source===expected&&target===null?'before':source===null&&target===expected?'after':source!==null&&source!==expected&&target===expected?'source-reoccupied':'conflict';
    transaction.moves.push({operationId,action:loaded.request.action,stages:loaded.stages.length,recordedExit:loaded.completed,namespace});
   }
   if(movesIdentity!==null&&(await directory(moves)!==movesIdentity||!sameNames(names,await entries(moves,16))))throw new Error('目录切换登记在启动核对期间变化');
   if(await directory(folder)!==folderIdentity)throw new Error('曲库恢复事务目录在启动核对期间变化');
   for(const observed of transaction.slots)if(await directory(slots[observed.slot],true)!==observed.identity)throw new Error('曲库恢复槽位在启动核对期间变化');
   const store=new CatalogRestoreTransactionStore(userData),global=await store.load(transactionId);check();
   transaction.record={version:global.intent.version,sourceId:global.intent.source.operationId,records:global.records.length,lastKind:global.records.at(-1)?.kind??null,acceptedAt:global.intent.consent?.acceptedAt??null,completed:Boolean(global.cutover.completed)};
   let completed=global.cutover.completed;
   if(prospective?.operationId===transactionId){
    const final=global.cutover.finalization?.proof,seal=global.cutover.commit?.seal,ready=global.cutover.commit?.proof,last=global.records.at(-1);
    if(completed||!final||!seal||!ready||last?.kind!=='final-resources-held'||last.sha256!==prospective.finalRecordSha256)throw new Error('当前完成准备不是原最终资源记录');
    completed=readRestoreCompleted(prospective,global.intent,seal,ready,final,last.sha256);
   }
   rows.push({transactionId,previousIdentity:global.intent.liveIdentity,candidateIdentity:global.candidate?.libraryIdentity??null,completed:completed?{completed,recordSha256:global.lastSha256}:null,lastSha256:global.lastSha256,nativeMoves:names.length,globalMoves:global.cutover.moves.length,allMovesCompleted:global.cutover.moves.every(move=>Boolean(move.completion)),installed:global.cutover.moves.some(move=>move.request.action==='install-candidate'&&move.completion),slots:Object.fromEntries(transaction.slots.map(slot=>[slot.slot,slot.identity])) as RestoreLineageRow['slots']});
  }catch(error){transaction.error=errorText(error);}
 }
 if(!transactions.some(transaction=>transaction.error))try{
  if(prospective&&!rows.some(row=>row.transactionId===prospective.operationId))throw new Error('恢复完成准备的原事务不存在');
  if(rows.length){const plan=planRestoreLineage(userData,rows);if(plan.head)permission=readNormalLibraryPermission({version:1,completionId:plan.head.completed.completionId,recordSha256:plan.head.recordSha256,libraryIdentity:plan.head.completed.libraryIdentity,origin:plan.head.completed.origin});for(const [expected,filename] of plan.locations)if(await directory(filename)!==expected)throw new Error('恢复完成链的实际保留目录或当前目录不同');
   // Re-read each original canonical chain, one at a time. Do not retain up to
   // 64 full payload histories in memory or trust only a directory timestamp.
   const store=new CatalogRestoreTransactionStore(userData);for(const row of rows){check();const again=await store.load(row.transactionId);check();if(again.lastSha256!==row.lastSha256)throw new Error('恢复全局记录在启动核对期间变化');
    const data=path.join(root,row.transactionId,'data'),slots:Record<DirectoryMoveSlot,string>={live:path.join(userData,'library'),candidate:path.join(data,'candidate','library'),original:path.join(data,'original-library'),'retired-candidate':path.join(data,'retired-candidate')};
    for(const slot of Object.keys(slots) as DirectoryMoveSlot[])if(await directory(slots[slot],true)!==row.slots[slot])throw new Error('恢复完成关系核对期间目录变化');
   }
   for(const transaction of transactions)transaction.opening=plan.openings.get(transaction.transactionId)!;
  }
 }catch(error){for(const transaction of transactions){transaction.opening='blocked';transaction.error??=errorText(error);}}
 if(await directory(root)!==rootIdentity||!sameNames(children,await entries(root,64)))throw new Error('曲库恢复根在启动核对期间变化');
 check();return {transactions,safeToOpen:transactions.every(transaction=>transaction.error===null&&transaction.opening!=='blocked'),permission};
}
export function inspectCatalogRestoreStartup(userData:string,check:()=>void=()=>{}):Promise<RestoreStartupInspection>{return inspect(userData,undefined,check);}
export async function prepareCatalogRestoreCompleted(userData:string,input:LoadedRestoreTransaction,check:()=>void):Promise<RestoreCompleted>{
 check();const store=new CatalogRestoreTransactionStore(userData),current=await store.load(input.intent.transactionId);check();const seal=current.cutover.commit?.seal,ready=current.cutover.commit?.proof,final=current.cutover.finalization?.proof,last=current.records.at(-1);
 if(current.lastSha256!==input.lastSha256||current.cutover.completed||!seal||!ready||!final||last?.kind!=='final-resources-held')throw new Error('恢复完成缺少当前最终资源证明');
 const root=path.join(userData,'backups','restore-transactions'),rootIdentity=await directory(root),children=await entries(root,64),completed=[];
 for(const transactionId of children){check();if(transactionId===current.intent.transactionId)continue;const prior=await store.load(transactionId);check();if(prior.cutover.completed)completed.push({completed:prior.cutover.completed,recordSha256:prior.lastSha256});}
 const previous=orderCompletedLineage(completed).at(-1);if(previous&&previous.completed.libraryIdentity!==current.intent.liveIdentity)throw new Error('当前恢复原曲库不是已完成链的末端');
 const certificate=readRestoreCompleted({version:1,operationId:current.intent.transactionId,completionId:seal.completionId,role:seal.role,libraryIdentity:seal.libraryIdentity,previousLibraryIdentity:current.intent.liveIdentity,origin:ready.origin,sealSha256:lifecycleDigest(seal),finalProofSha256:lifecycleDigest(final),finalRecordSha256:last.sha256,completedAt:new Date().toISOString(),parent:previous?{transactionId:previous.completed.operationId,completionId:previous.completed.completionId,recordSha256:previous.recordSha256,libraryIdentity:previous.completed.libraryIdentity}:null,inputHeldAtCommit:true,restartPolicy:'normal-existing-library'},current.intent,seal,ready,final,last.sha256);
 if(await directory(root)!==rootIdentity||!sameNames(children,await entries(root,64)))throw new Error('恢复完成前驱登记在核对期间变化');check();const projected=await inspect(userData,certificate,check);check();if(!projected.safeToOpen)throw new Error('恢复完成前目录或历史事务未获独立核对：'+projected.transactions.find(transaction=>transaction.error)?.error);return certificate;
}
export async function assertCatalogRestoreStartupSafe(userData:string,check:()=>void=()=>{}):Promise<NormalLibraryPermission|null>{
 let result:RestoreStartupInspection;try{result=await inspect(userData,undefined,check);}catch(error){throw new RestoreStartupBlocked('恢复登记读取未完成：'+errorText(error),null);}
 if(!result.safeToOpen){const blocked=result.transactions.filter(transaction=>transaction.error!==null||transaction.opening==='blocked'),uncertain=blocked.some(transaction=>transaction.error!==null||transaction.moves.some(move=>move.namespace==='conflict'));
  throw new RestoreStartupBlocked(`检测到 ${blocked.length} 项未决或无法核对的整库恢复登记${uncertain?'，其中包含无法确认的记录或目录状态':''}。完成证书、历史关系或实际目录尚未获得一致确认，已保留原库和候选资料并停止打开曲库。需要完成恢复核对后再启动；请勿自行删除这些资料。`,result);
 }return result.permission;
}
