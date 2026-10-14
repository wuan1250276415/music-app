import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readHistoryCheckpoint,readHistoryQuery,historyQualifies,type PlaybackHistoryCheckpoint,type PlaybackHistoryPage,type PlaybackHistoryRow,type PlaybackHistoryQuery} from '../shared/playback-history.js';
import type {LibraryItem} from '../shared/contracts.js';
import type {PlaybackPolicySnapshot} from '../shared/playback-policy.js';

export const playbackHistorySchema=`
 CREATE TABLE playback_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,entry_id TEXT NOT NULL,item_id TEXT NOT NULL,
  identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),last_checkpoint INTEGER NOT NULL CHECK(last_checkpoint>0),
  presented_us INTEGER NOT NULL CHECK(presented_us BETWEEN 0 AND 315576000000000),estimated_us INTEGER NOT NULL CHECK(estimated_us BETWEEN 0 AND 315576000000000),
  furthest_us INTEGER NOT NULL CHECK(furthest_us BETWEEN 0 AND 315576000000000),counted INTEGER NOT NULL CHECK(counted IN(0,1)),
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(session_id,entry_id)
 );
 CREATE INDEX playback_history_item_created ON playback_history(item_id,id DESC);
 CREATE TABLE playback_history_checkpoint (
  session_id TEXT NOT NULL,entry_id TEXT NOT NULL,checkpoint INTEGER NOT NULL,fingerprint TEXT NOT NULL,
  PRIMARY KEY(session_id,entry_id,checkpoint),FOREIGN KEY(session_id,entry_id) REFERENCES playback_history(session_id,entry_id)
 );
 CREATE TRIGGER playback_checkpoint_immutable BEFORE UPDATE ON playback_history_checkpoint BEGIN SELECT RAISE(ABORT,'playback checkpoint is immutable');END;
 CREATE TABLE playback_item_stats (
  item_id TEXT PRIMARY KEY,play_count INTEGER NOT NULL CHECK(play_count>=0),presented_us INTEGER NOT NULL CHECK(presented_us>=0),
  estimated_us INTEGER NOT NULL CHECK(estimated_us>=0),last_played_at TEXT NOT NULL
 );
`;
export const playbackStatisticsSchema=`
 ALTER TABLE playback_history ADD COLUMN last_observed_at TEXT NOT NULL DEFAULT '';
 ALTER TABLE playback_history ADD COLUMN observed_basis TEXT NOT NULL DEFAULT 'legacy-start' CHECK(observed_basis IN('legacy-start','observation'));
 UPDATE playback_history SET last_observed_at=created_at;
 ALTER TABLE playback_item_stats ADD COLUMN last_played_basis TEXT NOT NULL DEFAULT 'legacy-start' CHECK(last_played_basis IN('legacy-start','observation'));
 UPDATE playback_item_stats SET last_played_at=COALESCE((SELECT MAX(h.created_at) FROM playback_history h WHERE h.item_id=playback_item_stats.item_id),last_played_at);
 CREATE INDEX playback_stats_count ON playback_item_stats(play_count,item_id);
 CREATE INDEX playback_stats_recency ON playback_item_stats(last_played_at,item_id);
`;
type Stored={id:number;identity_json:string;last_checkpoint:number;presented_us:number;estimated_us:number;furthest_us:number;counted:number;created_at:string;updated_at:string;last_observed_at:string;observed_basis:'legacy-start'|'observation'};
type SaveResult={sessionId:string;entryId:string;checkpoint:number;statistics:{counts:boolean;recency:boolean}};
function identity(c:PlaybackHistoryCheckpoint):string {
 const {checkpoint,presentedUs,estimatedUs,furthestUs,observedAt,...metadata}=c;return JSON.stringify(metadata);
}
export function historyQueryPlan(value:unknown):{request:PlaybackHistoryQuery;params:Array<string|number>;scope:string}{
 const request=readHistoryQuery(value),params:Array<string|number>=[],parts=['1=1'];
 if(request.itemId){parts.push('item_id=?');params.push(request.itemId);}
 if(request.query){parts.push("(json_extract(identity_json,'$.title') LIKE ? ESCAPE '\\' OR json_extract(identity_json,'$.artist') LIKE ? ESCAPE '\\' OR json_extract(identity_json,'$.album') LIKE ? ESCAPE '\\')");const pattern='%'+request.query.replace(/[\\%_]/g,'\\$&')+'%';params.push(pattern,pattern,pattern);}
 return {request,params,scope:parts.join(' AND ')};
}
export class PlaybackHistoryRepository {
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T,private readonly item:(id:string)=>LibraryItem|undefined,private readonly policy:(value:PlaybackPolicySnapshot)=>void){}
 checkpoint(value:unknown):SaveResult {
  const c=readHistoryCheckpoint(value),fingerprint=createHash('sha256').update(JSON.stringify(c)).digest('hex');
  return this.transaction(()=>{
   const prior=this.db.prepare('SELECT fingerprint FROM playback_history_checkpoint WHERE session_id=? AND entry_id=? AND checkpoint=?').get(c.sessionId,c.entryId,c.checkpoint) as {fingerprint:string}|undefined;
   if(prior){if(prior.fingerprint!==fingerprint)throw new Error('播放历史检查点身份已用于不同数据');return {sessionId:c.sessionId,entryId:c.entryId,checkpoint:c.checkpoint,statistics:{counts:false,recency:false}};}
   if(c.policyVersion===2)this.policy(c.policy!);
   const old=this.db.prepare('SELECT * FROM playback_history WHERE session_id=? AND entry_id=?').get(c.sessionId,c.entryId) as Stored|undefined;
   const metadata=identity(c),now=new Date().toISOString();
   if(old&&(old.identity_json!==metadata||c.checkpoint<=old.last_checkpoint||c.presentedUs<old.presented_us||c.estimatedUs<old.estimated_us||c.furthestUs<old.furthest_us))throw new Error('播放历史累计值或曲目身份回退');
   const counted=old?.counted===1||historyQualifies(c),newPlay=counted&&old?.counted!==1?1:0;
   const observed=c.observedAt??c.startedAt,basis=c.observedAt?'observation':'legacy-start';
   const stats=this.db.prepare('SELECT last_played_at,last_played_basis FROM playback_item_stats WHERE item_id=?').get(c.itemId) as {last_played_at:string;last_played_basis:string}|undefined;
   this.db.prepare(`INSERT INTO playback_history(session_id,entry_id,item_id,identity_json,last_checkpoint,presented_us,estimated_us,furthest_us,counted,created_at,updated_at,last_observed_at,observed_basis) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id,entry_id) DO UPDATE SET last_checkpoint=excluded.last_checkpoint,presented_us=excluded.presented_us,estimated_us=excluded.estimated_us,furthest_us=excluded.furthest_us,counted=excluded.counted,updated_at=excluded.updated_at,
    observed_basis=CASE WHEN excluded.last_observed_at>last_observed_at OR excluded.last_observed_at=last_observed_at AND excluded.observed_basis='observation' THEN excluded.observed_basis ELSE observed_basis END,last_observed_at=MAX(last_observed_at,excluded.last_observed_at)`)
    .run(c.sessionId,c.entryId,c.itemId,metadata,c.checkpoint,c.presentedUs,c.estimatedUs,c.furthestUs,counted?1:0,c.startedAt,now,observed,basis);
   this.db.prepare(`INSERT INTO playback_item_stats(item_id,play_count,presented_us,estimated_us,last_played_at,last_played_basis) VALUES(?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET
    play_count=play_count+excluded.play_count,presented_us=presented_us+excluded.presented_us,estimated_us=estimated_us+excluded.estimated_us,
    last_played_basis=CASE WHEN excluded.last_played_at>last_played_at OR excluded.last_played_at=last_played_at AND excluded.last_played_basis='observation' THEN excluded.last_played_basis ELSE last_played_basis END,last_played_at=MAX(last_played_at,excluded.last_played_at)`)
    .run(c.itemId,newPlay,c.presentedUs-(old?.presented_us??0),c.estimatedUs-(old?.estimated_us??0),observed,basis);
   this.db.prepare('INSERT INTO playback_history_checkpoint VALUES(?,?,?,?)').run(c.sessionId,c.entryId,c.checkpoint,fingerprint);
   return {sessionId:c.sessionId,entryId:c.entryId,checkpoint:c.checkpoint,statistics:{counts:newPlay>0,recency:!stats||observed>stats.last_played_at||observed===stats.last_played_at&&basis==='observation'&&stats.last_played_basis!=='observation'}};
  });
 }
 list(value:unknown):PlaybackHistoryPage {
  const {request,params,scope}=historyQueryPlan(value);
  const ceiling=request.cursor?.ceiling??Number((this.db.prepare('SELECT COALESCE(MAX(id),0) n FROM playback_history').get() as {n:number}).n);
  const totals=this.db.prepare(`SELECT COUNT(*) sessions,COALESCE(SUM(counted),0) plays,COALESCE(SUM(presented_us),0) presentedUs,COALESCE(SUM(estimated_us),0) estimatedUs FROM playback_history WHERE ${scope} AND id<=?`).get(...params,ceiling) as PlaybackHistoryPage['totals'];
  const rows=this.db.prepare(`SELECT * FROM playback_history WHERE ${scope} AND id<=? ${request.cursor?'AND id<?':''} ORDER BY id DESC LIMIT 51`).all(...params,ceiling,...(request.cursor?[request.cursor.before]:[])) as Stored[];
  const items=rows.slice(0,50).map(row=>{
   const metadata=JSON.parse(row.identity_json) as Omit<PlaybackHistoryCheckpoint,'checkpoint'|'presentedUs'|'estimatedUs'|'furthestUs'>,item=this.item(metadata.itemId);
   return {...metadata,id:row.id,checkpoint:row.last_checkpoint,presentedUs:row.presented_us,estimatedUs:row.estimated_us,furthestUs:row.furthest_us,counted:row.counted===1,updatedAt:row.updated_at,observedAt:row.last_observed_at,timeBasis:row.observed_basis,available:Boolean(item?.available&&!item.cue?.hidden&&(item.libraryState===undefined||item.libraryState==='active'))} satisfies PlaybackHistoryRow;
  });
  return {items,totals,nextCursor:rows.length>50?{ceiling,before:items[items.length-1].id,scope:JSON.stringify([request.query??'',request.itemId??null])}:null};
 }
}
