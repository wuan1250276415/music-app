import {backupUuid,readRendererPendingSnapshot,type RendererPendingSnapshot,type CatalogBackupManifest} from './catalog-backup.js';
export type CatalogMaintenanceLease={operationId:string;token:string};
export type CatalogMaintenancePhase='idle'|'draining'|'frozen'|'capturing'|'releasing'|'released'|'failed'|'closing'|'closed';
export type CatalogMaintenanceState={operationId:string|null;token:string|null;phase:CatalogMaintenancePhase;message:string};
export type CatalogCaptureRequest=CatalogMaintenanceLease&{pending:RendererPendingSnapshot};
// This result stays on the trusted Main/Library channel. Renderer never supplies paths.
export type CatalogCapturedSnapshot={stagePath:string;manifest:CatalogBackupManifest};
function fields(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('曲库维护请求无效');return value as Record<string,unknown>;}
export function readMaintenanceBegin(value:unknown):{operationId:string}{const v=fields(value,['operationId']);return {operationId:backupUuid(v.operationId)};}
export function readMaintenanceLease(value:unknown):CatalogMaintenanceLease{const v=fields(value,['operationId','token']);return {operationId:backupUuid(v.operationId),token:backupUuid(v.token)};}
export function readMaintenanceRelease(value:unknown):CatalogMaintenanceLease&{resumeWatch:boolean}{const v=fields(value,['operationId','token','resumeWatch']);if(typeof v.resumeWatch!=='boolean')throw new Error('曲库维护恢复意图无效');return {...readMaintenanceLease({operationId:v.operationId,token:v.token}),resumeWatch:v.resumeWatch};}
export function readCatalogCaptureRequest(value:unknown):CatalogCaptureRequest{const v=fields(value,['operationId','token','pending']);return {...readMaintenanceLease({operationId:v.operationId,token:v.token}),pending:readRendererPendingSnapshot(v.pending)};}
export function readCatalogMaintenanceState(value:unknown):CatalogMaintenanceState{
 const v=fields(value,['operationId','token','phase','message']);if(typeof v.phase!=='string'||!['idle','draining','frozen','capturing','releasing','released','failed','closing','closed'].includes(v.phase)||typeof v.message!=='string'||v.message.length>1024)throw new Error('曲库维护状态无效');
 if(v.phase==='idle'?(v.operationId!==null||v.token!==null):(v.operationId===null||v.token===null))throw new Error('曲库维护状态缺少身份');return {operationId:v.operationId===null?null:backupUuid(v.operationId),token:v.token===null?null:backupUuid(v.token),phase:v.phase as CatalogMaintenancePhase,message:v.message};
}
