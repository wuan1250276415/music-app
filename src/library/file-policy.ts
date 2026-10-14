import type {DatabaseSync} from 'node:sqlite';
import {readFilePolicyRequest,type FilePolicyView,type FilePolicyResult,type FilePolicyPage,type FileLibraryState} from '../shared/file-policy.js';

export const filePolicySchema=`
 CREATE TABLE media_file_policy(file_id TEXT PRIMARY KEY REFERENCES media_file(id) ON DELETE CASCADE,revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740990),state TEXT NOT NULL CHECK(state IN('active','removed','ignored')),restore_command TEXT,updated_at INTEGER NOT NULL);
 CREATE INDEX media_file_policy_pending ON media_file_policy(restore_command) WHERE restore_command IS NOT NULL;
 CREATE TABLE file_policy_command(command_id TEXT PRIMARY KEY,request_json TEXT NOT NULL CHECK(json_valid(request_json)),result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at INTEGER NOT NULL);
 CREATE TRIGGER file_policy_command_immutable BEFORE UPDATE ON file_policy_command BEGIN SELECT RAISE(ABORT,'文件管理回执不可修改'); END;
 CREATE TRIGGER file_policy_command_no_delete BEFORE DELETE ON file_policy_command BEGIN SELECT RAISE(ABORT,'文件管理回执不可删除'); END;
 ALTER TABLE playable_item ADD COLUMN library_state TEXT NOT NULL DEFAULT 'active' CHECK(library_state IN('active','removed','ignored'));
 CREATE INDEX playable_item_library_state ON playable_item(library_state,visible,id);
 CREATE TRIGGER file_policy_insert AFTER INSERT ON media_file_policy BEGIN UPDATE playable_item SET library_state=NEW.state WHERE file_id=NEW.file_id; END;
 CREATE TRIGGER file_policy_update AFTER UPDATE OF state ON media_file_policy BEGIN UPDATE playable_item SET library_state=NEW.state WHERE file_id=NEW.file_id; END;
 CREATE TRIGGER file_policy_item_insert AFTER INSERT ON playable_item BEGIN UPDATE playable_item SET library_state=COALESCE((SELECT state FROM media_file_policy WHERE file_id=NEW.file_id),'active') WHERE id=NEW.id; END;
 CREATE TRIGGER file_policy_item_rebind AFTER UPDATE OF file_id ON playable_item WHEN OLD.file_id<>NEW.file_id BEGIN UPDATE playable_item SET library_state=COALESCE((SELECT state FROM media_file_policy WHERE file_id=NEW.file_id),'active') WHERE id=NEW.id; END;
`;
export class FilePolicyRepository{
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T,private readonly stamp:()=>string){}
 view(fileId:unknown):FilePolicyView{
  if(typeof fileId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(fileId))throw new Error('无效音乐文件');
  const row=this.db.prepare(`SELECT f.id,f.root_id,f.relative_path,r.path root_path,COALESCE(s.revision,0) revision,COALESCE(s.state,'active') state,s.restore_command,
   o.stamp,(SELECT title FROM playable_item WHERE file_id=f.id ORDER BY kind,id LIMIT 1) title,(SELECT artist FROM playable_item WHERE file_id=f.id ORDER BY kind,id LIMIT 1) artist,
   (SELECT count(*) FROM playable_item WHERE file_id=f.id) item_count,(SELECT count(*) FROM playable_item WHERE file_id=f.id AND kind='cue') cue_count,
   (SELECT count(*) FROM item_user_state u JOIN playable_item p ON p.id=u.item_id WHERE p.file_id=f.id AND u.favorite=1) favorite_count,
   (SELECT count(*) FROM playlist_item pi JOIN playable_item p ON p.id=pi.item_id WHERE p.file_id=f.id) playlist_count
   FROM media_file f JOIN library_root r ON r.id=f.root_id LEFT JOIN media_file_policy s ON s.file_id=f.id LEFT JOIN media_file_observation o ON o.file_id=f.id AND o.algorithm='node-bigint-stat-v1' WHERE f.id=?`).get(fileId) as Record<string,unknown>|undefined;
  if(!row)throw new Error('音乐文件记录不存在');
  return {fileId,rootId:String(row.root_id),rootPath:String(row.root_path),relativePath:String(row.relative_path),title:String(row.title??row.relative_path),artist:String(row.artist??''),revision:Number(row.revision),state:row.state as FileLibraryState,observation:row.stamp===null?null:String(row.stamp),itemCount:Number(row.item_count),cueCount:Number(row.cue_count),favoriteCount:Number(row.favorite_count),playlistCount:Number(row.playlist_count),restorePending:row.restore_command!==null};
 }
 ignored(rootId:string,relative:string):boolean{return Boolean(this.db.prepare("SELECT 1 FROM media_file f JOIN media_file_policy s ON s.file_id=f.id WHERE f.root_id=? AND f.path_key=? AND s.state='ignored'").get(rootId,relative.normalize('NFKC').toLocaleLowerCase().trim()));}
 receipt(value:unknown):FilePolicyResult|null{
  const r=readFilePolicyRequest(value),old=this.db.prepare('SELECT request_json,result_json FROM file_policy_command WHERE command_id=?').get(r.commandId) as {request_json:string;result_json:string}|undefined;
  if(!old)return null;if(old.request_json!==JSON.stringify(r))throw new Error('同一文件操作不可更改内容');return JSON.parse(old.result_json) as FilePolicyResult;
 }
 command(value:unknown):FilePolicyResult{
  const r=readFilePolicyRequest(value),old=this.receipt(r);if(old)return old;
  const before=this.view(r.fileId);if(before.revision!==r.baseRevision||before.observation!==r.observation)return {status:'rejected',view:before,error:'文件资料或管理状态已变化，请重新读取'};
  if(before.revision>=Number.MAX_SAFE_INTEGER-1)throw new Error('文件管理修订已耗尽');
  // Write/commit errors propagate as unknown; replay uses the original UUID.
  return this.transaction(()=>{
   const latest=this.view(r.fileId);if(latest.revision!==r.baseRevision||latest.observation!==r.observation)throw new Error('文件资料已变化');
   const state=r.action==='remove'?'removed':r.action==='ignore'?'ignored':'active';
   this.db.prepare('INSERT INTO media_file_policy(file_id,revision,state,restore_command,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,restore_command=excluded.restore_command,updated_at=excluded.updated_at').run(r.fileId,before.revision+1,state,r.action==='restore'?r.commandId:null,Date.now());
   if(r.action==='restore'){this.db.prepare('DELETE FROM media_file_observation WHERE file_id=?').run(r.fileId);this.db.prepare("UPDATE media_file SET status='missing',seen_generation=-1 WHERE id=?").run(r.fileId);}
   const result:FilePolicyResult={status:'saved',view:this.view(r.fileId),error:''};
   this.db.prepare('INSERT INTO file_policy_command(command_id,request_json,result_json,created_at) VALUES(?,?,?,?)').run(r.commandId,JSON.stringify(r),JSON.stringify(result),Date.now());return result;
  });
 }
 parsed(fileId:string):void{this.db.prepare('UPDATE media_file_policy SET restore_command=NULL WHERE file_id=? AND restore_command IS NOT NULL').run(fileId);}
 pendingRestores():Array<{rootId:string;commandId:string}>{return this.db.prepare('SELECT f.root_id rootId,min(s.restore_command) commandId FROM media_file_policy s JOIN media_file f ON f.id=s.file_id WHERE s.state=\'active\' AND s.restore_command IS NOT NULL AND NOT EXISTS(SELECT 1 FROM scan_command c WHERE c.command_id=s.restore_command) GROUP BY f.root_id ORDER BY min(s.updated_at),f.root_id LIMIT 64').all() as Array<{rootId:string;commandId:string}>;}
 list(cursor?:string):FilePolicyPage{
  const snapshot=this.stamp();let after='';
  if(cursor!==undefined){if(typeof cursor!=='string'||cursor.length>1024)throw new Error('无效文件管理分页');try{const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(c.snapshot!==snapshot||typeof c.after!=='string'||c.after.length>128)throw new Error();after=c.after;}catch{throw new Error('文件管理列表已变化，请重新读取');}}
  const rows=this.db.prepare("SELECT file_id FROM media_file_policy WHERE (state<>'active' OR restore_command IS NOT NULL) AND file_id>? ORDER BY file_id LIMIT 51").all(after) as {file_id:string}[];
  return {items:rows.slice(0,50).map(r=>this.view(r.file_id)),nextCursor:rows.length>50?Buffer.from(JSON.stringify({snapshot,after:rows[49].file_id})).toString('base64url'):null,error:''};
 }
}
