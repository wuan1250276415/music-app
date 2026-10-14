import {createHash} from 'node:crypto';
import {orderedLyricsSources,effectiveLyricsSelection} from '../shared/lyrics-selection.js';
import type {DatabaseSync} from 'node:sqlite';
import type {LibraryItem,LyricsBundle,LyricsDocument,LyricsPreference,LyricsPreferenceRequest} from '../shared/contracts.js';

export const lyricsPreferenceSchema=`
 CREATE TABLE lyrics_preference(scope TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES playable_item(id) ON DELETE CASCADE,revision INTEGER NOT NULL CHECK(revision>=0),preference_json TEXT NOT NULL CHECK(json_valid(preference_json)));
 CREATE INDEX lyrics_preference_item ON lyrics_preference(item_id);
 CREATE TABLE lyrics_preference_receipt(command_id TEXT PRIMARY KEY,request_json TEXT NOT NULL CHECK(json_valid(request_json)),result_revision INTEGER NOT NULL,created_at TEXT NOT NULL);
 CREATE TRIGGER lyrics_preference_receipt_immutable BEFORE UPDATE ON lyrics_preference_receipt BEGIN SELECT RAISE(ABORT,'歌词设置回执不可修改'); END;
 CREATE TRIGGER lyrics_preference_receipt_no_delete BEFORE DELETE ON lyrics_preference_receipt BEGIN SELECT RAISE(ABORT,'歌词设置回执不可删除'); END;
`;
const hash=/^[0-9a-f]{64}$/;
export function lyricsSourcesFingerprint(sources:LyricsDocument[]):string{return createHash('sha256').update(JSON.stringify(sources)).digest('hex');}
export function lyricsScope(item:LibraryItem):string {
 return createHash('sha256').update(JSON.stringify([item.id,item.fileId,item.path,item.kind,item.sourceStartCueFrame,item.sourceEndCueFrame,item.sourceStartSeconds,item.sourceEndSeconds])).digest('hex');
}
export function defaultLyricsPreference():LyricsPreference{return {primaryId:null,secondaryId:null,offsetSourceId:null,offsetMs:0,secondaryOffsetMs:0,showSecondary:true,fontSize:20};}
export function readLyricsPreference(value:unknown):LyricsPreference {
 const p=value as LyricsPreference;
 if(!p||[p.primaryId,p.secondaryId,p.offsetSourceId].some(id=>id!==null&&(typeof id!=='string'||!hash.test(id)))||
  !Number.isSafeInteger(p.offsetMs)||Math.abs(p.offsetMs)>300000||!Number.isSafeInteger(p.secondaryOffsetMs)||Math.abs(p.secondaryOffsetMs)>300000||
  typeof p.showSecondary!=='boolean'||!Number.isInteger(p.fontSize)||p.fontSize<14||p.fontSize>32||p.primaryId!==null&&p.primaryId===p.secondaryId||
  p.offsetMs!==0&&p.offsetSourceId===null||p.secondaryId===null&&p.secondaryOffsetMs!==0||p.sourceOrder!==undefined&&(!Array.isArray(p.sourceOrder)||p.sourceOrder.length>64||p.sourceOrder.some(id=>typeof id!=='string'||!hash.test(id))||new Set(p.sourceOrder).size!==p.sourceOrder.length))throw new Error('无效歌词设置');
 return {primaryId:p.primaryId,secondaryId:p.secondaryId,offsetSourceId:p.offsetSourceId,offsetMs:p.offsetMs,secondaryOffsetMs:p.secondaryOffsetMs,showSecondary:p.showSecondary,fontSize:p.fontSize,...(p.sourceOrder!==undefined?{sourceOrder:[...p.sourceOrder]}:{})};
}
export function validateLyricsRequest(value:unknown):LyricsPreferenceRequest {
 const r=value as LyricsPreferenceRequest;
 if(!r||typeof r.commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.commandId)||typeof r.itemId!=='string'||!r.itemId||r.itemId.length>128||typeof r.scope!=='string'||!hash.test(r.scope)||!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0||r.sourceSetFingerprint!==undefined&&(typeof r.sourceSetFingerprint!=='string'||!hash.test(r.sourceSetFingerprint))||r.preference?.sourceOrder!==undefined&&r.sourceSetFingerprint===undefined)throw new Error('无效歌词设置请求');
 return {commandId:r.commandId,itemId:r.itemId,scope:r.scope,baseRevision:r.baseRevision,preference:readLyricsPreference(r.preference),...(r.sourceSetFingerprint!==undefined?{sourceSetFingerprint:r.sourceSetFingerprint}:{})};
}
export class LyricsPreferenceRepository {
 constructor(private readonly db:DatabaseSync){}
 read(item:LibraryItem):{scope:string;revision:number;preference:LyricsPreference}{
  const scope=lyricsScope(item),row=this.db.prepare('SELECT item_id,revision,preference_json FROM lyrics_preference WHERE scope=?').get(scope) as {item_id:string;revision:number;preference_json:string}|undefined;
  if(!row)return {scope,revision:0,preference:defaultLyricsPreference()};
  if(row.item_id!==item.id||!Number.isSafeInteger(row.revision)||row.revision<0)throw new Error('歌词设置身份无效');
  return {scope,revision:row.revision,preference:readLyricsPreference(JSON.parse(row.preference_json))};
 }
 receipt(request:LyricsPreferenceRequest):boolean {
  const r=validateLyricsRequest(request),row=this.db.prepare('SELECT request_json FROM lyrics_preference_receipt WHERE command_id=?').get(r.commandId) as {request_json:string}|undefined;
  if(!row)return false;
  if(row.request_json!==JSON.stringify(r))throw new Error('同一歌词设置操作不可更改内容');return true;
 }
 save(item:LibraryItem,sources:LyricsDocument[],request:LyricsPreferenceRequest):void {
  const r=validateLyricsRequest(request);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   if(this.receipt(r)){this.db.exec('COMMIT');return;}
   const state=this.read(item);
   if(r.itemId!==item.id||r.scope!==state.scope)throw new Error('曲目或 CUE 范围已变化，请重新读取歌词');
   if(r.baseRevision!==state.revision)throw new Error('歌词设置已变化，请重新读取后再修改');
   if(state.revision>=Number.MAX_SAFE_INTEGER)throw new Error('歌词设置修订已达上限');
   if(r.sourceSetFingerprint!==undefined&&r.sourceSetFingerprint!==lyricsSourcesFingerprint(sources))throw new Error('歌词来源列表或内容已变化，请重新读取后再排序或保存');
   const ids=new Set(sources.map(source=>source.id)),p=r.preference,previous=state.preference;
   for(const field of ['primaryId','secondaryId','offsetSourceId'] as const){const id=p[field];if(id!==null&&!ids.has(id)&&id!==previous[field])throw new Error('所选歌词来源已变化，请重新读取');}
   const knownPriorities=new Set(previous.sourceOrder??[]);
   if(p.sourceOrder?.some(id=>!ids.has(id)&&!knownPriorities.has(id)))throw new Error('优先级包含未观察到的歌词来源');
   const primary=effectiveLyricsSelection(sources,p).primaryId;
   const preservedOffset=previous.offsetSourceId!==null&&previous.offsetSourceId!==primary&&p.primaryId===previous.primaryId&&p.offsetSourceId===previous.offsetSourceId&&p.offsetMs===previous.offsetMs;
   const preservedSecondary=p.secondaryId===previous.secondaryId&&p.secondaryOffsetMs===previous.secondaryOffsetMs&&p.primaryId===previous.primaryId;
   if(p.offsetSourceId!==null&&p.offsetSourceId!==primary&&!preservedOffset||p.secondaryId!==null&&p.secondaryId===primary&&!preservedSecondary)throw new Error('偏移须绑定当前主歌词，辅助歌词须选择另一来源');
   if(p.secondaryId!==null&&!ids.has(p.secondaryId)&&p.secondaryOffsetMs!==previous.secondaryOffsetMs)throw new Error('暂不可用的辅助歌词偏移须保持原值');
   this.db.prepare('INSERT INTO lyrics_preference(scope,item_id,revision,preference_json) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,preference_json=excluded.preference_json').run(state.scope,item.id,state.revision+1,JSON.stringify(p));
   this.db.prepare('INSERT INTO lyrics_preference_receipt VALUES(?,?,?,?)').run(r.commandId,JSON.stringify(r),state.revision+1,new Date().toISOString());
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 bundle(item:LibraryItem,sources:LyricsDocument[]):LyricsBundle {
  const state=this.read(item),p=state.preference,ordered=orderedLyricsSources(sources,p),{primaryId,secondaryId}=effectiveLyricsSelection(sources,p);
  const notices:string[]=[];
  if(p.primaryId&&!sources.some(source=>source.id===p.primaryId))notices.push('原主歌词已变化或缺失，暂用自动来源，原选择与偏移仍保留。');
  if(p.secondaryId&&!sources.some(source=>source.id===p.secondaryId))notices.push('辅助歌词已变化或缺失，暂不显示，原选择与偏移仍保留。');
  if(p.secondaryId!==null&&p.secondaryId===primaryId)notices.push('辅助歌词与临时主歌词相同，暂不重复显示。');
  if(p.offsetMs!==0&&p.offsetSourceId!==primaryId)notices.push('主歌词来源已变化，暂不应用原时间偏移。');
  const missing=(p.sourceOrder??[]).filter(id=>!sources.some(source=>source.id===id)).length;
  if(missing)notices.push(`${missing} 个优先来源暂不可用，排序记录继续保留。`);
  return {itemId:item.id,...state,sources:ordered,defaultSourceIds:sources.flatMap(source=>source.id?[source.id]:[]),sourceSetFingerprint:lyricsSourcesFingerprint(sources),primaryId,secondaryId,offsetMs:p.offsetSourceId===primaryId?p.offsetMs:0,secondaryOffsetMs:secondaryId?p.secondaryOffsetMs:0,notice:notices.join(' ')};
 }
}
