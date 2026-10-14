import {backupPendingKey,CATALOG_BACKUP_PENDING_KEYS,readRendererPendingSnapshot,type RendererPendingSnapshot} from '../shared/catalog-backup.js';

// The maintenance coordinator must freeze mutations before and throughout capture.
// Raw requests (including quarantined text) are retained; capture never executes them.
export function captureRendererBackupPending(storage:Storage=localStorage):RendererPendingSnapshot{
 const keys:string[]=[];
 for(let i=0;i<storage.length;i++){
  const key=storage.key(i);if(key!==null&&((CATALOG_BACKUP_PENDING_KEYS as readonly string[]).includes(key)||key.startsWith('aural-playback-policy-pending-v2.invalid.')))keys.push(backupPendingKey(key));
 }
 keys.sort();const values=keys.map(key=>{const raw=storage.getItem(key);if(raw===null)throw new Error('待核对操作在备份读取期间发生变化');return {key,raw};});
 const result=readRendererPendingSnapshot({version:1,capturedAt:new Date().toISOString(),values});
 const after:string[]=[];
 for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key!==null&&((CATALOG_BACKUP_PENDING_KEYS as readonly string[]).includes(key)||key.startsWith('aural-playback-policy-pending-v2.invalid.')))after.push(backupPendingKey(key));}
 after.sort();if(JSON.stringify(after)!==JSON.stringify(keys)||values.some(v=>storage.getItem(v.key)!==v.raw))throw new Error('待核对资料发生变化，请重新取得备份快照');return result;
}
