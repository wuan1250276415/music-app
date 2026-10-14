import {backupUuid,readCatalogBackupManifest,type CatalogBackupManifest} from './catalog-backup.js';
import {readRestoreIdentity} from './catalog-restore.js';
import {assertRestoreCompatibility,type CatalogRestoreCompatibility} from './catalog-restore-compatibility.js';
import {RELEASE} from './release.js';
import {readCatalogRestoreConsent,type CatalogRestoreConsent} from './catalog-restore-consent.js';
export const RESTORE_TRANSACTION_RECORD_LIMIT=48;
export const RESTORE_TRANSACTION_FRAME_BYTES=3*1024*1024;
export type RestoreTransactionIntent={format:'aural-restore-transaction';version:1|2;consent?:CatalogRestoreConsent;transactionId:string;createdAt:string;userData:string;userDataIdentity:string;rootIdentity:string;transactionIdentity:string;dataIdentity:string;candidateIdentity:string;liveIdentity:string;source:{operationId:string;preparedSha256:string;stageIdentity:string}};
export type RestoreCandidateProof={transactionId:string;candidateIdentity:string;libraryIdentity:string;files:number;bytes:number;compatibility:CatalogRestoreCompatibility};
export type RestoreRollbackProof={transactionId:string;stagePath:string;stageIdentity:string;liveIdentity:string;manifest:CatalogBackupManifest;compatibility:CatalogRestoreCompatibility};
export type RestorePreparationFrame={transactionId:string;sequence:number}&({kind:'progress';bytes:number;total:number}|{kind:'candidate';result:RestoreCandidateProof}|{kind:'rollback';result:RestoreRollbackProof}|{kind:'error';message:string});
export function restoreTransactionFields(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('整库恢复事务字段无效');return value as Record<string,unknown>;}
export function restoreTransactionDigest(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new Error('整库恢复事务摘要无效');return value;}
export function restoreTransactionDate(value:unknown):string{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new Error('整库恢复事务时间无效');return value;}
export function restoreTransactionCount(value:unknown,max=64*1024**3):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>max)throw new Error('整库恢复事务数量无效');return value;}
export function readRestoreTransactionIntent(value:unknown):RestoreTransactionIntent{
 const raw=value as {version?:unknown};const v=restoreTransactionFields(value,['format','version','transactionId','createdAt','userData','userDataIdentity','rootIdentity','transactionIdentity','dataIdentity','candidateIdentity','liveIdentity','source',...(raw?.version===2?['consent']:[])]),s=restoreTransactionFields(v.source,['operationId','preparedSha256','stageIdentity']);
 const consent=v.version===2?readCatalogRestoreConsent(v.consent):undefined;if(consent&&(consent.transactionId!==v.transactionId||consent.sourceId!==s.operationId||consent.preparedSha256!==s.preparedSha256||consent.stageIdentity!==s.stageIdentity))throw new Error('恢复确认不属于原事务和准备资料');
 if(v.format!=='aural-restore-transaction'||v.version!==1&&v.version!==2||typeof v.userData!=='string'||v.userData.length>32767||!/^[a-zA-Z]:\\/.test(v.userData)||/[\u0000-\u001f]/.test(v.userData))throw new Error('整库恢复事务根位置或版本无效');
 return {format:'aural-restore-transaction',version:v.version as 1|2,transactionId:backupUuid(v.transactionId),createdAt:restoreTransactionDate(v.createdAt),userData:v.userData,userDataIdentity:readRestoreIdentity(v.userDataIdentity),rootIdentity:readRestoreIdentity(v.rootIdentity),transactionIdentity:readRestoreIdentity(v.transactionIdentity),dataIdentity:readRestoreIdentity(v.dataIdentity),candidateIdentity:readRestoreIdentity(v.candidateIdentity),liveIdentity:readRestoreIdentity(v.liveIdentity),source:{operationId:backupUuid(s.operationId),preparedSha256:restoreTransactionDigest(s.preparedSha256),stageIdentity:readRestoreIdentity(s.stageIdentity)},...(consent?{consent}:{})};
}
export function readRestoreCandidateProof(value:unknown,manifest:CatalogBackupManifest):RestoreCandidateProof{
 const v=restoreTransactionFields(value,['transactionId','candidateIdentity','libraryIdentity','files','bytes','compatibility']),files=restoreTransactionCount(v.files,8192),bytes=restoreTransactionCount(v.bytes),compatibility=assertRestoreCompatibility(v.compatibility,manifest);
 if(files!==manifest.files.length||bytes!==manifest.files.reduce((total,file)=>total+file.bytes,0))throw new Error('候选曲库完整清单与复制证明不符');
 return {transactionId:backupUuid(v.transactionId),candidateIdentity:readRestoreIdentity(v.candidateIdentity),libraryIdentity:readRestoreIdentity(v.libraryIdentity),files,bytes,compatibility};
}
export function readRestoreRollbackProof(value:unknown):RestoreRollbackProof{
 const v=restoreTransactionFields(value,['transactionId','stagePath','stageIdentity','liveIdentity','manifest','compatibility']),manifest=readCatalogBackupManifest(v.manifest),transactionId=backupUuid(v.transactionId);
 if(manifest.backupId!==transactionId||typeof v.stagePath!=='string'||v.stagePath.length>32767||v.stagePath.includes('\0'))throw new Error('恢复前一致快照身份或位置无效');
 return {transactionId,stagePath:v.stagePath,stageIdentity:readRestoreIdentity(v.stageIdentity),liveIdentity:readRestoreIdentity(v.liveIdentity),manifest,compatibility:assertRestoreCompatibility(v.compatibility,manifest)};
}
export function readRestorePreparationFrame(value:unknown,transactionId:string,sequence:number,mode:'candidate'|'rollback',manifest:CatalogBackupManifest):RestorePreparationFrame{
 const v=value as RestorePreparationFrame;if(!v||typeof v!=='object'||Array.isArray(v)||v.transactionId!==transactionId||v.sequence!==sequence||!Number.isSafeInteger(sequence)||sequence>1000000)throw new Error('整库恢复准备进程身份或顺序无效');
 if(v.kind==='progress'){restoreTransactionFields(v,['transactionId','sequence','kind','bytes','total']);const bytes=restoreTransactionCount(v.bytes),total=restoreTransactionCount(v.total);if(bytes>total)throw new Error('整库恢复准备进度无效');return {transactionId,sequence,kind:'progress',bytes,total};}
 if(v.kind==='error'){restoreTransactionFields(v,['transactionId','sequence','kind','message']);if(typeof v.message!=='string'||!v.message||v.message.length>1024)throw new Error('整库恢复准备错误无效');return {transactionId,sequence,kind:'error',message:v.message};}
 if(v.kind===mode){restoreTransactionFields(v,['transactionId','sequence','kind','result']);const result=mode==='candidate'?readRestoreCandidateProof(v.result,manifest):readRestoreRollbackProof(v.result);if(result.transactionId!==transactionId||result.compatibility.appVersion!==RELEASE.appVersion)throw new Error('整库恢复准备报告并非当前操作或构建');return mode==='candidate'?{transactionId,sequence,kind:'candidate',result:result as RestoreCandidateProof}:{transactionId,sequence,kind:'rollback',result:result as RestoreRollbackProof};}
 throw new Error('整库恢复准备进程消息类型无效');
}
