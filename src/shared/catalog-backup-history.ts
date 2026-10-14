import {backupUuid} from './catalog-backup.js';
export type CatalogBackupHistoryEntry={operationId:string;name:string;updatedAt:string;status:'recorded'|'interrupted'|'cancelled'|'failed'|'verified'|'reconciled'|'invalid';message:string;canVerify:boolean};
export type CatalogBackupHistory={entries:CatalogBackupHistoryEntry[];notice:string};
export function readBackupHistory(value:unknown):CatalogBackupHistory{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2)throw new Error('备份记录列表无效');
 const v=value as CatalogBackupHistory;
 if(!Array.isArray(v.entries)||v.entries.length>256||typeof v.notice!=='string'||v.notice.length>1024)throw new Error('备份记录列表超过预算');
 const ids=new Set<string>();for(const entry of v.entries){
  if(!entry||typeof entry!=='object'||Object.keys(entry).length!==6||['operationId','name','updatedAt','status','message','canVerify'].some(k=>!Object.hasOwn(entry,k)))throw new Error('备份记录字段无效');
  backupUuid(entry.operationId);if(ids.has(entry.operationId))throw new Error('备份记录身份重复');ids.add(entry.operationId);
  if(typeof entry.name!=='string'||entry.name.length>128||/[\u0000-\u001f\\/]/.test(entry.name)||typeof entry.updatedAt!=='string'||entry.updatedAt!==''&&(!Number.isFinite(Date.parse(entry.updatedAt))||new Date(entry.updatedAt).toISOString()!==entry.updatedAt)||!['recorded','interrupted','cancelled','failed','verified','reconciled','invalid'].includes(entry.status)||typeof entry.message!=='string'||entry.message.length>1024||typeof entry.canVerify!=='boolean')throw new Error('备份记录内容无效');
 }
 return v;
}
