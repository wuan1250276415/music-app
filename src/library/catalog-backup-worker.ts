import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileObservation} from '../platform/file-observation.js';
import {packCatalogBackup,verifyCatalogBackupFile} from '../platform/catalog-backup-file.js';
import {backupUuid,readCatalogBackupManifest} from '../shared/catalog-backup.js';
import {BACKUP_WORKER_FRAME_BYTES,type BackupWorkerFrame} from '../shared/catalog-backup-worker.js';
type Port={on:(event:'message',listener:(event:{data:unknown})=>void)=>void;postMessage:(value:BackupWorkerFrame)=>void};
const port=(process as typeof process&{parentPort?:Port}).parentPort;if(!port)throw new Error('备份须由独立受监督进程启动');
let begun=false,operationId='',sequence=0;const abort=new AbortController();
let complete:{sequence:number;resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}|null=null;
function send(frame:BackupWorkerFrame):void{if(Buffer.byteLength(JSON.stringify(frame),'utf8')>BACKUP_WORKER_FRAME_BYTES)throw new Error('备份进程消息超过预算');port!.postMessage(frame);}
async function run(value:Record<string,unknown>):Promise<void>{
 if(Object.keys(value).length!==6||(value.mode!=='pack'&&value.mode!=='verify')||typeof value.root!=='string'||!path.isAbsolute(value.root)||typeof value.output!=='string'||!path.isAbsolute(value.output))throw new Error('备份进程启动参数无效');
 operationId=backupUuid(value.operationId);const manifest=readCatalogBackupManifest(value.manifest);if(manifest.backupId!==operationId)throw new Error('备份来源身份不符');
 const options={signal:abort.signal,progress:(v:{phase:string;bytes:number;total:number})=>{if(v.phase==='packing'||v.phase==='verifying')send({operationId,sequence:sequence++,kind:'progress',phase:v.phase,bytes:v.bytes,total:v.total});}};
 const before=value.mode==='verify'?await fs.lstat(value.output,{bigint:true}):null;
 const packed=value.mode==='pack'?await packCatalogBackup(value.root,value.output,manifest,options):null;abort.signal.throwIfAborted();
 const verified=await verifyCatalogBackupFile(value.output,options);abort.signal.throwIfAborted();
 const stat=await fs.lstat(value.output,{bigint:true});
 if(packed?(packed.sha256!==verified.sha256||packed.bytes!==verified.bytes||JSON.stringify(packed.manifest)!==JSON.stringify(verified.manifest)||packed.identity!==`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`||packed.observation!==fileObservation(stat)):!before||fileObservation(before)!==fileObservation(stat))throw new Error('独立复核后的备份与已写入文件不符');
 const result=packed??{...verified,identity:`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,observation:fileObservation(stat)};
 const frame:BackupWorkerFrame={operationId,sequence:sequence++,kind:'done',result};
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{complete=null;reject(new Error('备份完成回执未获确认'));},15000);complete={sequence:frame.sequence,resolve,reject,timer};send(frame);});
 process.exit(0);
}
port.on('message',event=>{
 const v=event.data as Record<string,unknown>;if(!v||typeof v!=='object'||Array.isArray(v))return;
 if(!begun&&v.kind==='begin'){begun=true;void run(v).catch(error=>{try{send({operationId,sequence:sequence++,kind:'error',message:String(error instanceof Error?error.message:error).slice(0,1024)||'备份进程失败'});}finally{process.exit(1);}});}
 else if(v.operationId===operationId&&v.kind==='ack'&&Object.keys(v).length===3&&complete&&v.sequence===complete.sequence){const pending=complete;complete=null;clearTimeout(pending.timer);pending.resolve();}
 else if(v.operationId===operationId&&v.kind==='cancel'&&Object.keys(v).length===2){abort.abort(new Error('备份已取消'));if(complete){const pending=complete;complete=null;clearTimeout(pending.timer);pending.reject(new Error('备份已取消'));}}
});
