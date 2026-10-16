import {readCatalogBackupManifest,type BackupPlugin} from './catalog-backup.js';
import {RELEASE} from './release.js';
export const RESTORE_DOMAIN_SCOPES=['settings','outputs','providers','playlists','filter-presets','counting-policy','lyrics-preferences','genre-tree','online-artwork','metadata-workflows','background-recognition','tag-stage-batches'] as const;
export type RestoreDomainScope=typeof RESTORE_DOMAIN_SCOPES[number];
export type CatalogRestoreCompatibility={version:1;appVersion:string;schema:68|69|70|71|72|73|74|75|76|77|78|79|80|81|82;schemaSha256:string;schemaObjects:number;databaseSha256:string;components:BackupPlugin[];domains:Array<{id:RestoreDomainScope;rows:number}>};
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function restoreAppVersionSupported(source:string):boolean{
 if(source.length>64||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(source))return false;
 const a=source.split('.').map(BigInt),b=RELEASE.appVersion.split('.').map(BigInt);
 for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]<b[i];return true;
}
export function readRestoreCompatibility(value:unknown):CatalogRestoreCompatibility{
 const v=value as CatalogRestoreCompatibility;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==8||['version','appVersion','schema','schemaSha256','schemaObjects','databaseSha256','components','domains'].some(k=>!Object.hasOwn(v,k))||v.version!==1||typeof v.appVersion!=='string'||v.appVersion.length>64||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v.appVersion)||![68,69,70,71,72,73,74,75,76,77,78,79,80,81,82].includes(v.schema)||!digest(v.schemaSha256)||!digest(v.databaseSha256)||!Number.isSafeInteger(v.schemaObjects)||v.schemaObjects<1||v.schemaObjects>4096||!Array.isArray(v.components)||v.components.length>128||!Array.isArray(v.domains)||v.domains.length!==(v.schema>=81?RESTORE_DOMAIN_SCOPES.length:v.schema>=77?RESTORE_DOMAIN_SCOPES.length-1:v.schema===76?RESTORE_DOMAIN_SCOPES.length-2:v.schema>=74?RESTORE_DOMAIN_SCOPES.length-3:RESTORE_DOMAIN_SCOPES.length-4))throw new Error('恢复兼容性报告版本或范围无效');
 let previous='';const components=v.components.map(p=>{
  if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==2||!Object.hasOwn(p,'id')||!Object.hasOwn(p,'version')||typeof p.id!=='string'||!/^[a-z][a-z0-9.-]{0,127}$/.test(p.id)||p.id<=previous||typeof p.version!=='string'||p.version.length>64||!/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){0,3}$/.test(p.version))throw new Error('恢复兼容性组件报告无效');previous=p.id;return {id:p.id,version:p.version};
 });
 const domains=v.domains.map((d,i)=>{if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).length!==2||!Object.hasOwn(d,'id')||!Object.hasOwn(d,'rows')||d.id!==RESTORE_DOMAIN_SCOPES[i]||!Number.isSafeInteger(d.rows)||d.rows<0||d.rows>5000000)throw new Error('恢复兼容性检查范围或数量无效');return {id:d.id,rows:d.rows};});
 return {version:1,appVersion:v.appVersion,schema:v.schema as 68|69|70|71|72|73|74|75|76|77|78|79|80|81|82,schemaSha256:v.schemaSha256,schemaObjects:v.schemaObjects,databaseSha256:v.databaseSha256,components,domains};
}
// Bind a worker report to the original immutable archive manifest. A report does
// not certify all catalog domains, permissions or an already replaced live DB.
export function assertRestoreCompatibility(value:unknown,manifest:unknown):CatalogRestoreCompatibility{
 const report=readRestoreCompatibility(value),source=readCatalogBackupManifest(manifest);
 if(report.schema!==source.schema||!restoreAppVersionSupported(source.appVersion)||report.databaseSha256!==source.files.find(f=>f.role==='database')?.sha256||JSON.stringify(report.components)!==JSON.stringify(source.plugins))throw new Error('恢复兼容性报告与原数据库或组件清单不符');return report;
}
