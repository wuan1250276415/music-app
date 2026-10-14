import {backupUuid,backupPendingKey,type CatalogBackupManifest} from './catalog-backup.js';
import {readRestoreIdentity,readRestorePreview,type CatalogRestorePreview} from './catalog-restore.js';
import {readRestoreCompatibility,type CatalogRestoreCompatibility} from './catalog-restore-compatibility.js';
import {RELEASE} from './release.js';

export const RESTORE_REVIEW_BYTES=128*1024;
export type RestoreReviewEvidence={version:1;origin:string;databaseSha256:string;roots:Array<{id:string;path:string}>;providers:Array<{id:string;enabled:boolean}>;tasks:{scans:number;tagWrites:number;credentialCommands:number;metadataObservations:number};pendingKeys:string[];historyPendingBytes:number};
export type CatalogRestoreReview={version:1;preview:CatalogRestorePreview;preparedSha256:string;stageIdentity:string;checkSha256:string;checkedAt:string;compatibility:CatalogRestoreCompatibility;evidence:RestoreReviewEvidence;policy:'import-disabled-and-quarantined-v1'};
function fields(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('恢复审核字段无效');return value as Record<string,unknown>;}
function text(value:unknown,max:number):string{if(typeof value!=='string'||!value||value.length>max||/[\u0000-\u001f]/.test(value))throw new Error('恢复审核文字无效');return value;}
function sha(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new Error('恢复审核摘要无效');return value;}
function count(value:unknown,max=5000000):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>max)throw new Error('恢复审核数量超过预算');return value;}
function date(value:unknown):string{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new Error('恢复审核时间无效');return value;}
export function readRestoreReviewEvidence(value:unknown):RestoreReviewEvidence{
 if(new TextEncoder().encode(JSON.stringify(value)).byteLength>RESTORE_REVIEW_BYTES)throw new Error('恢复审核资料超过128KiB');
 const v=fields(value,['version','origin','databaseSha256','roots','providers','tasks','pendingKeys','historyPendingBytes']);
 if(v.version!==1||!Array.isArray(v.roots)||v.roots.length>4096||!Array.isArray(v.providers)||v.providers.length>128||!Array.isArray(v.pendingKeys)||v.pendingKeys.length>128)throw new Error('恢复审核范围无效');
 let previous='';const roots=v.roots.map(raw=>{const r=fields(raw,['id','path']),id=text(r.id,128);if(id<=previous)throw new Error('恢复目录身份重复或顺序无效');previous=id;return {id,path:text(r.path,32767)};});
 previous='';const providers=v.providers.map(raw=>{const p=fields(raw,['id','enabled']),id=text(p.id,128);if(!/^[a-z][a-z0-9.-]*$/.test(id)||id<=previous||typeof p.enabled!=='boolean')throw new Error('恢复数据源无效');previous=id;return {id,enabled:p.enabled};});
 previous='';const pendingKeys=v.pendingKeys.map(raw=>{const key=backupPendingKey(raw);if(key<=previous)throw new Error('恢复待核对类别重复或顺序无效');previous=key;return key;});
 const tasks=fields(v.tasks,['scans','tagWrites','credentialCommands','metadataObservations']);
 return {version:1,origin:backupUuid(v.origin),databaseSha256:sha(v.databaseSha256),roots,providers,tasks:{scans:count(tasks.scans),tagWrites:count(tasks.tagWrites),credentialCommands:count(tasks.credentialCommands),metadataObservations:count(tasks.metadataObservations)},pendingKeys,historyPendingBytes:count(v.historyPendingBytes,64*1024**3)};
}
export function bindRestoreReviewEvidence(value:unknown,manifest:CatalogBackupManifest,pendingValues:number):RestoreReviewEvidence{
 const evidence=readRestoreReviewEvidence(value),database=manifest.files.find(f=>f.role==='database');
 if(evidence.origin!==manifest.origin||evidence.databaseSha256!==database?.sha256||evidence.pendingKeys.length!==pendingValues||evidence.historyPendingBytes!==manifest.files.filter(f=>f.role==='history-pending').reduce((n,f)=>n+f.bytes,0))throw new Error('恢复审核不属于原已核对内容');
 return evidence;
}
export function readCatalogRestoreReview(value:unknown):CatalogRestoreReview{
 const v=fields(value,['version','preview','preparedSha256','stageIdentity','checkSha256','checkedAt','compatibility','evidence','policy']);
 if(v.version!==1||v.policy!=='import-disabled-and-quarantined-v1')throw new Error('恢复审核策略版本无效');
 const preview=readRestorePreview(v.preview),compatibility=readRestoreCompatibility(v.compatibility),evidence=readRestoreReviewEvidence(v.evidence);
 if(compatibility.appVersion!==RELEASE.appVersion||compatibility.databaseSha256!==evidence.databaseSha256||evidence.pendingKeys.length!==preview.pendingValues)throw new Error('恢复审核构建或资料摘要不符');
 return {version:1,preview,preparedSha256:sha(v.preparedSha256),stageIdentity:readRestoreIdentity(v.stageIdentity),checkSha256:sha(v.checkSha256),checkedAt:date(v.checkedAt),compatibility,evidence,policy:'import-disabled-and-quarantined-v1'};
}
