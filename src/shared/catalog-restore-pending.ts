import {backupUuid,readRendererPendingSnapshot,type RendererPendingSnapshot,type CatalogBackupManifest} from './catalog-backup.js';
import {readRestoreIdentity} from './catalog-restore.js';
import {restoreTransactionFields as fields,restoreTransactionDigest,restoreTransactionCount} from './catalog-restore-transaction.js';

export const RESTORE_PENDING_NAMES=['candidate-history.json','candidate-renderer.json','original-history.json','original-renderer.json'] as const;
export type RestorePendingFile={name:typeof RESTORE_PENDING_NAMES[number];bytes:number;sha256:string};
export type RestorePendingIntent={version:1;operationId:string;activationId:string;challenge:string;role:'candidate'|'original';directoryIdentity:string;originalManifestSha256:string;candidateManifestSha256:string;originalValuesSha256:string;files:RestorePendingFile[]};
export type RestorePendingRequest={version:1;operationId:string;activationId:string;challenge:string;archiveSha256:string;role:'candidate'|'original';original:RendererPendingSnapshot};
export type RestorePendingReply={version:1;operationId:string;activationId:string;challenge:string;archiveSha256:string;originalSha256:string;resultSha256:string|null;cleared:boolean;error:string};
export type RestorePendingSettled={archiveSha256:string;rendererReplySha256:string;historyBeforeSha256:string;historyAfterSha256:string;historyReset:boolean};
export function pendingFiles(original:CatalogBackupManifest,candidate:CatalogBackupManifest):RestorePendingFile[]{
 const result:RestorePendingFile[]=[];
 for(const [side,manifest] of [['original',original],['candidate',candidate]] as const){
  for(const kind of ['renderer','history'] as const){const source=manifest.files.find(f=>f.role===kind+'-pending');if(source)result.push({name:(side+'-'+kind+'.json') as RestorePendingFile['name'],bytes:source.bytes,sha256:source.sha256});else if(kind==='renderer')throw new Error('原快照缺少界面待保存资料');}
 }return result.sort((a,b)=>a.name<b.name?-1:1);
}
export function readRestorePendingIntent(value:unknown):RestorePendingIntent{
 const v=fields(value,['version','operationId','activationId','challenge','role','directoryIdentity','originalManifestSha256','candidateManifestSha256','originalValuesSha256','files']);
 if(v.version!==1||v.role!=='candidate'&&v.role!=='original'||!Array.isArray(v.files)||v.files.length<2||v.files.length>4)throw new Error('恢复待保存资料登记无效');
 let previous='';const files=v.files.map(raw=>{const f=fields(raw,['name','bytes','sha256']);if(typeof f.name!=='string'||!(RESTORE_PENDING_NAMES as readonly string[]).includes(f.name)||f.name<=previous)throw new Error('恢复待保存资料名称或顺序无效');previous=f.name;return {name:f.name as RestorePendingFile['name'],bytes:restoreTransactionCount(f.bytes,f.name.endsWith('-renderer.json')?4*1024*1024:16*1024*1024),sha256:restoreTransactionDigest(f.sha256)};});
 if(!files.some(f=>f.name==='original-renderer.json')||!files.some(f=>f.name==='candidate-renderer.json')||!files.some(f=>f.name==='original-history.json'))throw new Error('当前原曲库快照缺少完整待保存资料');
 return {version:1,operationId:backupUuid(v.operationId),activationId:backupUuid(v.activationId),challenge:backupUuid(v.challenge),role:v.role,directoryIdentity:readRestoreIdentity(v.directoryIdentity),originalManifestSha256:restoreTransactionDigest(v.originalManifestSha256),candidateManifestSha256:restoreTransactionDigest(v.candidateManifestSha256),originalValuesSha256:restoreTransactionDigest(v.originalValuesSha256),files};
}
export function readRestorePendingRequest(value:unknown):RestorePendingRequest{
 const v=fields(value,['version','operationId','activationId','challenge','archiveSha256','role','original']);if(v.version!==1||v.role!=='candidate'&&v.role!=='original')throw new Error('恢复待保存资料挑战无效');
 return {version:1,operationId:backupUuid(v.operationId),activationId:backupUuid(v.activationId),challenge:backupUuid(v.challenge),archiveSha256:restoreTransactionDigest(v.archiveSha256),role:v.role,original:readRendererPendingSnapshot(v.original)};
}
export function readRestorePendingReply(value:unknown):RestorePendingReply{
 const v=fields(value,['version','operationId','activationId','challenge','archiveSha256','originalSha256','resultSha256','cleared','error']);if(v.version!==1||typeof v.cleared!=='boolean'||typeof v.error!=='string'||v.error.length>1024||v.error.includes('\0')||Boolean(v.error)!==(v.resultSha256===null)||Boolean(v.error)&&v.cleared)throw new Error('恢复界面待保存资料回执无效');
 return {version:1,operationId:backupUuid(v.operationId),activationId:backupUuid(v.activationId),challenge:backupUuid(v.challenge),archiveSha256:restoreTransactionDigest(v.archiveSha256),originalSha256:restoreTransactionDigest(v.originalSha256),resultSha256:v.resultSha256===null?null:restoreTransactionDigest(v.resultSha256),cleared:v.cleared,error:v.error};
}
export function readRestorePendingSettled(value:unknown):RestorePendingSettled{
 const v=fields(value,['archiveSha256','rendererReplySha256','historyBeforeSha256','historyAfterSha256','historyReset']);if(typeof v.historyReset!=='boolean')throw new Error('恢复Main历史处理回执无效');return {archiveSha256:restoreTransactionDigest(v.archiveSha256),rendererReplySha256:restoreTransactionDigest(v.rendererReplySha256),historyBeforeSha256:restoreTransactionDigest(v.historyBeforeSha256),historyAfterSha256:restoreTransactionDigest(v.historyAfterSha256),historyReset:v.historyReset};
}
