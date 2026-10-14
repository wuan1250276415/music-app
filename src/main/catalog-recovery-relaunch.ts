import {readNormalLibraryPermission,type NormalLibraryPermission} from '../shared/catalog-normal-open.js';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import {assertCatalogRestoreStartupSafe,inspectCatalogRestoreStartup,RestoreStartupBlocked} from './catalog-restore-startup.js';

const prefix='--aural-recovery-open=';
// Preserve runtime/bootstrap switches, but do not replay the previous file-open
// request. The fresh process must open the same completed existing library; a
// removed history/root cannot downgrade this request into empty-library creation.
export function recoveryRelaunchArguments(argv:string[],files:readonly string[],permission:NormalLibraryPermission):string[]{
 const fileSet=new Set(files),ticket=Buffer.from(JSON.stringify(readNormalLibraryPermission(permission))).toString('base64url');
 return [...argv.slice(1).filter(value=>!fileSet.has(value)&&!value.startsWith(prefix)),prefix+ticket];
}
function expectedPermission(argv:string[]):NormalLibraryPermission|null{
 const values=argv.filter(value=>value.startsWith(prefix));if(!values.length)return null;
 if(values.length!==1||values[0].length>4096)throw new RestoreStartupBlocked('重新启动的现有曲库选择无效，资料保持。',null);
 try{const encoded=values[0].slice(prefix.length);if(!/^[A-Za-z0-9_-]+$/.test(encoded))throw new Error('编码无效');const bytes=Buffer.from(encoded,'base64url');if(bytes.toString('base64url')!==encoded||bytes.length>2048)throw new Error('编码预算无效');
  const permission=readNormalLibraryPermission(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));if(!bytes.equals(Buffer.from(JSON.stringify(permission))))throw new Error('选择不是规范记录');return permission;
 }catch{throw new RestoreStartupBlocked('重新启动的现有曲库选择无法确认，资料保持。',null);}
}
export async function verifyNormalStartupAdmission(userData:string,argv:string[]):Promise<NormalLibraryPermission|null>{
 const expected=expectedPermission(argv),actual=await assertCatalogRestoreStartupSafe(userData);
 if(expected&&(!actual||lifecycleDigest(actual)!==lifecycleDigest(expected)))throw new RestoreStartupBlocked('重新启动时已完成恢复的选择或目录记录发生变化，已停止打开曲库。',await inspectCatalogRestoreStartup(userData));
 return actual;
}
