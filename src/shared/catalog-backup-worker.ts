import {backupUuid,readCatalogBackupManifest,CATALOG_BACKUP_MAX_MANIFEST,type CatalogBackupManifest} from './catalog-backup.js';
export const BACKUP_WORKER_FRAME_BYTES=CATALOG_BACKUP_MAX_MANIFEST+16384;
export type BackupOutputProof={identity:string;observation:string};
export type BackupPackedResult=BackupOutputProof&{manifest:CatalogBackupManifest;bytes:number;sha256:string};
export type BackupWorkerFrame={operationId:string;sequence:number}&({kind:'progress';phase:'packing'|'verifying';bytes:number;total:number}|{kind:'done';result:BackupPackedResult}|{kind:'error';message:string});
export function readPackedBackup(value:unknown):BackupPackedResult{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==5||['manifest','bytes','sha256','identity','observation'].some(k=>!Object.hasOwn(value,k)))throw new Error('备份进程完成回执无效');const v=value as BackupPackedResult;
 if(typeof v.bytes!=='number'||!Number.isSafeInteger(v.bytes)||v.bytes<52||v.bytes>64*1024**3+2*1024**2+52||typeof v.sha256!=='string'||!/^[a-f0-9]{64}$/.test(v.sha256)||typeof v.identity!=='string'||!/^\d+:\d+:-?\d+$/.test(v.identity)||v.identity.length>256||typeof v.observation!=='string'||!/^[a-f0-9]{64}$/.test(v.observation))throw new Error('备份进程文件证明无效');
 const manifest=readCatalogBackupManifest(v.manifest);if(v.bytes!==12+new TextEncoder().encode(JSON.stringify(manifest)).byteLength+manifest.files.reduce((n,file)=>n+file.bytes,0)+40)throw new Error('备份进程文件长度与清单不符');return {...v,manifest};
}
export function readBackupWorkerFrame(value:unknown):BackupWorkerFrame{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('备份进程消息无效');const v=value as Record<string,unknown>;
 backupUuid(v.operationId);if(typeof v.sequence!=='number'||!Number.isSafeInteger(v.sequence)||v.sequence<0||v.sequence>1000000)throw new Error('备份进程序号无效');
 if(v.kind==='done'&&Object.keys(v).length===4)return {...v,result:readPackedBackup(v.result)} as BackupWorkerFrame;
 if(v.kind==='error'&&Object.keys(v).length===4&&typeof v.message==='string'&&v.message.length>0&&v.message.length<=1024)return v as BackupWorkerFrame;
 if(v.kind==='progress'&&Object.keys(v).length===6&&(v.phase==='packing'||v.phase==='verifying')&&['bytes','total'].every(k=>typeof v[k]==='number'&&Number.isSafeInteger(v[k])&&(v[k] as number)>=0&&(v[k] as number)<=64*1024**3+2*1024**2+52)&&(v.bytes as number)<=(v.total as number))return v as BackupWorkerFrame;
 throw new Error('备份进程消息字段无效');
}
