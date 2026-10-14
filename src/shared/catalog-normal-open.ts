import {backupUuid} from './catalog-backup.js';
import {readRestoreIdentity} from './catalog-restore.js';
import {restoreTransactionFields as fields,restoreTransactionDigest as digest} from './catalog-restore-transaction.js';
export type NormalLibraryPermission={version:1;completionId:string;recordSha256:string;libraryIdentity:string;origin:string};
export function readNormalLibraryPermission(value:unknown):NormalLibraryPermission{
 const v=fields(value,['version','completionId','recordSha256','libraryIdentity','origin']);if(v.version!==1)throw new Error('已完成恢复的普通启动准入版本无效');return {version:1,completionId:backupUuid(v.completionId),recordSha256:digest(v.recordSha256),libraryIdentity:readRestoreIdentity(v.libraryIdentity),origin:backupUuid(v.origin)};
}
