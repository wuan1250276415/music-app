import {backupUuid} from './catalog-backup.js';
import {restoreTransactionFields as fields,restoreTransactionDigest,restoreTransactionDate,restoreTransactionCount} from './catalog-restore-transaction.js';

export const CATALOG_RESTORE_POLICY_KEY='catalog_restore_activation';
export const CATALOG_RESTORE_POLICY_BYTES=1024*1024;
export type RestoredRootGrant={id:string;path:string;watchRevision:number};
export type CatalogRestorePolicy={format:'aural-restored-library-policy';activationId:string;operationId:string;requestSha256:string;sourceManifestSha256:string;origin:string;createdAt:string;priorPolicySha256:string|null;oldCredentialScope:string;credentialScope:string;scanSequence:number;tagRowid:number;credentialRowid:number;observationRowid:number;roots:RestoredRootGrant[]}&({version:1}|{version:2;collectionObservationRowid:number});

export function readCatalogRestorePolicy(value:unknown):CatalogRestorePolicy{
 const version=(value as {version?:unknown}|null)?.version;const v=fields(value,['format','version','activationId','operationId','requestSha256','sourceManifestSha256','origin','createdAt','priorPolicySha256','oldCredentialScope','credentialScope','scanSequence','tagRowid','credentialRowid','observationRowid','roots',...(version===2?['collectionObservationRowid']:[])]);
 if(v.format!=='aural-restored-library-policy'||v.version!==1&&v.version!==2||!Array.isArray(v.roots)||v.roots.length>4096||JSON.stringify(value).length>CATALOG_RESTORE_POLICY_BYTES)throw new Error('恢复激活策略版本或目录预算无效');
 const seen=new Set<string>(),roots=v.roots.map(raw=>{
  const r=fields(raw,['id','path','watchRevision']);
  if(typeof r.id!=='string'||!r.id||r.id.length>128||r.id.includes('\0')||seen.has(r.id)||typeof r.path!=='string'||!r.path||r.path.length>32768||r.path.includes('\0'))throw new Error('恢复目录授权基线无效');
  seen.add(r.id);return {id:r.id,path:r.path,watchRevision:restoreTransactionCount(r.watchRevision,Number.MAX_SAFE_INTEGER-2)};
 });
 if(roots.some((r,i)=>i>0&&roots[i-1].id>=r.id))throw new Error('恢复目录授权基线顺序无效');
 const oldCredentialScope=backupUuid(v.oldCredentialScope),credentialScope=backupUuid(v.credentialScope);
 if(oldCredentialScope===credentialScope||oldCredentialScope!==oldCredentialScope.toLowerCase()||credentialScope!==credentialScope.toLowerCase())throw new Error('导入曲库必须使用新的凭据范围');
 return {format:'aural-restored-library-policy',...(version===2?{version:2 as const,collectionObservationRowid:restoreTransactionCount(v.collectionObservationRowid,Number.MAX_SAFE_INTEGER)}:{version:1 as const}),activationId:backupUuid(v.activationId),operationId:backupUuid(v.operationId),requestSha256:restoreTransactionDigest(v.requestSha256),sourceManifestSha256:restoreTransactionDigest(v.sourceManifestSha256),origin:backupUuid(v.origin),createdAt:restoreTransactionDate(v.createdAt),priorPolicySha256:v.priorPolicySha256===null?null:restoreTransactionDigest(v.priorPolicySha256),oldCredentialScope,credentialScope,scanSequence:restoreTransactionCount(v.scanSequence,Number.MAX_SAFE_INTEGER),tagRowid:restoreTransactionCount(v.tagRowid,Number.MAX_SAFE_INTEGER),credentialRowid:restoreTransactionCount(v.credentialRowid,Number.MAX_SAFE_INTEGER),observationRowid:restoreTransactionCount(v.observationRowid,Number.MAX_SAFE_INTEGER),roots};
}
