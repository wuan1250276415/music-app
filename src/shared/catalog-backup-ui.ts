import {backupUuid,readRendererPendingSnapshot,type RendererPendingSnapshot} from './catalog-backup.js';
export type CatalogBackupPhase='idle'|'choosing'|'freezing'|'draining'|'capturing'|'releasing'|'packing'|'verifying'|'publishing'|'completed'|'checked'|'failed'|'cancelled';
export type CatalogBackupResult={name:string;bytes:number;sha256:string;createdAt:string;items:number;files:number;publication:'atomic-new'|'rename-existing'|'exclusive-copy'};
export type CatalogBackupState={operationId:string|null;phase:CatalogBackupPhase;held:boolean;cancelRequested:boolean;bytes:number;total:number;message:string;result:CatalogBackupResult|null};
export type CatalogBackupFreeze={operationId:string;challenge:string};
export type CatalogBackupFrozen=CatalogBackupFreeze&{pending:RendererPendingSnapshot|null;error:string};
function fields(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('曲库备份消息无效');return value as Record<string,unknown>;}
export function readBackupFreeze(value:unknown):CatalogBackupFreeze{const v=fields(value,['operationId','challenge']);return {operationId:backupUuid(v.operationId),challenge:backupUuid(v.challenge)};}
export function readBackupFrozen(value:unknown):CatalogBackupFrozen{
 const v=fields(value,['operationId','challenge','pending','error']);if(typeof v.error!=='string'||v.error.length>1024||(v.pending===null?!v.error:Boolean(v.error)))throw new Error('曲库备份冻结回执无效');
 return {...readBackupFreeze({operationId:v.operationId,challenge:v.challenge}),pending:v.pending===null?null:readRendererPendingSnapshot(v.pending),error:v.error};
}
export function readBackupResult(value:unknown):CatalogBackupResult{
 const v=fields(value,['name','bytes','sha256','createdAt','items','files','publication']);
 if(typeof v.name!=='string'||!v.name||v.name.length>128||/[\u0000-\u001f\\/]/.test(v.name)||typeof v.sha256!=='string'||!/^[a-f0-9]{64}$/.test(v.sha256)||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt))||new Date(v.createdAt).toISOString()!==v.createdAt||typeof v.publication!=='string'||!['atomic-new','rename-existing','exclusive-copy'].includes(v.publication))throw new Error('备份完成回执无效');
 for(const k of ['bytes','items','files'])if(typeof v[k]!=='number'||!Number.isSafeInteger(v[k])||(v[k] as number)<0)throw new Error('备份完成数量无效');
 if((v.bytes as number)>64*1024**3+2*1024**2+52||(v.files as number)>8192)throw new Error('备份完成数量超过预算');return v as unknown as CatalogBackupResult;
}
export function readBackupState(value:unknown):CatalogBackupState{
 const v=fields(value,['operationId','phase','held','cancelRequested','bytes','total','message','result']);
 if(typeof v.phase!=='string'||!['idle','choosing','freezing','draining','capturing','releasing','packing','verifying','publishing','completed','checked','failed','cancelled'].includes(v.phase)||typeof v.held!=='boolean'||typeof v.cancelRequested!=='boolean'||typeof v.message!=='string'||v.message.length>1024)throw new Error('备份任务状态无效');
 for(const k of ['bytes','total'])if(typeof v[k]!=='number'||!Number.isSafeInteger(v[k])||(v[k] as number)<0||(v[k] as number)>64*1024**3+2*1024**2+52)throw new Error('备份进度无效');
 if((v.bytes as number)>(v.total as number)||v.phase==='idle'&&v.operationId!==null||v.phase!=='idle'&&v.operationId===null||v.phase==='completed'&&(v.held||v.result===null)||v.phase==='checked'&&v.held)throw new Error('备份状态与结果不符');
 return {...v,operationId:v.operationId===null?null:backupUuid(v.operationId),result:v.result===null?null:readBackupResult(v.result)} as CatalogBackupState;
}
