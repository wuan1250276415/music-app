import {backupUuid} from './catalog-backup.js';
import {readRestorePreview,type CatalogRestorePreview} from './catalog-restore.js';
export type CatalogRestoreHistoryEntry={operationId:string;name:string;status:'prepared'|'checked'|'interrupted'|'invalid';checkedAt:string;message:string;preview:CatalogRestorePreview|null};
export type CatalogRestoreHistory={entries:CatalogRestoreHistoryEntry[];notice:string};
export function readRestoreHistory(value:unknown):CatalogRestoreHistory{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2)throw new Error('恢复资料列表无效');const v=value as CatalogRestoreHistory;
 if(!Array.isArray(v.entries)||v.entries.length>64||typeof v.notice!=='string'||v.notice.length>1024)throw new Error('恢复资料列表超出预算');const seen=new Set<string>();
 const entries=v.entries.map(e=>{
  if(!e||typeof e!=='object'||Object.keys(e).length!==6||['operationId','name','status','checkedAt','message','preview'].some(k=>!Object.hasOwn(e,k)))throw new Error('恢复资料记录无效');backupUuid(e.operationId);if(seen.has(e.operationId))throw new Error('恢复资料身份重复');seen.add(e.operationId);
  if(typeof e.name!=='string'||e.name.length>128||/[\u0000-\u001f\\/]/.test(e.name)||!['prepared','checked','interrupted','invalid'].includes(e.status)||typeof e.checkedAt!=='string'||e.checkedAt!==''&&(!Number.isFinite(Date.parse(e.checkedAt))||new Date(e.checkedAt).toISOString()!==e.checkedAt)||typeof e.message!=='string'||e.message.length>1024)throw new Error('恢复资料内容无效');
  const preview=e.preview===null?null:readRestorePreview(e.preview);if(preview&&preview.operationId!==e.operationId||['prepared','checked'].includes(e.status)&&!preview)throw new Error('恢复资料预览身份无效');return {...e,preview};
 });return {entries,notice:v.notice};
}
