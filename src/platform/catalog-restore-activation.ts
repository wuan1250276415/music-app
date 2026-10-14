import {backupUuid,readCatalogBackupManifest,CATALOG_BACKUP_COUNT_TABLES,type CatalogBackupManifest} from '../shared/catalog-backup.js';
import {readCatalogRestorePolicy,type CatalogRestorePolicy} from '../shared/catalog-restore-policy.js';
import {restoreTransactionFields as fields,restoreTransactionDigest,RESTORE_TRANSACTION_FRAME_BYTES} from '../shared/catalog-restore-transaction.js';
import {readRestoreIdentity} from '../shared/catalog-restore.js';
import {assertRestoreCompatibility,type CatalogRestoreCompatibility} from '../shared/catalog-restore-compatibility.js';
import {RELEASE} from '../shared/release.js';
import {lifecycleDigest,type CatalogRestoreBootRequest,type CatalogRestoreBootProof} from './catalog-library-lifecycle.js';

export type CatalogRestoreActivationRequest={version:1;operationId:string;activationId:string;challenge:string;instanceId:string;token:string;role:'candidate'|'original';libraryIdentity:string;bootSha256:string;credentialScope:string|null};
export type CatalogRestoreActivationProof={version:1;operationId:string;activationId:string;challenge:string;instanceId:string;pid:number;buildId:string;libraryIdentity:string;requestSha256:string;sourceManifestSha256:string;manifest:CatalogBackupManifest;policy:CatalogRestorePolicy|null;compatibility:CatalogRestoreCompatibility;writable:true;backgroundStarted:false};
export function readCatalogRestoreActivationRequest(value:unknown,boot?:CatalogRestoreBootProof):CatalogRestoreActivationRequest{
 const v=fields(value,['version','operationId','activationId','challenge','instanceId','token','role','libraryIdentity','bootSha256','credentialScope']);
 if(v.version!==1||v.role!=='candidate'&&v.role!=='original'||v.role==='candidate'&&v.credentialScope===null||v.role==='original'&&v.credentialScope!==null)throw new Error('恢复可写激活请求角色无效');
 const request:CatalogRestoreActivationRequest={version:1,operationId:backupUuid(v.operationId),activationId:backupUuid(v.activationId),challenge:backupUuid(v.challenge),instanceId:backupUuid(v.instanceId),token:backupUuid(v.token),role:v.role,libraryIdentity:readRestoreIdentity(v.libraryIdentity),bootSha256:restoreTransactionDigest(v.bootSha256),credentialScope:v.credentialScope===null?null:backupUuid(v.credentialScope)};
 if(request.credentialScope!==null&&request.credentialScope!==request.credentialScope.toLowerCase())throw new Error('恢复凭据范围必须使用规范身份');
 if(boot&&(request.operationId!==boot.operationId||request.instanceId!==boot.instanceId||request.token!==boot.token||request.libraryIdentity!==boot.libraryIdentity||request.bootSha256!==lifecycleDigest(boot)))throw new Error('可写激活不是原只读实例及冻结租约');return request;
}
export function readCatalogRestoreActivationProof(value:unknown,request:CatalogRestoreActivationRequest,bootRequest:CatalogRestoreBootRequest,options:{currentBuild?:boolean}={}):CatalogRestoreActivationProof{
 if(Buffer.byteLength(JSON.stringify(value))>RESTORE_TRANSACTION_FRAME_BYTES-4096)throw new Error('可写准备回执超过持久记录预算');
 const v=fields(value,['version','operationId','activationId','challenge','instanceId','pid','buildId','libraryIdentity','requestSha256','sourceManifestSha256','manifest','policy','compatibility','writable','backgroundStarted']);
 const manifest=readCatalogBackupManifest(v.manifest),source=bootRequest.manifest,policy=v.policy===null?null:readCatalogRestorePolicy(v.policy),compatibility=assertRestoreCompatibility(v.compatibility,manifest);
 if(v.version!==1||v.operationId!==request.operationId||v.activationId!==request.activationId||v.challenge!==request.challenge||v.instanceId!==request.instanceId||v.libraryIdentity!==request.libraryIdentity||request.operationId!==bootRequest.operationId||request.libraryIdentity!==bootRequest.libraryIdentity||v.requestSha256!==lifecycleDigest(request)||v.sourceManifestSha256!==lifecycleDigest(source)||v.writable!==true||v.backgroundStarted!==false||typeof v.pid!=='number'||!Number.isSafeInteger(v.pid)||v.pid<1||v.pid>0xffffffff||typeof v.buildId!=='string'||v.buildId!=='aural-main-'+compatibility.appVersion||options.currentBuild!==false&&v.buildId!==RELEASE.mainBuildId)throw new Error('恢复可写激活回执身份或构建无效');
 if(manifest.backupId!==request.operationId||manifest.origin!==source.origin||manifest.schema!==source.schema)throw new Error('可写激活改变了曲库来源或结构');
 if(JSON.stringify(manifest.files.filter(f=>f.role!=='database'))!==JSON.stringify(source.files.filter(f=>f.role!=='database')))throw new Error('可写激活改变了数据库以外的原资料');
 for(const table of CATALOG_BACKUP_COUNT_TABLES)if(table!=='app_setting'&&manifest.counts[table]!==source.counts[table])throw new Error('可写激活改变了曲目或用户资料数量');
 if(request.role==='candidate'){
  if(!policy||policy.activationId!==request.activationId||policy.operationId!==request.operationId||policy.requestSha256!==lifecycleDigest(request)||policy.sourceManifestSha256!==lifecycleDigest(source)||policy.origin!==source.origin||policy.credentialScope!==request.credentialScope)throw new Error('导入曲库的持久激活策略不属于原请求');
 }else if(policy!==null||JSON.stringify(manifest.counts)!==JSON.stringify(source.counts)||JSON.stringify(manifest.files)!==JSON.stringify(source.files))throw new Error('原曲库恢复激活不能改写原策略或资料');
 return {version:1,operationId:request.operationId,activationId:request.activationId,challenge:request.challenge,instanceId:request.instanceId,pid:v.pid,buildId:v.buildId,libraryIdentity:request.libraryIdentity,requestSha256:lifecycleDigest(request),sourceManifestSha256:lifecycleDigest(source),manifest,policy,compatibility,writable:true,backgroundStarted:false};
}
