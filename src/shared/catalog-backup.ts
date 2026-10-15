// Portable data backup. This contract never authorizes access to a filesystem path.
export const CATALOG_BACKUP_VERSION=1 as const;
export const CATALOG_BACKUP_SCHEMA=78 as const;
export const CATALOG_BACKUP_MAX_MANIFEST=2*1024*1024;
export const CATALOG_BACKUP_MAX_FILES=8192;
export const CATALOG_BACKUP_MAX_FILE=32*1024*1024*1024;
export const CATALOG_BACKUP_MAX_PAYLOAD=64*1024*1024*1024;
export const CATALOG_BACKUP_PENDING_KEYS=[
 'aural-filter-preset-pending-v1','aural-playback-policy-pending-v2',
 'aural-rule-import-pending-v1','aural-smart-playlist-pending-v1',
 'aural-smart-playlist-restore-pending-v1'
] as const;
export const CATALOG_BACKUP_PENDING_BYTES=4*1024*1024;
export const CATALOG_BACKUP_COUNT_TABLES=[
 'media_file','playable_item','playlist','playlist_item','item_user_state','app_setting','lyrics_document',
 'lyrics_local_version','playback_history','playback_counting_policy','user_command_receipt'
] as const;
export type BackupRole='database'|'renderer-pending'|'history-pending'|'writeback-journal'|'writeback-artifact';
export type BackupFile={path:string;role:BackupRole;bytes:number;sha256:string};
export type BackupCounts=Record<typeof CATALOG_BACKUP_COUNT_TABLES[number],number>;
export type BackupPlugin={id:string;version:string};
export type CatalogBackupManifest={
 format:'aural-catalog-backup';version:1;backupId:string;createdAt:string;appVersion:string;schema:68|69|70|71|72|73|74|75|76|77|78;origin:string;
 capture:'quiesced-v1';counts:BackupCounts;plugins:BackupPlugin[];
 // Embedded derived blobs are part of the database in the current implementation.
 cache:'database-resident';externalMedia:'excluded';systemCredentials:'excluded';
 externalWriteback:'requires-original-source';files:BackupFile[];
};
export type RendererPendingSnapshot={version:1;capturedAt:string;values:Array<{key:string;raw:string}>};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function backupUuid(v:unknown):string{if(typeof v!=='string'||!uuid.test(v))throw new Error('备份身份无效');return v;}
function fields(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('备份字段无效');return value as Record<string,unknown>;
}
function bytes(value:unknown,max:number):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>max)throw new Error('备份数量超过预算或无效');return value;}
function instant(value:unknown):string{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new Error('备份时间无效');return value;}
function version(value:unknown):string{if(typeof value!=='string'||value.length>64||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))throw new Error('备份组件版本无效');return value;}
function componentVersion(value:unknown):string{if(typeof value!=='string'||value.length>64||!/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){0,3}$/.test(value))throw new Error('备份组件契约版本无效');return value;}
export function backupPathRole(value:unknown):BackupRole{
 if(typeof value!=='string'||value.length>256)throw new Error('备份条目路径无效');
 if(value==='library/library.db')return 'database';
 if(value==='state/renderer-pending.json')return 'renderer-pending';
 if(value==='state/playback-history-pending.json')return 'history-pending';
 const journal=/^library\/(tag-write|tag-commit|tag-restore)\/([^/]+)\/(\d{4})\.json$/.exec(value);
 if(journal){backupUuid(journal[2]);const revision=Number(journal[3]),max=journal[1]==='tag-write'?31:journal[1]==='tag-commit'?5:6;if(revision>max)throw new Error('备份日志序号无效');return 'writeback-journal';}
 const artifact=/^library\/tag-backups\/([a-fA-F0-9-]{36})-([a-fA-F0-9-]{36})\.bak$/.exec(value);
 if(artifact){backupUuid(artifact[1]);backupUuid(artifact[2]);return 'writeback-artifact';}
 throw new Error('备份包含未授权的条目路径');
}
export function backupFileLimit(file:Pick<BackupFile,'path'|'role'>):number{
 if(file.role==='renderer-pending')return CATALOG_BACKUP_PENDING_BYTES;
 if(file.role==='history-pending')return 16*1024*1024;
 if(file.role==='writeback-journal')return file.path.endsWith('/0000.json')?1024*1024:65536;
 return CATALOG_BACKUP_MAX_FILE;
}
export function readBackupFile(value:unknown):BackupFile{
 const v=fields(value,['path','role','bytes','sha256']),role=backupPathRole(v.path);
 if(v.role!==role||typeof v.sha256!=='string'||!/^[a-f0-9]{64}$/.test(v.sha256))throw new Error('备份条目类型或摘要无效');
 const file={path:v.path as string,role,bytes:bytes(v.bytes,CATALOG_BACKUP_MAX_FILE),sha256:v.sha256};
 if(file.bytes>backupFileLimit(file)||role==='database'&&file.bytes<512)throw new Error('备份条目大小无效');return file;
}
export function readBackupCounts(value:unknown):BackupCounts{
 const v=fields(value,CATALOG_BACKUP_COUNT_TABLES),out={} as BackupCounts;
 for(const key of CATALOG_BACKUP_COUNT_TABLES)out[key]=bytes(v[key],Number.MAX_SAFE_INTEGER);return out;
}
export function readCatalogBackupManifest(value:unknown):CatalogBackupManifest{
 const v=fields(value,['format','version','backupId','createdAt','appVersion','schema','origin','capture','counts','plugins','cache','externalMedia','systemCredentials','externalWriteback','files']);
 if(v.format!=='aural-catalog-backup'||v.version!==1||!([68,69,70,71,72,73,74,75,76,77,CATALOG_BACKUP_SCHEMA] as unknown[]).includes(v.schema)||v.capture!=='quiesced-v1'||v.cache!=='database-resident'||v.externalMedia!=='excluded'||v.systemCredentials!=='excluded'||v.externalWriteback!=='requires-original-source')throw new Error('不支持的曲库备份版本或捕获范围');
 if(!Array.isArray(v.files)||v.files.length<2||v.files.length>CATALOG_BACKUP_MAX_FILES||!Array.isArray(v.plugins)||v.plugins.length>128)throw new Error('备份清单数量无效');
 const files=v.files.map(readBackupFile),seen=new Set<string>();let total=0,previous='';
 for(const file of files){
  if(file.path<=previous||seen.has(file.path.toLowerCase()))throw new Error('备份条目重复、大小写冲突或未按路径排序');seen.add(file.path.toLowerCase());previous=file.path;total+=file.bytes;
  if(total>CATALOG_BACKUP_MAX_PAYLOAD)throw new Error('备份总大小超过64GiB');
 }
 if(!seen.has('library/library.db')||!seen.has('state/renderer-pending.json'))throw new Error('备份缺少曲库或界面待核对资料');
 // Preserve even interrupted journal bytes. A valid archive never certifies a
 // writeback operation; the recovery coordinator must separately inspect its chain.
 const pluginIds=new Set<string>();let previousPlugin='';const plugins=v.plugins.map(raw=>{
  const p=fields(raw,['id','version']);if(typeof p.id!=='string'||!/^[a-z][a-z0-9.-]{0,127}$/.test(p.id)||pluginIds.has(p.id)||p.id<=previousPlugin)throw new Error('备份插件清单无效');pluginIds.add(p.id);previousPlugin=p.id;return {id:p.id,version:componentVersion(p.version)};
 });
 const result:CatalogBackupManifest={format:'aural-catalog-backup',version:1,backupId:backupUuid(v.backupId),createdAt:instant(v.createdAt),appVersion:version(v.appVersion),schema:v.schema as 68|69|70|71|72|73|74|75|76|77|78,origin:backupUuid(v.origin),capture:'quiesced-v1',counts:readBackupCounts(v.counts),plugins,cache:'database-resident',externalMedia:'excluded',systemCredentials:'excluded',externalWriteback:'requires-original-source',files};
 if(new TextEncoder().encode(JSON.stringify(result)).byteLength>CATALOG_BACKUP_MAX_MANIFEST)throw new Error('规范备份清单超过2MiB预算');return result;
}
export function backupPendingKey(value:unknown):string{
 if(typeof value!=='string'||value.length>128)throw new Error('界面待核对资料键无效');
 if((CATALOG_BACKUP_PENDING_KEYS as readonly string[]).includes(value))return value;
 const prefix='aural-playback-policy-pending-v2.invalid.';if(value.startsWith(prefix)){backupUuid(value.slice(prefix.length));return value;}
 throw new Error('不允许备份此界面存储项');
}
export function readRendererPendingSnapshot(value:unknown):RendererPendingSnapshot{
 const v=fields(value,['version','capturedAt','values']);if(v.version!==1||!Array.isArray(v.values)||v.values.length>128)throw new Error('界面待核对资料版本或数量无效');
 let previous='',total=0;const values=v.values.map(raw=>{
  const p=fields(raw,['key','raw']),key=backupPendingKey(p.key);
  if(key<=previous||typeof p.raw!=='string'||p.raw.length>2*1024*1024)throw new Error('界面待核对资料重复、过长或无效');previous=key;total+=p.raw.length;
  if(total>CATALOG_BACKUP_PENDING_BYTES)throw new Error('界面待核对资料超过预算');return {key,raw:p.raw};
 });const result:RendererPendingSnapshot={version:1,capturedAt:instant(v.capturedAt),values};if(new TextEncoder().encode(JSON.stringify(result)).byteLength>CATALOG_BACKUP_PENDING_BYTES)throw new Error('编码后的界面待核对资料超过4MiB预算');return result;
}
