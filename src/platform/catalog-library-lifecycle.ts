import type {NormalLibraryPermission} from '../shared/catalog-normal-open.js';
import {createHash} from 'node:crypto';
import {backupUuid,readCatalogBackupManifest,type CatalogBackupManifest} from '../shared/catalog-backup.js';
import {readRestoreIdentity} from '../shared/catalog-restore.js';
import {assertRestoreCompatibility,type CatalogRestoreCompatibility} from '../shared/catalog-restore-compatibility.js';
import {restoreTransactionFields as fields,restoreTransactionDate} from '../shared/catalog-restore-transaction.js';
import {RELEASE} from '../shared/release.js';
export type LibraryInstanceReady={version:1;ready:true;instanceId:string;pid:number;buildId:string};
export type CatalogServiceStopRequest={version:1;operationId:string;token:string;challenge:string;instanceId:string;mode:'original'|'dormant';libraryIdentity:string;manifest:CatalogBackupManifest};
export type CatalogServiceStopReceipt={version:1;operationId:string;token:string;challenge:string;instanceId:string;pid:number;buildId:string;libraryIdentity:string;manifest:CatalogBackupManifest;closed:true};
export type CatalogServiceExitProof={version:1;receipt:CatalogServiceStopReceipt;exitCode:0;exitedAt:string};
export type CatalogRestoreBootRequest={version:1;operationId:string;challenge:string;libraryIdentity:string;manifest:CatalogBackupManifest};
export type CatalogRestoreBootProof={version:1;operationId:string;challenge:string;instanceId:string;pid:number;buildId:string;libraryIdentity:string;manifestSha256:string;token:string;compatibility:CatalogRestoreCompatibility;readOnly:true;backgroundStarted:false};
export const lifecycleDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function processId(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>0xffffffff)throw new Error('曲库服务进程身份无效');return value;}
export function readLibraryInstanceReady(value:unknown,expected?:{permission:NormalLibraryPermission;sha256:string}):LibraryInstanceReady{const v=fields(value,['version','ready','instanceId','pid','buildId',...(expected?['existingLibrary']:[])]);if(v.version!==1||v.ready!==true||v.buildId!==RELEASE.mainBuildId)throw new Error('曲库服务构建或就绪回执无效');
 if(expected){const proof=fields(v.existingLibrary,['permissionSha256','libraryIdentity','origin']);if(proof.permissionSha256!==expected.sha256||proof.libraryIdentity!==expected.permission.libraryIdentity||proof.origin!==expected.permission.origin)throw new Error('普通曲库启动未确认原已完成恢复的数据库来源');}
 return {version:1,ready:true,instanceId:backupUuid(v.instanceId),pid:processId(v.pid),buildId:RELEASE.mainBuildId};}
export function readCatalogServiceStopRequest(value:unknown):CatalogServiceStopRequest{const v=fields(value,['version','operationId','token','challenge','instanceId','mode','libraryIdentity','manifest']);if(v.version!==1||v.mode!=='original'&&v.mode!=='dormant')throw new Error('曲库受控关闭请求无效');return {version:1,operationId:backupUuid(v.operationId),token:backupUuid(v.token),challenge:backupUuid(v.challenge),instanceId:backupUuid(v.instanceId),mode:v.mode,libraryIdentity:readRestoreIdentity(v.libraryIdentity),manifest:readCatalogBackupManifest(v.manifest)};}
export function readCatalogServiceStopReceipt(value:unknown,request?:CatalogServiceStopRequest):CatalogServiceStopReceipt{
 const v=fields(value,['version','operationId','token','challenge','instanceId','pid','buildId','libraryIdentity','manifest','closed']),manifest=readCatalogBackupManifest(v.manifest),operationId=backupUuid(v.operationId);
 if(v.version!==1||v.closed!==true||typeof v.buildId!=='string'||!/^aural-main-\d+\.\d+\.\d+$/.test(v.buildId)||manifest.backupId!==operationId)throw new Error('曲库数据库关闭回执无效');
 const result:CatalogServiceStopReceipt={version:1,operationId,token:backupUuid(v.token),challenge:backupUuid(v.challenge),instanceId:backupUuid(v.instanceId),pid:processId(v.pid),buildId:v.buildId,libraryIdentity:readRestoreIdentity(v.libraryIdentity),manifest,closed:true};
 if(request){if(result.operationId!==request.operationId||result.token!==request.token||result.challenge!==request.challenge||result.instanceId!==request.instanceId||result.libraryIdentity!==request.libraryIdentity||manifest.origin!==request.manifest.origin||JSON.stringify(manifest.counts)!==JSON.stringify(request.manifest.counts))throw new Error('原曲库关闭回执与维护及来源不符');
  const expected=request.manifest.files.filter(file=>request.mode==='dormant'||file.role!=='database'),actual=manifest.files.filter(file=>request.mode==='dormant'||file.role!=='database');if(JSON.stringify(expected)!==JSON.stringify(actual))throw new Error('曲库关闭前后的受管理资料不一致');
 }
 return result;
}
export function readCatalogServiceExitProof(value:unknown,request?:CatalogServiceStopRequest):CatalogServiceExitProof{const v=fields(value,['version','receipt','exitCode','exitedAt']);if(v.version!==1||v.exitCode!==0)throw new Error('曲库实际正常退出证明无效');return {version:1,receipt:readCatalogServiceStopReceipt(v.receipt,request),exitCode:0,exitedAt:restoreTransactionDate(v.exitedAt)};}
export function readCatalogRestoreBootRequest(value:unknown):CatalogRestoreBootRequest{const v=fields(value,['version','operationId','challenge','libraryIdentity','manifest']);if(v.version!==1)throw new Error('恢复曲库只读启动请求无效');return {version:1,operationId:backupUuid(v.operationId),challenge:backupUuid(v.challenge),libraryIdentity:readRestoreIdentity(v.libraryIdentity),manifest:readCatalogBackupManifest(v.manifest)};}
export function readCatalogRestoreBootProof(value:unknown,request:CatalogRestoreBootRequest,options:{currentBuild?:boolean}={}):CatalogRestoreBootProof{
 const v=fields(value,['version','operationId','challenge','instanceId','pid','buildId','libraryIdentity','manifestSha256','token','compatibility','readOnly','backgroundStarted']);
 if(v.version!==1||v.operationId!==request.operationId||v.challenge!==request.challenge||v.libraryIdentity!==request.libraryIdentity||v.manifestSha256!==lifecycleDigest(request.manifest)||typeof v.buildId!=='string'||!/^aural-main-\d+\.\d+\.\d+$/.test(v.buildId)||v.readOnly!==true||v.backgroundStarted!==false)throw new Error('恢复曲库启动证明与原请求或暂停模式不符');
 const compatibility=assertRestoreCompatibility(v.compatibility,request.manifest);if(v.buildId!=='aural-main-'+compatibility.appVersion||(options.currentBuild!==false&&(v.buildId!==RELEASE.mainBuildId||compatibility.appVersion!==RELEASE.appVersion)))throw new Error('恢复曲库启动核对构建不符');return {version:1,operationId:request.operationId,challenge:request.challenge,instanceId:backupUuid(v.instanceId),pid:processId(v.pid),buildId:v.buildId,libraryIdentity:request.libraryIdentity,manifestSha256:lifecycleDigest(request.manifest),token:backupUuid(v.token),compatibility,readOnly:true,backgroundStarted:false};
}
