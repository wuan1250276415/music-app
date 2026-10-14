import path from 'node:path';
import {cloneCatalogBackupTree,inventoryCatalogBackupTree,readCatalogBackupPendingSnapshot} from '../platform/catalog-backup-file.js';
import {CatalogRestoreTransactionStore,restoreTransactionDirectory} from '../main/catalog-restore-transaction-store.js';
import {CatalogRestoreCompatibilityInspector} from './catalog-restore-compatibility.js';
import {backupUuid,readCatalogBackupManifest} from '../shared/catalog-backup.js';
import {readRestoreCandidateProof,readRestoreRollbackProof,restoreTransactionFields,RESTORE_TRANSACTION_FRAME_BYTES,type RestorePreparationFrame} from '../shared/catalog-restore-transaction.js';
import {RELEASE} from '../shared/release.js';

type Port={on:(event:'message',listener:(event:{data:unknown})=>void)=>void;postMessage:(value:RestorePreparationFrame)=>void};
const port=(process as typeof process&{parentPort?:Port}).parentPort;if(!port)throw new Error('恢复准备须由独立受监督进程启动');
let started=false,transactionId='',sequence=0,lastProgress=0;const abort=new AbortController();let ack:{sequence:number;resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}|null=null;
function send(value:RestorePreparationFrame):void{if(Buffer.byteLength(JSON.stringify(value))>RESTORE_TRANSACTION_FRAME_BYTES)throw new Error('恢复准备消息超过预算');port!.postMessage(value);}
async function done(value:RestorePreparationFrame):Promise<void>{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{ack=null;reject(new Error('恢复准备完成回执未确认'));},15000);ack={sequence:value.sequence,resolve,reject,timer};send(value);});process.exit(0);}
async function run(value:unknown):Promise<void>{
 const v=value as Record<string,unknown>;if(!v||v.kind!=='begin'||v.mode!=='candidate'&&v.mode!=='rollback'||typeof v.userData!=='string'||!path.isAbsolute(v.userData)||path.resolve(v.userData)!==v.userData)throw new Error('恢复准备启动参数无效');
 restoreTransactionFields(v,v.mode==='candidate'?['kind','mode','transactionId','userData']:['kind','mode','transactionId','userData','snapshot']);transactionId=backupUuid(v.transactionId);
 const store=new CatalogRestoreTransactionStore(v.userData),loaded=await store.load(transactionId),p=store.paths(transactionId);if(loaded.aborted||!await store.noMoves(transactionId)||await restoreTransactionDirectory(p.live)!==loaded.intent.liveIdentity)throw new Error('原曲库已变化、已有切换登记或恢复事务已终止');
 const inspector=new CatalogRestoreCompatibilityInspector(),options={signal:abort.signal,progress:(progress:{bytes:number;total:number})=>{if(Date.now()-lastProgress<100&&progress.bytes!==progress.total)return;lastProgress=Date.now();send({transactionId,sequence:sequence++,kind:'progress',bytes:progress.bytes,total:progress.total});}};
 if(v.mode==='candidate'){
  if(loaded.records.length)throw new Error('候选复制不能再次执行');await cloneCatalogBackupTree(loaded.source.prepared.stagePath,p.candidate,loaded.source.prepared.manifest,options);abort.signal.throwIfAborted();
  const compatibility=inspector.inspect(path.join(p.candidate,'library','library.db'),loaded.source.prepared.manifest,abort.signal);await readCatalogBackupPendingSnapshot(p.candidate,loaded.source.prepared.manifest,options);
  const files=await inventoryCatalogBackupTree(p.candidate,options);if(JSON.stringify(files)!==JSON.stringify(loaded.source.prepared.manifest.files))throw new Error('候选库兼容性检查后的完整内容不同');
  await store.roots(loaded.intent);const result=readRestoreCandidateProof({transactionId,candidateIdentity:await restoreTransactionDirectory(p.candidate),libraryIdentity:await restoreTransactionDirectory(path.join(p.candidate,'library')),files:files.length,bytes:files.reduce((sum,file)=>sum+file.bytes,0),compatibility},loaded.source.prepared.manifest);
  if(result.candidateIdentity!==loaded.intent.candidateIdentity||await restoreTransactionDirectory(p.live)!==loaded.intent.liveIdentity)throw new Error('候选准备期间原目录身份变化');abort.signal.throwIfAborted();await done({transactionId,sequence:sequence++,kind:'candidate',result});
 }else{
  if(!loaded.candidate||loaded.records.length!==1)throw new Error('恢复前快照核对缺少原候选准备回执');const snapshot=restoreTransactionFields(v.snapshot,['stagePath','manifest']),manifest=readCatalogBackupManifest(snapshot.manifest);
  if(typeof snapshot.stagePath!=='string'||path.dirname(snapshot.stagePath)!==path.join(v.userData,'backups','catalog')||!path.basename(snapshot.stagePath).startsWith('.aural-backup-'+transactionId+'-')||manifest.backupId!==transactionId||manifest.appVersion!==RELEASE.appVersion)throw new Error('恢复前一致快照不属于当前私有操作及构建');
  const stageIdentity=await restoreTransactionDirectory(snapshot.stagePath),compatibility=inspector.inspect(path.join(snapshot.stagePath,'library','library.db'),manifest,abort.signal);await readCatalogBackupPendingSnapshot(snapshot.stagePath,manifest,options);
  if(JSON.stringify(await inventoryCatalogBackupTree(snapshot.stagePath,options))!==JSON.stringify(manifest.files))throw new Error('恢复前一致快照完整摘要不同');await store.roots(loaded.intent);if(await restoreTransactionDirectory(snapshot.stagePath)!==stageIdentity||await restoreTransactionDirectory(p.live)!==loaded.intent.liveIdentity)throw new Error('恢复前一致快照或原曲库身份变化');
  abort.signal.throwIfAborted();const result=readRestoreRollbackProof({transactionId,stagePath:snapshot.stagePath,stageIdentity,liveIdentity:loaded.intent.liveIdentity,manifest,compatibility});await done({transactionId,sequence:sequence++,kind:'rollback',result});
 }
}
port.on('message',event=>{const value=event.data as Record<string,unknown>;if(!value||typeof value!=='object'||Array.isArray(value))return;
 if(!started&&value.kind==='begin'){started=true;void run(value).catch(error=>{try{if(transactionId)send({transactionId,sequence:sequence++,kind:'error',message:String(error instanceof Error?error.message:error).slice(0,1024)||'恢复准备失败'});}finally{process.exit(1);}});}
 else if(value.kind==='ack'&&Object.keys(value).length===3&&value.transactionId===transactionId&&value.sequence===ack?.sequence&&ack){const current=ack;ack=null;clearTimeout(current.timer);current.resolve();}
 else if(value.kind==='cancel'&&Object.keys(value).length===2&&value.transactionId===transactionId){abort.abort(new Error('恢复准备已中断'));if(ack){const current=ack;ack=null;clearTimeout(current.timer);current.reject(new Error('恢复准备已中断'));}}
});
