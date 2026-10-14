import {backupUuid} from './catalog-backup.js';
import {readRestoreIdentity} from './catalog-restore.js';

export type RestoreApplyRequest={version:1;transactionId:string;sourceId:string;reviewSha256:string;replaceLibrary:true;confirmAccessReset:true;keepPendingForReview:true};
export type CatalogRestoreConsent={version:1;transactionId:string;sourceId:string;preparedSha256:string;stageIdentity:string;checkSha256:string;reviewSha256:string;checkedAt:string;acceptedAt:string;origin:string;backupSha256:string;buildId:string;policy:'import-disabled-and-quarantined-v1';replaceLibrary:true;confirmAccessReset:true;keepPendingForReview:true};
export type CatalogRestoreApplyState={version:1;operationId:string|null;sourceId:string|null;phase:'idle'|'checking'|'preparing'|'finishing'|'applied'|'retained'|'interrupted';message:string;cancelRequested:boolean};
export const restoreApplyActive=(state:CatalogRestoreApplyState)=>['checking','preparing','finishing'].includes(state.phase);
export const initialRestoreApplyState:CatalogRestoreApplyState={version:1,operationId:null,sourceId:null,phase:'idle',message:'',cancelRequested:false};
function fields(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('恢复确认字段无效');return value as Record<string,unknown>;}
function sha(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new Error('恢复确认摘要无效');return value;}
function date(value:unknown):string{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new Error('恢复确认时间无效');return value;}
function acknowledgements(v:Record<string,unknown>):void{if(v.replaceLibrary!==true||v.confirmAccessReset!==true||v.keepPendingForReview!==true)throw new Error('请确认曲库替换、访问设置及待处理资料的恢复方式');}
export function readRestoreApplyRequest(value:unknown):RestoreApplyRequest{
 const v=fields(value,['version','transactionId','sourceId','reviewSha256','replaceLibrary','confirmAccessReset','keepPendingForReview']);if(v.version!==1)throw new Error('恢复确认版本无效');acknowledgements(v);
 return {version:1,transactionId:backupUuid(v.transactionId),sourceId:backupUuid(v.sourceId),reviewSha256:sha(v.reviewSha256),replaceLibrary:true,confirmAccessReset:true,keepPendingForReview:true};
}
export function readCatalogRestoreConsent(value:unknown):CatalogRestoreConsent{
 const v=fields(value,['version','transactionId','sourceId','preparedSha256','stageIdentity','checkSha256','reviewSha256','checkedAt','acceptedAt','origin','backupSha256','buildId','policy','replaceLibrary','confirmAccessReset','keepPendingForReview']);
 if(v.version!==1||v.policy!=='import-disabled-and-quarantined-v1'||typeof v.buildId!=='string'||v.buildId.length>96||!/^aural-main-\d+\.\d+\.\d+$/.test(v.buildId))throw new Error('恢复确认策略或构建无效');acknowledgements(v);
 return {version:1,transactionId:backupUuid(v.transactionId),sourceId:backupUuid(v.sourceId),preparedSha256:sha(v.preparedSha256),stageIdentity:readRestoreIdentity(v.stageIdentity),checkSha256:sha(v.checkSha256),reviewSha256:sha(v.reviewSha256),checkedAt:date(v.checkedAt),acceptedAt:date(v.acceptedAt),origin:backupUuid(v.origin),backupSha256:sha(v.backupSha256),buildId:v.buildId,policy:'import-disabled-and-quarantined-v1',replaceLibrary:true,confirmAccessReset:true,keepPendingForReview:true};
}
export function readRestoreApplyState(value:unknown):CatalogRestoreApplyState{
 const v=fields(value,['version','operationId','sourceId','phase','message','cancelRequested']);
 if(v.version!==1||typeof v.phase!=='string'||!['idle','checking','preparing','finishing','applied','retained','interrupted'].includes(v.phase)||typeof v.message!=='string'||v.message.length>1024||typeof v.cancelRequested!=='boolean')throw new Error('恢复应用状态无效');
 const operationId=v.operationId===null?null:backupUuid(v.operationId),sourceId=v.sourceId===null?null:backupUuid(v.sourceId);
 if(v.phase==='idle'?(operationId!==null||sourceId!==null):(!operationId||!sourceId))throw new Error('恢复应用状态身份不符');
 return {version:1,operationId,sourceId,phase:v.phase as CatalogRestoreApplyState['phase'],message:v.message,cancelRequested:v.cancelRequested};
}
