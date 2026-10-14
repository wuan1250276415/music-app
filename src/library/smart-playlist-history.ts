import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {readSmartPlaylistDefinition,readSmartPlaylistDetail,type SmartPlaylistDetail} from '../shared/smart-playlists.js';
import {SMART_HISTORY_PAGE_SIZE,readSmartHistoryRequest,readSmartHistoryDetailRequest,readSmartHistoryDetail,readSmartHistoryPage,readSmartPlaylistRestoreRequest,smartHistoryNumber,type SmartHistorySummary,type SmartHistoryPage,type SmartHistoryDetail,type SmartPlaylistRestoreRequest,type SmartPlaylistRestoreResult} from '../shared/smart-playlist-history.js';

export const smartPlaylistHistorySchema=`
 CREATE TABLE playlist_smart_history_next(
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT CHECK(ordinal BETWEEN 1 AND 9007199254740991),
  playlist_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),action TEXT NOT NULL CHECK(action IN('create','update','delete','restore')),
  command_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),created_at TEXT NOT NULL,
  source_revision INTEGER,source_fingerprint TEXT,
  UNIQUE(playlist_id,revision),FOREIGN KEY(playlist_id,source_revision) REFERENCES playlist_smart_history_next(playlist_id,revision) ON DELETE RESTRICT,
  CHECK((action='restore' AND source_revision IS NOT NULL AND source_revision>=0 AND source_revision<revision AND source_fingerprint IS NOT NULL AND length(source_fingerprint)=64) OR (action!='restore' AND source_revision IS NULL AND source_fingerprint IS NULL))
 );
 INSERT INTO playlist_smart_history_next(ordinal,playlist_id,revision,action,command_id,name,definition_json,created_at) SELECT rowid,playlist_id,revision,action,command_id,name,definition_json,created_at FROM playlist_smart_history;
 DROP TRIGGER playlist_smart_history_immutable; DROP TRIGGER playlist_smart_history_no_delete; DROP TABLE playlist_smart_history;
 ALTER TABLE playlist_smart_history_next RENAME TO playlist_smart_history;
 CREATE INDEX playlist_smart_history_by_playlist ON playlist_smart_history(playlist_id,ordinal DESC);
 CREATE TRIGGER playlist_smart_history_immutable BEFORE UPDATE ON playlist_smart_history BEGIN SELECT RAISE(ABORT,'智能歌单历史不可修改'); END;
 CREATE TRIGGER playlist_smart_history_no_delete BEFORE DELETE ON playlist_smart_history BEGIN SELECT RAISE(ABORT,'智能歌单历史不可删除'); END;
`;
type Row={ordinal:number;playlist_id:string;revision:number;action:SmartHistorySummary['action'];command_id:string;name:string;definition_json:string;created_at:string;source_revision:number|null;source_fingerprint:string|null};
type Receipt={fingerprint:string;result_json:string};
type Point={version:1;scope:string|null;epoch:string;watermark:number;before:number};
function sourceFingerprint(row:Row):string{
 // Keep raw historical definition bytes and original fields in the source proof.
 return createHash('sha256').update('smart-playlist-history-source-v1:').update(JSON.stringify({playlistId:row.playlist_id,revision:row.revision,action:row.action,commandId:row.command_id,name:row.name,definitionJson:row.definition_json,createdAt:row.created_at,sourceRevision:row.source_revision,sourceFingerprint:row.source_fingerprint})).digest('hex');
}
function summary(row:Row):SmartHistorySummary{
 return {ordinal:row.ordinal,playlistId:row.playlist_id,revision:row.revision,action:row.action,name:row.name,createdAt:row.created_at,fingerprint:sourceFingerprint(row),sourceRevision:row.source_revision,sourceFingerprint:row.source_fingerprint};
}
function requestFingerprint(request:SmartPlaylistRestoreRequest):string{
 return createHash('sha256').update('smart-playlist-restore-v1:').update(JSON.stringify(request)).digest('hex');
}
export class SmartPlaylistHistory {
 private readonly epoch=randomUUID();private readonly secret=randomBytes(32);
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(fn:()=>T)=>T,private readonly current:(id:string)=>SmartPlaylistDetail|null){}
 private cursor(point:Point):string{
  const payload=Buffer.from(JSON.stringify(point)).toString('base64url');return `${payload}.${createHmac('sha256',this.secret).update(payload).digest('hex')}`;
 }
 private point(cursor:string,scope:string|null):Point{
  const [payload,digest]=cursor.split('.'),expected=createHmac('sha256',this.secret).update(payload).digest();
  if(!timingSafeEqual(Buffer.from(digest,'hex'),expected))throw new Error('智能规则历史游标已过期或无效，请刷新');
  const raw:unknown=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==5||!['version','scope','epoch','watermark','before'].every(key=>Object.hasOwn(raw,key)))throw new Error('智能规则历史游标字段无效');
  const p=raw as Point;
  if(p.version!==1||p.scope!==scope||p.epoch!==this.epoch||smartHistoryNumber(p.before,1)>smartHistoryNumber(p.watermark,1)||Buffer.from(JSON.stringify(p)).toString('base64url')!==payload)throw new Error('智能规则历史游标范围已变化，请刷新');
  return p;
 }
 list(value:unknown):SmartHistoryPage{
  const request=readSmartHistoryRequest(value),scope=request.playlistId??null,point=request.cursor?this.point(request.cursor,scope):null;
  const maximum=Number((this.db.prepare('SELECT COALESCE(MAX(ordinal),0) n FROM playlist_smart_history').get() as {n:number}).n),watermark=point?.watermark??maximum;
  if(watermark>maximum)throw new Error('智能规则历史已回退，请刷新');
  const rows=this.db.prepare(`SELECT * FROM playlist_smart_history WHERE ordinal<=?${point?' AND ordinal<?':''}${scope!==null?' AND playlist_id=?':''} ORDER BY ordinal DESC LIMIT ?`).all(watermark,...(point?[point.before]:[]),...(scope!==null?[scope]:[]),SMART_HISTORY_PAGE_SIZE+1) as Row[];
  const items=rows.slice(0,SMART_HISTORY_PAGE_SIZE).map(summary),last=items.at(-1);
  return readSmartHistoryPage({version:1,playlistId:scope,watermark,items,nextCursor:rows.length>SMART_HISTORY_PAGE_SIZE&&last?this.cursor({version:1,scope,epoch:this.epoch,watermark,before:last.ordinal}):null});
 }
 private row(playlistId:string,revision:number):Row{
  const row=this.db.prepare('SELECT * FROM playlist_smart_history WHERE playlist_id=? AND revision=?').get(playlistId,revision) as Row|undefined;
  if(!row)throw new Error('智能规则历史不存在');
  if(row.action==='restore'){
   const parent=this.db.prepare('SELECT * FROM playlist_smart_history WHERE playlist_id=? AND revision=?').get(playlistId,row.source_revision!) as Row|undefined;
   if(!parent||sourceFingerprint(parent)!==row.source_fingerprint)throw new Error('历史恢复来源核对失败，请保留数据库并检查');
  }
  return row;
 }
 detail(value:unknown):SmartHistoryDetail{
  const r=readSmartHistoryDetailRequest(value),source=this.row(r.playlistId,r.revision);
  const head=this.db.prepare('SELECT * FROM playlist_smart_history WHERE playlist_id=? ORDER BY revision DESC LIMIT 1').get(r.playlistId) as Row;
  const current=this.current(r.playlistId),existing=this.db.prepare('SELECT kind FROM playlist WHERE id=?').get(r.playlistId) as {kind:string}|undefined;
  if(existing&&existing.kind!=='smart')throw new Error('历史身份已被其他歌单类型占用');
  if(current?(current.revision!==head.revision||head.action==='delete'||current.name!==head.name||JSON.stringify(current.definition)!==JSON.stringify(readSmartPlaylistDefinition(JSON.parse(head.definition_json)))):head.action!=='delete')throw new Error('当前规则与历史末尾不一致，请保留数据库并检查');
  return readSmartHistoryDetail({version:1,record:{...summary(source),definition:readSmartPlaylistDefinition(JSON.parse(source.definition_json))},headRevision:head.revision,current});
 }
 private receipt(commandId:string):Receipt|undefined{return this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as Receipt|undefined;}
 restore(value:unknown):SmartPlaylistRestoreResult&{changed:boolean}{
  const request=readSmartPlaylistRestoreRequest(value),fingerprint=requestFingerprint(request);
  try{
   const result=this.transaction(()=>{
    const receipt=this.receipt(request.commandId);
    if(receipt){if(receipt.fingerprint!==fingerprint)throw new Error('操作身份已用于另一请求');return {value:readSmartPlaylistDetail(JSON.parse(receipt.result_json)),changed:false};}
    const detail=this.detail({playlistId:request.playlistId,revision:request.sourceRevision});
    if(detail.record.fingerprint!==request.sourceFingerprint)throw new Error('历史规则来源已变化，请重新读取');
    if(detail.headRevision!==request.headRevision||(detail.current?.revision??null)!==request.baseRevision)throw new Error('当前规则或删除状态已变化，请重新读取后恢复');
    const now=new Date().toISOString(),revision=request.headRevision+1,definition=JSON.stringify(detail.record.definition);
    if(detail.current)this.db.prepare("UPDATE playlist SET name=?,filter_json=?,revision=?,updated_at=? WHERE id=? AND kind='smart' AND revision=?").run(detail.record.name,definition,revision,now,request.playlistId,request.baseRevision!);
    else{
     const first=this.db.prepare('SELECT revision,action,created_at FROM playlist_smart_history WHERE playlist_id=? ORDER BY revision LIMIT 1').get(request.playlistId) as {revision:number;action:string;created_at:string};
     if(first.revision!==0||first.action!=='create')throw new Error('缺少原始创建历史，无法恢复原身份');
     this.db.prepare("INSERT INTO playlist(id,name,kind,revision,created_at,updated_at,filter_json) VALUES(?,?,'smart',?,?,?,?)").run(request.playlistId,detail.record.name,revision,first.created_at,now,definition);
    }
    this.db.prepare("INSERT INTO playlist_smart_history(playlist_id,revision,action,command_id,name,definition_json,created_at,source_revision,source_fingerprint) VALUES(?,?,'restore',?,?,?,?,?,?)").run(request.playlistId,revision,request.commandId,detail.record.name,definition,now,request.sourceRevision,request.sourceFingerprint);
    const current=this.current(request.playlistId);if(!current||current.revision!==revision)throw new Error('恢复结果未保存到当前规则');
    const restored=readSmartPlaylistDetail(current);
    this.db.prepare('INSERT INTO user_command_receipt VALUES(?,?,?,?)').run(request.commandId,fingerprint,JSON.stringify(restored),now);
    return {value:restored,changed:true};
   });
   return {commandId:request.commandId,status:'saved',value:result.value,error:'',changed:result.changed};
  }catch(error){
   if(this.db.isTransaction)throw error;
   const receipt=this.receipt(request.commandId);
   if(receipt?.fingerprint===fingerprint)return {commandId:request.commandId,status:'saved',value:readSmartPlaylistDetail(JSON.parse(receipt.result_json)),error:'',changed:false};
   return {commandId:request.commandId,status:'rejected',value:null,error:String(error instanceof Error?error.message:error).slice(0,512),changed:false};
  }
 }
}
