import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {SMART_PLAYLIST_PAGE_SIZE,readSmartPlaylistDefinition,readSmartPlaylistMutation,readSmartPlaylistPageRequest,smartPlaylistId,type SmartPlaylistDetail,type SmartPlaylistSummary,type SmartPlaylistPage} from '../shared/smart-playlists.js';

export const smartPlaylistSchema=`
 CREATE TABLE playlist_next(id TEXT PRIMARY KEY,name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),kind TEXT NOT NULL CHECK(kind IN('static','smart')),revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,filter_json TEXT,
 CHECK((kind='static' AND filter_json IS NULL) OR (kind='smart' AND filter_json IS NOT NULL AND json_valid(filter_json))));
 INSERT INTO playlist_next SELECT id,name,kind,revision,created_at,updated_at,NULL FROM playlist;
 CREATE TABLE playlist_item_next(playlist_id TEXT NOT NULL REFERENCES playlist_next(id) ON DELETE CASCADE,entry_id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES playable_item(id) ON DELETE RESTRICT,position INTEGER NOT NULL CHECK(position>=0),UNIQUE(playlist_id,position));
 INSERT INTO playlist_item_next SELECT * FROM playlist_item;
 DROP TABLE playlist_item; DROP TABLE playlist;
 ALTER TABLE playlist_next RENAME TO playlist; ALTER TABLE playlist_item_next RENAME TO playlist_item;
 CREATE INDEX idx_playlist_item_ref ON playlist_item(item_id);
 CREATE INDEX playlist_kind_name ON playlist(kind,name,id);
 CREATE TRIGGER playlist_kind_immutable BEFORE UPDATE OF kind ON playlist WHEN NEW.kind!=OLD.kind BEGIN SELECT RAISE(ABORT,'歌单类型不可转换'); END;
 CREATE TRIGGER playlist_static_entry_insert BEFORE INSERT ON playlist_item WHEN (SELECT kind FROM playlist WHERE id=NEW.playlist_id)!='static' BEGIN SELECT RAISE(ABORT,'智能歌单不能添加固定条目'); END;
 CREATE TRIGGER playlist_static_entry_update BEFORE UPDATE ON playlist_item WHEN (SELECT kind FROM playlist WHERE id=NEW.playlist_id)!='static' BEGIN SELECT RAISE(ABORT,'智能歌单不能添加固定条目'); END;
 CREATE TABLE playlist_smart_history(playlist_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),action TEXT NOT NULL CHECK(action IN('create','update','delete')),command_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),created_at TEXT NOT NULL,PRIMARY KEY(playlist_id,revision));
 CREATE TRIGGER playlist_smart_history_immutable BEFORE UPDATE ON playlist_smart_history BEGIN SELECT RAISE(ABORT,'智能歌单历史不可修改'); END;
 CREATE TRIGGER playlist_smart_history_no_delete BEFORE DELETE ON playlist_smart_history BEGIN SELECT RAISE(ABORT,'智能歌单历史不可删除'); END;
`;
type Row=SmartPlaylistSummary&{filter_json:string};
export class SmartPlaylists{
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(fn:()=>T)=>T,private readonly stamp:()=>string){}
 maybe(id:string):SmartPlaylistDetail|null{
  const row=this.db.prepare("SELECT id,name,revision,created_at createdAt,updated_at updatedAt,filter_json FROM playlist WHERE id=? AND kind='smart'").get(id) as Row|undefined;
  if(!row)return null;const {filter_json,...summary}=row;return {...summary,definition:readSmartPlaylistDefinition(JSON.parse(filter_json))};
 }
 get(v:unknown):SmartPlaylistDetail{const value=this.maybe(smartPlaylistId(v));if(!value)throw new Error('智能歌单不存在或已删除');return value;}
 result(v:unknown):import('../shared/smart-playlists.js').SmartPlaylistResult{
  const request=readSmartPlaylistMutation(v);
  try{return {status:'saved',value:this.mutate(request),error:''};}
  catch(e){
   if(this.db.isTransaction)throw e;
   const row=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(request.commandId) as {fingerprint:string;result_json:string}|undefined;
   const fingerprint=createHash('sha256').update('smart-playlist-v1:').update(JSON.stringify(request)).digest('hex');
   if(row?.fingerprint===fingerprint)return {status:'saved',value:JSON.parse(row.result_json) as SmartPlaylistDetail|null,error:''};
   return {status:'rejected',value:null,error:String(e instanceof Error?e.message:e).slice(0,512)};
  }
 }
 list(v:unknown):SmartPlaylistPage{
  const r=readSmartPlaylistPageRequest(v),snapshot=()=>createHash('sha256').update(this.stamp()).update('smart-playlist-list-v1').digest('hex'),before=snapshot();
  const stale=():SmartPlaylistPage=>({version:1,status:'stale',snapshot:snapshot(),offset:r.offset,total:0,items:[]});if(r.snapshot&&r.snapshot!==before)return stale();
  const total=Number((this.db.prepare("SELECT COUNT(*) count FROM playlist WHERE kind='smart'").get() as {count:number}).count);
  const items=this.db.prepare("SELECT id,name,revision,created_at createdAt,updated_at updatedAt FROM playlist WHERE kind='smart' ORDER BY aural_natural_key_v1(name),id LIMIT ? OFFSET ?").all(SMART_PLAYLIST_PAGE_SIZE,r.offset) as SmartPlaylistSummary[];
  return snapshot()===before?{version:1,status:'ready',snapshot:before,offset:r.offset,total,items}:stale();
 }
 mutate(v:unknown):SmartPlaylistDetail|null{
  const r=readSmartPlaylistMutation(v),fingerprint=createHash('sha256').update('smart-playlist-v1:').update(JSON.stringify(r)).digest('hex');
  return this.transaction(()=>{
   const receipt=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(r.commandId) as {fingerprint:string;result_json:string}|undefined;
   if(receipt){if(receipt.fingerprint!==fingerprint)throw new Error('操作身份已用于另一请求');return JSON.parse(receipt.result_json) as SmartPlaylistDetail|null;}
   const before=r.action==='create'?null:this.get(r.id);if(before&&r.action!=='create'&&before.revision!==r.baseRevision)throw new Error('智能歌单已变化，请重新读取后编辑');
   const id=before?.id??randomUUID(),now=new Date().toISOString(),revision=before?before.revision+1:0;
   if(r.action==='create')this.db.prepare("INSERT INTO playlist(id,name,kind,revision,created_at,updated_at,filter_json) VALUES(?,?,'smart',0,?,?,?)").run(id,r.name,now,now,JSON.stringify(r.definition));
   else if(r.action==='update')this.db.prepare("UPDATE playlist SET name=?,filter_json=?,revision=?,updated_at=? WHERE id=? AND kind='smart'").run(r.name,JSON.stringify(r.definition),revision,now,id);
   else this.db.prepare("DELETE FROM playlist WHERE id=? AND kind='smart'").run(id);
   this.db.prepare('INSERT INTO playlist_smart_history(playlist_id,revision,action,command_id,name,definition_json,created_at) VALUES(?,?,?,?,?,?,?)').run(id,revision,r.action,r.commandId,r.action==='delete'?before!.name:r.name,JSON.stringify(r.action==='delete'?before!.definition:r.definition),now);
   const result=r.action==='delete'?null:this.get(id);
   this.db.prepare('INSERT INTO user_command_receipt VALUES(?,?,?,?)').run(r.commandId,fingerprint,JSON.stringify(result),now);return result;
  });
 }
}
