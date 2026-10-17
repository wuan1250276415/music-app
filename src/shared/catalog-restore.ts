import {backupUuid,readBackupCounts,readCatalogBackupManifest,type BackupCounts,type CatalogBackupManifest,CATALOG_BACKUP_MAX_MANIFEST} from './catalog-backup.js';
import {assertRestoreCompatibility,type CatalogRestoreCompatibility} from './catalog-restore-compatibility.js';
import {RELEASE} from './release.js';
import {bindRestoreReviewEvidence,type RestoreReviewEvidence} from './catalog-restore-review.js';
export const RESTORE_FRAME_BYTES=CATALOG_BACKUP_MAX_MANIFEST+256*1024;
export type RestoreFileEvidence={identity:string;observation:string;bytes:number};
export type CatalogRestorePrepared={operationId:string;manifest:CatalogBackupManifest;stagePath:string;stageIdentity:string;source:RestoreFileEvidence;bytes:number;sha256:string};
export type CatalogRestorePreview={operationId:string;name:string;backupId:string;createdAt:string;appVersion:string;schema:68|69|70|71|72|73|74|75|76|77|78|79|80|81|82|83|84|85;counts:BackupCounts;files:number;bytes:number;sha256:string;pendingValues:number;writebackFiles:number};
export type CatalogRestoreState={operationId:string|null;phase:'idle'|'choosing'|'verifying'|'staging'|'inspecting'|'ready'|'failed'|'cancelled';bytes:number;total:number;message:string;preview:CatalogRestorePreview|null;cancelRequested:boolean};
export type RestoreWorkerFrame={operationId:string;sequence:number}&({kind:'progress';phase:'verifying'|'staging'|'inspecting';bytes:number;total:number}|{kind:'done';result:CatalogRestorePrepared;pendingValues:number;compatibility:CatalogRestoreCompatibility;review:RestoreReviewEvidence}|{kind:'error';message:string});
const max=64*1024**3+CATALOG_BACKUP_MAX_MANIFEST+52;
function fields(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new Error('恢复消息字段无效');return v as Record<string,unknown>;}
function count(v:unknown,limit=max):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>limit)throw new Error('恢复数量无效或超过预算');return v;}
function hash(v:unknown):string{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw new Error('恢复摘要无效');return v;}
export function readRestoreIdentity(v:unknown):string{if(typeof v!=='string'||v.length>256||!/^\d+:\d+:-?\d+$/.test(v))throw new Error('恢复文件身份无效');return v;}
export function readRestoreFile(value:unknown):RestoreFileEvidence{const v=fields(value,['identity','observation','bytes']);return {identity:readRestoreIdentity(v.identity),observation:hash(v.observation),bytes:count(v.bytes)};}
export function readRestorePrepared(value:unknown):CatalogRestorePrepared{
 const v=fields(value,['operationId','manifest','stagePath','stageIdentity','source','bytes','sha256']),manifest=readCatalogBackupManifest(v.manifest),bytes=count(v.bytes),source=readRestoreFile(v.source);
 if(typeof v.stagePath!=='string'||!v.stagePath||v.stagePath.length>32767||v.stagePath.includes('\0')||bytes!==source.bytes||bytes!==12+new TextEncoder().encode(JSON.stringify(manifest)).byteLength+manifest.files.reduce((n,f)=>n+f.bytes,0)+40)throw new Error('恢复暂存证明不完整');
 return {operationId:backupUuid(v.operationId),manifest,stagePath:v.stagePath,stageIdentity:readRestoreIdentity(v.stageIdentity),source,bytes,sha256:hash(v.sha256)};
}
export function readRestorePreview(value:unknown):CatalogRestorePreview{
 const v=fields(value,['operationId','name','backupId','createdAt','appVersion','schema','counts','files','bytes','sha256','pendingValues','writebackFiles']);
 if(typeof v.name!=='string'||!v.name||v.name.length>128||/[\u0000-\u001f\\/]/.test(v.name)||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt))||new Date(v.createdAt).toISOString()!==v.createdAt||typeof v.appVersion!=='string'||v.appVersion.length>64||!/^\d+\.\d+\.\d+$/.test(v.appVersion)||(v.schema!==68&&v.schema!==69&&v.schema!==70&&v.schema!==71&&v.schema!==72&&v.schema!==73&&v.schema!==74&&v.schema!==75&&v.schema!==76&&v.schema!==77&&v.schema!==78&&v.schema!==79&&v.schema!==80&&v.schema!==81&&v.schema!==82&&v.schema!==83&&v.schema!==84&&v.schema!==85))throw new Error('恢复预览资料无效');
 return {operationId:backupUuid(v.operationId),name:v.name,backupId:backupUuid(v.backupId),createdAt:v.createdAt,appVersion:v.appVersion,schema:v.schema as 68|69|70|71|72|73|74|75|76|77|78|79|80|81|82|83|84|85,counts:readBackupCounts(v.counts),files:count(v.files,8192),bytes:count(v.bytes),sha256:hash(v.sha256),pendingValues:count(v.pendingValues,128),writebackFiles:count(v.writebackFiles,8192)};
}
export function readRestoreState(value:unknown):CatalogRestoreState{
 const v=fields(value,['operationId','phase','bytes','total','message','preview','cancelRequested']);if(typeof v.phase!=='string'||!['idle','choosing','verifying','staging','inspecting','ready','failed','cancelled'].includes(v.phase)||typeof v.message!=='string'||v.message.length>1024||typeof v.cancelRequested!=='boolean')throw new Error('恢复任务状态无效');
 const bytes=count(v.bytes),total=count(v.total),preview=v.preview===null?null:readRestorePreview(v.preview),operationId=v.operationId===null?null:backupUuid(v.operationId);
 if(bytes>total||v.phase==='idle'&&operationId!==null||v.phase!=='idle'&&!operationId||v.phase==='ready'&&(!preview||preview.operationId!==operationId))throw new Error('恢复任务结果不符');return {operationId,phase:v.phase as CatalogRestoreState['phase'],bytes,total,message:v.message,preview,cancelRequested:v.cancelRequested};
}
export function readRestoreFrame(value:unknown):RestoreWorkerFrame{
 const raw=value as RestoreWorkerFrame;if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('恢复进程消息无效');backupUuid(raw.operationId);count(raw.sequence,1000000);
 if(raw.kind==='progress'){fields(raw,['operationId','sequence','kind','phase','bytes','total']);if(!['verifying','staging','inspecting'].includes(raw.phase)||count(raw.bytes)>count(raw.total))throw new Error('恢复进程进度无效');return raw;}
 if(raw.kind==='done'){fields(raw,['operationId','sequence','kind','result','pendingValues','compatibility','review']);const result=readRestorePrepared(raw.result),compatibility=assertRestoreCompatibility(raw.compatibility,result.manifest);if(result.operationId!==raw.operationId||compatibility.appVersion!==RELEASE.appVersion)throw new Error('恢复进程结果身份或构建版本无效');return {...raw,result,pendingValues:count(raw.pendingValues,128),compatibility,review:bindRestoreReviewEvidence(raw.review,result.manifest,count(raw.pendingValues,128))};}
 if(raw.kind==='error'){fields(raw,['operationId','sequence','kind','message']);if(typeof raw.message!=='string'||!raw.message||raw.message.length>1024)throw new Error('恢复进程错误无效');return raw;}
 throw new Error('恢复进程消息类型无效');
}
