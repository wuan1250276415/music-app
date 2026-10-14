import {createHash} from 'node:crypto';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {LibraryItem,LocalLyricsVersionPage,LocalLyricsVersion,LocalLyricsVersionSummary,LyricsDocument,SavedLocalLyricsQuery,SavedLocalLyricsSummary,SavedLocalLyricsPage,SavedLocalLyricsVersion} from '../shared/contracts.js';
import type {LocalLyricsObservation,MediaRequest} from './media-worker-protocol.js';
import {validateLyricsObservations,validateLyricsDocuments,lyricsDocumentId} from './media-worker-protocol.js';
import {parseLrc,localLyricsContext,localSidecarTimeBasis,normalizeSidecarLyrics} from './lyrics.js';
import {lyricsScope} from './lyrics-preferences.js';
import {lyricsScopeSnapshot,validateLyricsScopeSnapshot} from './lyrics-documents.js';
const hash=/^[0-9a-f]{64}$/,digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const parser='local-sidecar-lrc-v2';
export const lyricsLocalBrowserSchema='CREATE INDEX lyrics_local_version_global_page ON lyrics_local_version(created_at DESC,id DESC);';
export function validateSavedLocalLyricsQuery(value:unknown):SavedLocalLyricsQuery{
 const r=value as SavedLocalLyricsQuery;
 if(!r||typeof r.query!=='string'||r.query.length>256||r.query.includes('\0')||!['all','removed','same-item'].includes(r.association)||!['all','timed','plain'].includes(r.kind)||typeof r.lastKnownOnly!=='boolean'||r.itemId!==undefined&&(typeof r.itemId!=='string'||!r.itemId||r.itemId.length>128)||r.association==='same-item'&&!r.itemId||r.cursor!==undefined&&(typeof r.cursor!=='string'||r.cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(r.cursor)))throw new Error('无效本地歌词原文目录查询');
 return {query:r.query.trim(),association:r.association,kind:r.kind,lastKnownOnly:r.lastKnownOnly,...(r.association==='same-item'?{itemId:r.itemId}:{}),...(r.cursor!==undefined?{cursor:r.cursor}:{})};
}
export const lyricsLocalHistorySchema=`
 CREATE TABLE lyrics_local_version(id TEXT PRIMARY KEY CHECK(length(id)=64),scope TEXT NOT NULL,item_id TEXT NOT NULL,file_id TEXT NOT NULL,source_id TEXT NOT NULL,source_path TEXT NOT NULL,label TEXT NOT NULL,encoding TEXT NOT NULL CHECK(encoding IN('utf-8','utf-16le','utf-16be','gb18030')),raw_bytes BLOB NOT NULL CHECK(typeof(raw_bytes)='blob' AND length(raw_bytes) BETWEEN 1 AND 1048576),raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64),parsed_json TEXT NOT NULL CHECK(json_valid(parsed_json) AND length(CAST(parsed_json AS BLOB))<=1572864),snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB))<=65536),snapshot_sha256 TEXT NOT NULL,observation_json TEXT NOT NULL CHECK(json_valid(observation_json)),parser_version TEXT NOT NULL,rights_id TEXT NOT NULL REFERENCES provider_rights(id),created_at TEXT NOT NULL);
 CREATE INDEX lyrics_local_version_page ON lyrics_local_version(item_id,created_at DESC,id DESC);
 CREATE TABLE lyrics_local_latest(scope TEXT NOT NULL,source_path TEXT NOT NULL,version_id TEXT NOT NULL REFERENCES lyrics_local_version(id),PRIMARY KEY(scope,source_path));
 CREATE TABLE lyrics_document_local_origin(document_id TEXT PRIMARY KEY REFERENCES lyrics_document(id),version_id TEXT NOT NULL REFERENCES lyrics_local_version(id));
 CREATE TRIGGER lyrics_local_version_immutable BEFORE UPDATE ON lyrics_local_version BEGIN SELECT RAISE(ABORT,'歌词来源原文版本不可修改'); END;
 CREATE TRIGGER lyrics_local_version_no_delete BEFORE DELETE ON lyrics_local_version BEGIN SELECT RAISE(ABORT,'歌词来源原文不能作为图片缓存清理'); END;
 CREATE TRIGGER lyrics_document_local_origin_immutable BEFORE UPDATE ON lyrics_document_local_origin BEGIN SELECT RAISE(ABORT,'歌词复制来源不可修改'); END;
 CREATE TRIGGER lyrics_document_local_origin_no_delete BEFORE DELETE ON lyrics_document_local_origin BEGIN SELECT RAISE(ABORT,'歌词复制来源不可删除'); END;
`;
type Row={id:string;scope:string;item_id:string;source_id:string;source_path:string;label:string;encoding:LocalLyricsVersionSummary['encoding'];raw_size:number;raw_sha256:string;kind:'timed'|'plain';line_count:number;created_at:string;last_known:number};
type SavedRow=Row&{original_title:string;original_artist:string;original_album:string;language:string};
const select="SELECT v.id,v.scope,v.item_id,v.source_id,v.source_path,v.label,v.encoding,length(v.raw_bytes) raw_size,v.raw_sha256,json_extract(v.parsed_json,'$.kind') kind,json_array_length(v.parsed_json,'$.lines') line_count,v.created_at,EXISTS(SELECT 1 FROM lyrics_local_latest l WHERE l.scope=v.scope AND l.source_path=v.source_path AND l.version_id=v.id) last_known FROM lyrics_local_version v";
const savedSelect=select.replace('SELECT v.id,',"SELECT json_extract(v.snapshot_json,'$.item.title') original_title,json_extract(v.snapshot_json,'$.item.artist') original_artist,json_extract(v.snapshot_json,'$.item.album') original_album,COALESCE(json_extract(v.parsed_json,'$.language'),'') language,v.id,");
function summary(r:Row):LocalLyricsVersionSummary{
 if(!hash.test(r.id)||!hash.test(r.scope)||!hash.test(r.source_id)||!hash.test(r.raw_sha256)||!['timed','plain'].includes(r.kind)||!['utf-8','utf-16le','utf-16be','gb18030'].includes(r.encoding)||typeof r.label!=='string'||!r.label||r.label.length>512||r.label.includes('\0')||typeof r.item_id!=='string'||!r.item_id||r.item_id.length>128||typeof r.created_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.created_at)||![0,1].includes(r.last_known)||!Number.isSafeInteger(r.raw_size)||r.raw_size<1||r.raw_size>1048576||!Number.isSafeInteger(r.line_count)||r.line_count<1||r.line_count>5000)throw new Error('歌词原文历史摘要无效');
 return {id:r.id,scope:r.scope,sourceId:r.source_id,label:r.label,encoding:r.encoding,rawBytes:r.raw_size,rawSha256:r.raw_sha256,kind:r.kind,lineCount:r.line_count,createdAt:r.created_at,lastKnown:!!r.last_known};
}
export class LocalLyricsHistory{
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T){}
 observe(item:LibraryItem,documents:LyricsDocument[],observations:LocalLyricsObservation[]):boolean{
  validateLyricsObservations(observations,documents);if(!observations.length)return false;
  const scope=lyricsScope(item),scopeSnapshot=lyricsScopeSnapshot(item),context=localLyricsContext(item),now=new Date().toISOString();let changed=false;
  this.transaction(()=>{
   let usage=this.db.prepare('SELECT COUNT(*) n,COALESCE(SUM(length(raw_bytes)),0) bytes FROM lyrics_local_version WHERE scope=?').get(scope) as {n:number;bytes:number};
   const global=this.db.prepare('SELECT COUNT(*) n,COALESCE(SUM(length(raw_bytes)),0) bytes FROM lyrics_local_version').get() as {n:number;bytes:number};let total=Number(global.bytes),count=Number(global.n);
   for(const o of observations){
    const doc=documents.find(d=>d.id===o.documentId)!;
    const timeBasis=localSidecarTimeBasis(o.source,item);if(!timeBasis)throw new Error('本地歌词来源名称不属于当前曲目');
    const snapshot=JSON.stringify({...scopeSnapshot,localSidecar:{version:2,timeBasis,cueIndex01Seconds:context.cueIndex01Seconds??null}});if(Buffer.byteLength(snapshot,'utf8')>65536)throw new Error('歌词原文历史范围快照超限');validateLyricsScopeSnapshot(JSON.parse(snapshot));
    const id=digest(JSON.stringify([scope,o.source,o.rawSha256,o.encoding,o.documentId,parser]));
    if(!this.db.prepare('SELECT 1 FROM lyrics_local_version WHERE id=?').get(id)){
     const raw=Buffer.from(o.rawBase64,'base64');if(usage.n>=64||usage.bytes+raw.length>32*1024*1024||total+raw.length>512*1024*1024||count>=32768)throw new Error('本地歌词原文历史已达到容量上限，已有版本继续保留');
     this.db.prepare('INSERT INTO lyrics_local_version VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,scope,item.id,item.fileId,o.documentId,o.source,doc.label!,o.encoding,raw,o.rawSha256,JSON.stringify(doc),snapshot,digest(snapshot),JSON.stringify(o.before),parser,'local-private-v1',now);usage={n:usage.n+1,bytes:usage.bytes+raw.length};total+=raw.length;count++;changed=true;
    }
    const latest=this.db.prepare('SELECT version_id FROM lyrics_local_latest WHERE scope=? AND source_path=?').get(scope,o.source) as {version_id:string}|undefined;
    if(latest?.version_id!==id){this.db.prepare('INSERT INTO lyrics_local_latest VALUES(?,?,?) ON CONFLICT(scope,source_path) DO UPDATE SET version_id=excluded.version_id').run(scope,o.source,id);changed=true;}
   }
  });return changed;
 }
 page(item:LibraryItem,cursor?:string):LocalLyricsVersionPage{
  let end:{at:string;id:string}|null=null;
  if(cursor!==undefined){try{if(typeof cursor!=='string'||cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error();const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(c.itemId!==item.id||typeof c.at!=='string'||c.at.length>32||!hash.test(c.id))throw new Error();end=c;}catch{throw new Error('无效歌词原文历史分页');}}
  const rows=this.db.prepare(`${select} WHERE v.item_id=? ${end?'AND (v.created_at<? OR (v.created_at=? AND v.id<?))':''} ORDER BY v.created_at DESC,v.id DESC LIMIT 21`).all(...(end?[item.id,end.at,end.at,end.id]:[item.id])) as Row[];
  const last=rows[19];return {itemId:item.id,scope:lyricsScope(item),items:rows.slice(0,20).map(summary),nextCursor:rows.length>20?Buffer.from(JSON.stringify({itemId:item.id,at:last.created_at,id:last.id})).toString('base64url'):null};
 }
 version(item:LibraryItem,id:string):LocalLyricsVersion{
  if(!hash.test(id))throw new Error('无效歌词原文版本');
  const row=this.db.prepare(`${select} WHERE v.item_id=? AND v.id=?`).get(item.id,id) as Row|undefined;if(!row)throw new Error('歌词原文版本不属于当前曲目');
  return this.read(row);
 }
 storedVersion(id:string):LocalLyricsVersion{
  if(typeof id!=='string'||!hash.test(id))throw new Error('无效保存的本地原文版本');
  const row=this.db.prepare(`${select} WHERE v.id=? AND v.rights_id='local-private-v1'`).get(id) as Row|undefined;if(!row)throw new Error('保存的本地歌词原文不存在或不可复用');return this.read(row);
 }
 private savedSummary(row:SavedRow,lookup:(id:string)=>LibraryItem|null):SavedLocalLyricsSummary{
  if([row.original_title,row.original_artist,row.original_album].some(v=>typeof v!=='string'||v.length>16384||v.includes('\0'))||typeof row.language!=='string'||row.language.length>32||row.language.includes('\0'))throw new Error('本地原文历史范围摘要无效');
  const item=lookup(row.item_id);return {...summary(row),itemId:row.item_id,association:!item?'removed':lyricsScope(item)===row.scope?'current':'previous-scope',itemTitle:item?.title??null,fileAvailable:item?.available??null,originalTitle:row.original_title,originalArtist:row.original_artist,originalAlbum:row.original_album,language:row.language};
 }
 savedPage(value:unknown,lookup:(id:string)=>LibraryItem|null):SavedLocalLyricsPage{
  const r=validateSavedLocalLyricsQuery(value),{cursor,...filter}=r,key=digest(JSON.stringify(filter));let end:{at:string;id:string}|null=null;
  if(cursor!==undefined){try{const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(!c||Object.keys(c).length!==3||c.key!==key||typeof c.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(c.at)||typeof c.id!=='string'||!hash.test(c.id))throw new Error();end={at:c.at,id:c.id};}catch{throw new Error('本地原文分页与筛选不匹配');}}
  const conditions=["v.rights_id='local-private-v1'"],bindings:string[]=[];
  if(r.query){const pattern=`%${r.query.replace(/[\\%_]/g,'\\$&')}%`,fields=['v.label',"COALESCE(json_extract(v.parsed_json,'$.language'),'')",...['title','artist','album'].map(field=>`json_extract(v.snapshot_json,'$.item.${field}')`)];conditions.push(`(${fields.map(field=>`${field} LIKE ? ESCAPE '\\'`).join(' OR ')})`);bindings.push(...fields.map(()=>pattern));}
  if(r.association==='removed')conditions.push('p.id IS NULL');
  if(r.association==='same-item'){conditions.push('v.item_id=?');bindings.push(r.itemId!);}
  if(r.kind!=='all'){conditions.push("json_extract(v.parsed_json,'$.kind')=?");bindings.push(r.kind);}
  if(r.lastKnownOnly)conditions.push('EXISTS(SELECT 1 FROM lyrics_local_latest l WHERE l.scope=v.scope AND l.source_path=v.source_path AND l.version_id=v.id)');
  if(end){conditions.push('(v.created_at<? OR (v.created_at=? AND v.id<?))');bindings.push(end.at,end.at,end.id);}
  const rows=this.db.prepare(`${savedSelect} LEFT JOIN playable_item p ON p.id=v.item_id WHERE ${conditions.join(' AND ')} ORDER BY v.created_at DESC,v.id DESC LIMIT 21`).all(...bindings) as SavedRow[];
  const items=new Map<string,LibraryItem|null>(),resolve=(id:string)=>{if(!items.has(id))items.set(id,lookup(id));return items.get(id)!;},last=rows[19];
  return {items:rows.slice(0,20).map(row=>this.savedSummary(row,resolve)),nextCursor:rows.length>20?Buffer.from(JSON.stringify({key,at:last.created_at,id:last.id})).toString('base64url'):null};
 }
 savedVersion(id:string,lookup:(id:string)=>LibraryItem|null):SavedLocalLyricsVersion{
  const source=this.storedVersion(id),row=this.db.prepare(`${savedSelect} WHERE v.id=?`).get(id) as SavedRow;return {...source,summary:this.savedSummary(row,lookup)};
 }
 private read(row:Row):LocalLyricsVersion{
  const version=summary(row),id=row.id;
  const data=this.db.prepare('SELECT file_id,raw_bytes,parsed_json,snapshot_json,snapshot_sha256,parser_version,rights_id FROM lyrics_local_version WHERE id=?').get(id) as {file_id:string;raw_bytes:Uint8Array;parsed_json:string;snapshot_json:string;snapshot_sha256:string;parser_version:string;rights_id:string};
  const raw=Buffer.from(data.raw_bytes);if(raw.length!==row.raw_size||digest(raw)!==row.raw_sha256||digest(data.snapshot_json)!==data.snapshot_sha256||data.rights_id!=='local-private-v1'||!['local-sidecar-lrc-v1',parser].includes(data.parser_version)||digest(JSON.stringify([row.scope,row.source_path,row.raw_sha256,row.encoding,row.source_id,data.parser_version]))!==row.id)throw new Error('歌词原文历史完整性校验失败');
  if(Buffer.byteLength(data.snapshot_json,'utf8')>65536)throw new Error('歌词原文历史范围快照超限');
  const snapshot=validateLyricsScopeSnapshot(JSON.parse(data.snapshot_json));if(snapshot.scope!==row.scope||snapshot.item.id!==row.item_id||snapshot.item.fileId!==data.file_id)throw new Error('歌词原文历史范围关联无效');
  const doc=JSON.parse(data.parsed_json) as LyricsDocument;if(lyricsDocumentId(doc)!==row.source_id||doc.id!==row.source_id||doc.source!==row.source_path||doc.sourceKind!=='sidecar'||Buffer.byteLength(data.parsed_json,'utf8')>1536*1024)throw new Error('歌词历史解析文档无效');
  validateLyricsDocuments([doc],{rootPath:path.dirname(snapshot.item.path),fullPath:snapshot.item.path} as MediaRequest);
  const bom=(row.encoding==='utf-16le'&&raw[0]===255&&raw[1]===254)||(row.encoding==='utf-16be'&&raw[0]===254&&raw[1]===255);
  const text=new TextDecoder(row.encoding,{fatal:true}).decode(bom?raw.subarray(2):raw);
  let replay:LyricsDocument|null=parseLrc(text,row.source_path);
  if(data.parser_version===parser){
   const recipe=snapshot.localSidecar;if(!recipe||localSidecarTimeBasis(row.source_path,snapshot.item)!==recipe.timeBasis)throw new Error('歌词历史时间基无效');
   replay=normalizeSidecarLyrics(replay,{...snapshot.item,cueIndex01Frame:null,cueIndex01Seconds:recipe.cueIndex01Seconds},recipe.timeBasis);
  }else if(snapshot.localSidecar)throw new Error('旧歌词历史包含不兼容时间基');
  if(!replay||lyricsDocumentId({...replay,sourceKind:'sidecar',language:doc.language})!==row.source_id)throw new Error('歌词历史原文与解析结果不一致');
  return {summary:version,rawBase64:raw.toString('base64'),preview:{scopeSnapshot:snapshot,text,encoding:row.encoding,rawSha256:row.raw_sha256,rawBytes:raw.length,document:doc}};
 }
}
