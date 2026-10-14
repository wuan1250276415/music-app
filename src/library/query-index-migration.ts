import {DatabaseSync} from 'node:sqlite';
import {lstatSync,statfsSync,openSync,closeSync,fstatSync,fsyncSync} from 'node:fs';
import path from 'node:path';
import {readLibrarySchema} from './schema-snapshot.js';
import {cuePathKey} from './cue-history.js';
import type {LibraryStartupPhase} from '../shared/startup-progress.js';

export const queryIndexSchema=`
 CREATE INDEX playable_item_search_cover ON playable_item(id,visible,library_state,title,artist,album,genre,release_track_id,artist_credit_id);
 CREATE INDEX item_sort_release_cover ON item_sort_key(item_id,algorithm,release_key);
`;
const tables=['media_file','playable_item','recording','release','release_track','artist','metadata_override','item_user_state','playlist_item','playback_history','cue_document','search_latin','item_sort_key'] as const;
export type QueryUpgradeCounts=Record<typeof tables[number],number>;
function counts(db:DatabaseSync):QueryUpgradeCounts{
 return Object.fromEntries(tables.map(table=>{
  const count=Number(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get()!.count);
  if(!Number.isSafeInteger(count)||count<0)throw new Error('查询索引迁移数据计数无效');return [table,count];
 })) as QueryUpgradeCounts;
}
export function snapshotQueryIndexUpgrade(db:DatabaseSync,filename:string,existing:boolean,progress?:(phase:LibraryStartupPhase)=>void,upgrade={from:72,to:73}):QueryUpgradeCounts{
 const before=counts(db);if(!existing)return before;
 const file=lstatSync(filename,{bigint:true});if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1n)throw new Error('查询索引迁移曲库必须是普通独立文件');
 const volume=statfsSync(path.dirname(path.resolve(filename)),{bigint:true});
 if(volume.bavail*volume.bsize<file.size*2n+128n*1024n*1024n)throw new Error('磁盘空间不足以保存升级快照和新查询索引');
 const snapshot=`${filename}.pre-v${upgrade.to}-${Date.now()}.bak`;
 progress?.('snapshot-save');
 db.exec(`VACUUM INTO '${snapshot.replace(/'/g,"''")}'`);
 const saved=lstatSync(snapshot,{bigint:true});if(!saved.isFile()||saved.isSymbolicLink()||saved.nlink!==1n)throw new Error('查询索引升级快照不是普通独立文件');
 const fd=openSync(snapshot,'r+');try{const held=fstatSync(fd,{bigint:true});if(held.dev!==saved.dev||held.ino!==saved.ino||held.birthtimeNs!==saved.birthtimeNs||held.size!==saved.size)throw new Error('查询索引升级快照身份变化');fsyncSync(fd);}finally{closeSync(fd);}
 let copy:DatabaseSync|undefined;
 progress?.('snapshot-verify');
 try{
  copy=new DatabaseSync(snapshot,{readOnly:true,allowExtension:false});copy.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON');
  copy.function('aural_cue_path_key_v1',{deterministic:true},value=>{if(typeof value!=='string')throw new Error('快照CUE路径键无效');return cuePathKey(value);});
  if(Number(copy.prepare('PRAGMA user_version').get()!.user_version)!==upgrade.from||copy.prepare('PRAGMA journal_mode').get()!.journal_mode!=='delete')throw new Error('曲库迁移快照版本或日志模式无效');
  if(JSON.stringify(readLibrarySchema(copy))!==JSON.stringify(readLibrarySchema(db))||JSON.stringify(counts(copy))!==JSON.stringify(before))throw new Error('查询索引迁移快照结构或关键数据计数不同');
  if(copy.prepare('PRAGMA integrity_check(1)').get()!.integrity_check!=='ok'||copy.prepare('PRAGMA foreign_key_check').get())throw new Error('查询索引迁移快照完整性或外键检查失败');
 }finally{copy?.close();}
 return before;
}
export function verifyQueryIndexUpgrade(db:DatabaseSync,before:QueryUpgradeCounts):void{
 if(JSON.stringify(counts(db))!==JSON.stringify(before))throw new Error('查询索引迁移改变了音乐或用户数据计数');
 if(db.prepare('PRAGMA integrity_check(1)').get()!.integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').get())throw new Error('查询索引迁移完整性或外键检查失败');
}
