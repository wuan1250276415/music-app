import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {LibraryItem,LyricsDocument,LyricsImportInput,LyricsImportPreview,LyricsDocumentRequest,LyricsDocumentResult,LyricsDocumentPage,LyricsDocumentSummary,LyricsScopeSnapshot,SavedLyricsStateRequest,SavedLyricsChangePage} from '../shared/contracts.js';
import {parseLrc,cueLyrics} from './lyrics.js';
import {lyricsScope} from './lyrics-preferences.js';

export const lyricsDocumentSchema=`
 CREATE TABLE lyrics_document_scope(scope TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0));
 CREATE INDEX lyrics_document_scope_item ON lyrics_document_scope(item_id);
 CREATE TABLE lyrics_document(id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES lyrics_document_scope(scope),item_id TEXT NOT NULL,
  label TEXT NOT NULL,language TEXT NOT NULL,time_basis TEXT NOT NULL CHECK(time_basis IN ('track-relative','audio-absolute')),
  encoding TEXT NOT NULL,raw_bytes BLOB NOT NULL CHECK(length(raw_bytes)>0 AND length(raw_bytes)<=1048576),raw_sha256 TEXT NOT NULL,
  decoded_text TEXT NOT NULL,parsed_json TEXT NOT NULL CHECK(json_valid(parsed_json)),parser_version TEXT NOT NULL,
  rights_id TEXT NOT NULL REFERENCES provider_rights(id),created_at TEXT NOT NULL,import_revision INTEGER NOT NULL CHECK(import_revision>0));
 CREATE UNIQUE INDEX lyrics_document_scope_page ON lyrics_document(scope,import_revision DESC);
 CREATE INDEX lyrics_document_item_scope ON lyrics_document(item_id,scope);
 CREATE TABLE lyrics_document_state(document_id TEXT PRIMARY KEY REFERENCES lyrics_document(id),archived INTEGER NOT NULL CHECK(archived IN (0,1)),changed_at TEXT NOT NULL);
 CREATE TABLE lyrics_document_change(command_id TEXT PRIMARY KEY,scope TEXT NOT NULL,document_id TEXT NOT NULL REFERENCES lyrics_document(id),
  action TEXT NOT NULL CHECK(action IN ('import','archive','restore')),request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0));
 CREATE UNIQUE INDEX lyrics_document_change_scope ON lyrics_document_change(scope,revision DESC);
 CREATE TRIGGER lyrics_document_immutable BEFORE UPDATE ON lyrics_document BEGIN SELECT RAISE(ABORT,'歌词原文版本不可修改'); END;
 CREATE TRIGGER lyrics_document_no_delete BEFORE DELETE ON lyrics_document BEGIN SELECT RAISE(ABORT,'用户歌词原文不可作为缓存清理'); END;
 CREATE TRIGGER lyrics_document_change_immutable BEFORE UPDATE ON lyrics_document_change BEGIN SELECT RAISE(ABORT,'歌词修订回执不可修改'); END;
 CREATE TRIGGER lyrics_document_change_no_delete BEFORE DELETE ON lyrics_document_change BEGIN SELECT RAISE(ABORT,'歌词修订回执不可删除'); END;
`;
const parserVersion='lrc-lines-v1-user-import';
export const lyricsSavedSchema=`
 CREATE INDEX lyrics_document_saved_page ON lyrics_document(created_at DESC,id DESC);
 CREATE INDEX lyrics_document_state_filter ON lyrics_document_state(archived,document_id);
 CREATE UNIQUE INDEX lyrics_document_import_origin ON lyrics_document_change(document_id) WHERE action='import';
`;
export const lyricsContextSchema=`
 CREATE TABLE lyrics_document_context(document_id TEXT PRIMARY KEY REFERENCES lyrics_document(id),snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB))<=65536),snapshot_sha256 TEXT NOT NULL);
 CREATE TRIGGER lyrics_document_context_immutable BEFORE UPDATE ON lyrics_document_context BEGIN SELECT RAISE(ABORT,'歌词历史范围不可修改'); END;
 CREATE TRIGGER lyrics_document_context_no_delete BEFORE DELETE ON lyrics_document_context BEGIN SELECT RAISE(ABORT,'歌词历史范围不可删除'); END;
 CREATE INDEX lyrics_document_change_document ON lyrics_document_change(document_id,revision DESC);
`;
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const hash=/^[0-9a-f]{64}$/;
function identity(itemId:unknown,scope:unknown):void{
 if(typeof itemId!=='string'||!itemId||itemId.length>128||typeof scope!=='string'||!hash.test(scope))throw new Error('无效歌词曲目或范围');
}
export function validateLyricsScopeSnapshot(value:unknown):LyricsScopeSnapshot{
 const s=value as LyricsScopeSnapshot,i=s?.item,c=s?.catalog;
 const text=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max&&!v.includes('\u0000');
 const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
 const nonnegativeOrNull=(v:unknown)=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>=0;
 const local=s?.localSidecar;
 if(!s||s.version!==1||typeof s.scope!=='string'||!hash.test(s.scope)||!i||!text(i.id,128)||!i.id||!text(i.fileId,128)||!i.fileId||!text(i.path,32768)||!i.path||!['file','cue'].includes(i.kind)||
  ![i.title,i.artist,i.album,i.codec].every(v=>text(v,16384))||!Number.isFinite(i.sourceStartSeconds)||i.sourceStartSeconds<0||i.sourceEndSeconds!==null&&(!Number.isFinite(i.sourceEndSeconds)||i.sourceEndSeconds<=i.sourceStartSeconds)||
  ![i.sourceStartCueFrame,i.sourceEndCueFrame].every(v=>v===null||integer(v))||i.sourceEndCueFrame!==null&&(i.sourceStartCueFrame===null||i.sourceEndCueFrame<=i.sourceStartCueFrame)||
  ![i.durationSeconds,i.sampleRate,i.bitsPerSample].every(nonnegativeOrNull)||![i.trackNumber,i.discNumber].every(v=>v===null||integer(v))||
  i.sourceStartCueFrame!==null&&Math.abs(i.sourceStartSeconds-i.sourceStartCueFrame/75)>1e-9||i.sourceEndCueFrame!==null&&(i.sourceEndSeconds===null||Math.abs(i.sourceEndSeconds-i.sourceEndCueFrame/75)>1e-9)||
  c!==null&&(!c||![c.recordingId,c.releaseId,c.releaseTrackId].every(v=>text(v,128)&&v.length>0)||!integer(c.revision)||!integer(c.releaseRevision))||
  local!==undefined&&(!local||Object.keys(local).length!==3||local.version!==2||!['track-relative','audio-absolute'].includes(local.timeBasis)||!nonnegativeOrNull(local.cueIndex01Seconds)||i.kind==='file'&&(local.timeBasis!=='track-relative'||local.cueIndex01Seconds!==null)||local.cueIndex01Seconds!==null&&(local.cueIndex01Seconds<i.sourceStartSeconds||i.sourceEndSeconds!==null&&local.cueIndex01Seconds>=i.sourceEndSeconds))||lyricsScope(i as LibraryItem)!==s.scope)throw new Error('歌词历史范围快照无效');
 return s;
}
export function lyricsScopeSnapshot(item:LibraryItem):LyricsScopeSnapshot{
 const {id,fileId,path,kind,title,artist,album,durationSeconds,codec,sampleRate,bitsPerSample,trackNumber,discNumber,sourceStartSeconds,sourceEndSeconds,sourceStartCueFrame,sourceEndCueFrame}=item;
 const c=item.catalog,value:LyricsScopeSnapshot={version:1,scope:lyricsScope(item),item:{id,fileId,path,kind,title,artist,album,durationSeconds,codec,sampleRate,bitsPerSample,trackNumber,discNumber,sourceStartSeconds,sourceEndSeconds,sourceStartCueFrame,sourceEndCueFrame},catalog:c?{recordingId:c.recordingId,releaseId:c.releaseId,releaseTrackId:c.releaseTrackId,revision:c.revision,releaseRevision:c.releaseRevision}:null};
 validateLyricsScopeSnapshot(value);if(Buffer.byteLength(JSON.stringify(value),'utf8')>65536)throw new Error('歌词历史范围快照超过 64 KiB');return value;
}
export function validateSavedLyricsStateRequest(value:unknown):SavedLyricsStateRequest{
 const r=validateLyricsDocumentRequest(value);if(r.action==='import')throw new Error('原文目录仅允许归档或恢复');return r;
}
export function validateLyricsImport(value:unknown):LyricsImportInput{
 const r=value as LyricsImportInput;if(!r)throw new Error('无效歌词导入');identity(r.itemId,r.scope);
 if(typeof r.label!=='string'||!r.label.trim()||r.label.length>128||/[\u0000-\u001f]/.test(r.label)||typeof r.language!=='string'||r.language.length>32||r.language!==''&&!/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i.test(r.language)||
  !['auto','utf-8','utf-16le','utf-16be','gb18030'].includes(r.encoding)||!['track-relative','audio-absolute'].includes(r.timeBasis)||
  typeof r.rawBase64!=='string'||!r.rawBase64||r.rawBase64.length>1398104||r.rawBase64.length%4!==0||/[^A-Za-z0-9+/=]/.test(r.rawBase64)||r.sourceDocumentId!==undefined&&(typeof r.sourceDocumentId!=='string'||!hash.test(r.sourceDocumentId))||r.sourceLocalVersionId!==undefined&&(typeof r.sourceLocalVersionId!=='string'||!hash.test(r.sourceLocalVersionId))||r.sourceDocumentId!==undefined&&r.sourceLocalVersionId!==undefined)throw new Error('无效歌词内容、编码或时间基');
 const raw=Buffer.from(r.rawBase64,'base64');if(raw.length<1||raw.length>1024*1024||raw.toString('base64')!==r.rawBase64)throw new Error('歌词原始内容须在 1 MiB 以内');
 return {itemId:r.itemId,scope:r.scope,label:r.label.trim(),language:r.language,encoding:r.encoding,timeBasis:r.timeBasis,rawBase64:r.rawBase64,...(r.sourceDocumentId!==undefined?{sourceDocumentId:r.sourceDocumentId}:{}),...(r.sourceLocalVersionId!==undefined?{sourceLocalVersionId:r.sourceLocalVersionId}:{})};
}
export function validateLyricsDocumentRequest(value:unknown):LyricsDocumentRequest{
 const r=value as LyricsDocumentRequest;if(!r)throw new Error('无效歌词文档操作');identity(r.itemId,r.scope);
 if(typeof r.commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.commandId)||!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0)throw new Error('无效歌词文档操作');
 const base={commandId:r.commandId,itemId:r.itemId,scope:r.scope,baseRevision:r.baseRevision};
 if(r.action==='import'){
  const input=validateLyricsImport(r.input);if(input.itemId!==r.itemId||input.scope!==r.scope)throw new Error('歌词导入目标不一致');
  return {...base,action:r.action,input};
 }
 if(!['archive','restore'].includes(r.action)||!hash.test(r.documentId??''))throw new Error('无效歌词文档操作');
 return {...base,action:r.action,documentId:r.documentId};
}
export function previewLyricsImport(item:LibraryItem,value:unknown):LyricsImportPreview{
 const input=validateLyricsImport(value);if(input.itemId!==item.id||input.scope!==lyricsScope(item))throw new Error('曲目或 CUE 范围已变化，请重新导入');
 const raw=Buffer.from(input.rawBase64,'base64');let encoding:string=input.encoding,text:string;
 if(input.encoding==='auto'){
  if(raw[0]===0xff&&raw[1]===0xfe){encoding='utf-16le';text=new TextDecoder(encoding,{fatal:true}).decode(raw.subarray(2));}
  else if(raw[0]===0xfe&&raw[1]===0xff){encoding='utf-16be';text=new TextDecoder(encoding,{fatal:true}).decode(raw.subarray(2));}
  else{try{encoding='utf-8';text=new TextDecoder(encoding,{fatal:true}).decode(raw);}catch{encoding='gb18030';text=new TextDecoder(encoding,{fatal:true}).decode(raw);}}
 }else text=new TextDecoder(encoding,{fatal:true}).decode(raw);
 if(Buffer.byteLength(text,'utf8')>1024*1024||text.includes('\u0000'))throw new Error('解码后的歌词过大或包含空字符，请检查编码');
 let document:LyricsDocument|null={...parseLrc(text,input.label),sourceKind:'imported',label:input.label,language:input.language||undefined,encoding,descriptor:input.timeBasis==='audio-absolute'?'源音频时间':'当前曲目时间'};
 if(!document.lines.length)throw new Error('歌词为空、超限或无法解析');
 if(input.timeBasis==='audio-absolute'&&item.kind==='cue')document=cueLyrics(document,item);
 if(!document?.lines.length)throw new Error('源音频歌词在当前 CUE 范围内没有同步行，请选择当前曲目时间或其他文档');
 if(Buffer.byteLength(JSON.stringify(document),'utf8')>2*1024*1024)throw new Error('解析后的歌词文档超过 2 MiB，请拆分为较小版本');
 const start=item.sourceStartCueFrame!==null&&Number.isSafeInteger(item.sourceStartCueFrame)?item.sourceStartCueFrame/75:item.sourceStartSeconds;
 const end=item.sourceEndCueFrame!==null&&Number.isSafeInteger(item.sourceEndCueFrame)?item.sourceEndCueFrame/75:item.sourceEndSeconds;
 return {scopeSnapshot:lyricsScopeSnapshot(item),text,encoding,rawSha256:digest(raw),rawBytes:raw.length,document,target:{title:item.title,artist:item.artist,kind:item.kind,sourceStartSeconds:start,sourceEndSeconds:end}};
}

export function validateSavedLyricsQuery(value:unknown):import('../shared/contracts.js').SavedLyricsQuery{
 const r=value as import('../shared/contracts.js').SavedLyricsQuery;
 if(!r||typeof r.query!=='string'||r.query.length>256||!['all','removed','same-item'].includes(r.association)||!['all','active','archived'].includes(r.state)||r.itemId!==undefined&&(typeof r.itemId!=='string'||!r.itemId||r.itemId.length>128)||r.association==='same-item'&&!r.itemId||r.cursor!==undefined&&(typeof r.cursor!=='string'||r.cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(r.cursor)))throw new Error('无效用户歌词查询');
 return {query:r.query.trim(),association:r.association,state:r.state,...(r.association==='same-item'?{itemId:r.itemId}:{}),...(r.cursor!==undefined?{cursor:r.cursor}:{})};
}

type Row={id:string;label:string;language:string;time_basis:LyricsImportInput['timeBasis'];encoding:string;raw_sha256:string;raw_bytes:Uint8Array;decoded_text:string;parsed_json:string;created_at:string;archived:number;changed_at:string};
function parsed(row:Pick<Row,'id'|'parsed_json'>):LyricsDocument{
 const doc=JSON.parse(row.parsed_json) as LyricsDocument;
 if(!doc||!Array.isArray(doc.lines)||!['plain','timed'].includes(doc.kind)||doc.lines.length<1||doc.lines.length>5000||doc.lines.some(line=>!Number.isFinite(line.atSeconds)||typeof line.text!=='string')||Buffer.byteLength(row.parsed_json,'utf8')>2*1024*1024)throw new Error('保存的歌词文档无效');
 return {...doc,id:row.id,sourceKind:'imported'};
}
type SummaryRow=Omit<Row,'raw_bytes'|'decoded_text'|'parsed_json'>&{raw_size:number;kind:LyricsDocument['kind'];line_count:number;import_revision:number};
const summarySelect="SELECT d.id,d.label,d.language,d.time_basis,d.encoding,length(d.raw_bytes) AS raw_size,d.raw_sha256,d.created_at,d.import_revision,s.archived,s.changed_at,json_extract(d.parsed_json,'$.kind') AS kind,json_array_length(d.parsed_json,'$.lines') AS line_count FROM lyrics_document d JOIN lyrics_document_state s ON s.document_id=d.id";
function summary(row:SummaryRow):LyricsDocumentSummary{
 if(!['plain','timed'].includes(row.kind)||!Number.isSafeInteger(row.line_count)||row.line_count<1||row.line_count>5000||!Number.isSafeInteger(row.raw_size)||row.raw_size<1||row.raw_size>1048576)throw new Error('保存的歌词版本摘要无效');
 return {id:row.id,label:row.label,language:row.language,kind:row.kind,encoding:row.encoding,timeBasis:row.time_basis,rawBytes:row.raw_size,rawSha256:row.raw_sha256,lineCount:row.line_count,archived:!!row.archived,createdAt:row.created_at,changedAt:row.changed_at};
}
export class LyricsDocumentRepository{
 constructor(private readonly db:DatabaseSync,private readonly localSource:(id:string)=>import('../shared/contracts.js').LocalLyricsVersion){}
 private context(documentId:string,scope:string,itemId:string):LyricsScopeSnapshot|null{
  const row=this.db.prepare('SELECT snapshot_json,snapshot_sha256 FROM lyrics_document_context WHERE document_id=?').get(documentId) as {snapshot_json:string;snapshot_sha256:string}|undefined;
  if(!row)return null;
  if(Buffer.byteLength(row.snapshot_json,'utf8')>65536||digest(row.snapshot_json)!==row.snapshot_sha256)throw new Error('歌词历史范围校验失败');
  const value=validateLyricsScopeSnapshot(JSON.parse(row.snapshot_json));if(value.scope!==scope||value.item.id!==itemId)throw new Error('歌词历史范围关联不一致');return value;
 }
 private state(item:LibraryItem):{scope:string;revision:number}{
  const scope=lyricsScope(item),row=this.db.prepare('SELECT item_id,revision FROM lyrics_document_scope WHERE scope=?').get(scope) as {item_id:string;revision:number}|undefined;
  if(row&&(row.item_id!==item.id||!Number.isSafeInteger(row.revision)||row.revision<0))throw new Error('歌词文档范围无效');
  return {scope,revision:row?.revision??0};
 }
 sources(item:LibraryItem):LyricsDocument[]{
  return (this.db.prepare('SELECT d.id,d.parsed_json FROM lyrics_document d JOIN lyrics_document_state s ON s.document_id=d.id WHERE d.scope=? AND s.archived=0 ORDER BY d.import_revision DESC LIMIT 16').all(lyricsScope(item)) as Array<Pick<Row,'id'|'parsed_json'>>).map(parsed);
 }
 page(item:LibraryItem,cursor?:string):LyricsDocumentPage{
  let end:number|null=null;
  if(cursor!==undefined){
   if(typeof cursor!=='string'||cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error('无效歌词文档分页');
   try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(!value||value.scope!==lyricsScope(item)||!Number.isSafeInteger(value.revision)||value.revision<1)throw new Error();end=value.revision;}catch{throw new Error('无效歌词文档分页');}
  }
  const state=this.state(item);
  const rows=(end!==null?this.db.prepare(`${summarySelect} WHERE d.scope=? AND d.import_revision<? ORDER BY d.import_revision DESC LIMIT 21`).all(state.scope,end):this.db.prepare(`${summarySelect} WHERE d.scope=? ORDER BY d.import_revision DESC LIMIT 21`).all(state.scope)) as SummaryRow[];
  const last=rows[19],older=Number((this.db.prepare('SELECT count(*) AS n FROM lyrics_document WHERE item_id=? AND scope<>?').get(item.id,state.scope) as {n:number}).n);
  return {itemId:item.id,...state,items:rows.slice(0,20).map(summary),nextCursor:rows.length>20?Buffer.from(JSON.stringify({scope:state.scope,revision:last.import_revision})).toString('base64url'):null,olderScopeCount:older};
 }
 document(item:LibraryItem,id:unknown):LyricsImportPreview{
  if(typeof id!=='string'||!hash.test(id))throw new Error('无效歌词文档');
  const row=this.db.prepare('SELECT d.*,s.archived,s.changed_at FROM lyrics_document d JOIN lyrics_document_state s ON s.document_id=d.id WHERE d.id=? AND d.scope=?').get(id,lyricsScope(item)) as Row|undefined;
  if(!row)throw new Error('歌词文档不属于当前曲目范围');
  if(digest(row.raw_bytes)!==row.raw_sha256)throw new Error('歌词原始内容校验失败');
  return {scopeSnapshot:this.context(id,lyricsScope(item),item.id),text:row.decoded_text,encoding:row.encoding,rawSha256:row.raw_sha256,rawBytes:row.raw_bytes.length,document:parsed(row)};
 }
 private savedSummary(row:SummaryRow&{item_id:string;scope:string;copied_from_id:string|null;copied_from_local_id:string|null;expected_local_id:string|null;scope_revision:number},lookup:(id:string)=>LibraryItem|null):import('../shared/contracts.js').SavedLyricsSummary{
  const item=lookup(row.item_id);
  if(!Number.isSafeInteger(row.scope_revision)||row.scope_revision<1)throw new Error('歌词文档范围修订无效');
  if(row.copied_from_id!==null&&!hash.test(row.copied_from_id))throw new Error('歌词复制来源记录无效');
  if(row.copied_from_local_id!==row.expected_local_id||row.copied_from_local_id!==null&&!hash.test(row.copied_from_local_id)||row.copied_from_id!==null&&row.copied_from_local_id!==null)throw new Error('本地歌词复制来源记录无效');
  return {...summary(row),itemId:row.item_id,scope:row.scope,association:!item?'removed':lyricsScope(item)===row.scope?'current':'previous-scope',itemTitle:item?.title??null,fileAvailable:item?.available??null,copiedFromId:row.copied_from_id,copiedFromLocalVersionId:row.copied_from_local_id,scopeRevision:row.scope_revision};
 }
 savedPage(value:unknown,lookup:(id:string)=>LibraryItem|null):import('../shared/contracts.js').SavedLyricsPage{
  const request=validateSavedLyricsQuery(value),{cursor,...filter}=request,key=digest(JSON.stringify(filter));let end:{at:string;id:string}|null=null;
  if(cursor!==undefined){try{const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(c.key!==key||typeof c.at!=='string'||c.at.length>40||typeof c.id!=='string'||!hash.test(c.id))throw new Error();end={at:c.at,id:c.id};}catch{throw new Error('用户歌词分页与筛选不匹配');}}
  const conditions:string[]=["d.rights_id='local-private-v1'"],bindings:Array<string|number>=[];
  if(request.query){const pattern=`%${request.query.replace(/[\\%_]/g,'\\$&')}%`;conditions.push("(d.label LIKE ? ESCAPE '\\' OR d.language LIKE ? ESCAPE '\\')");bindings.push(pattern,pattern);}
  if(request.association==='removed')conditions.push('p.id IS NULL');
  if(request.association==='same-item'){conditions.push('d.item_id=?');bindings.push(request.itemId!);}
  if(request.state!=='all'){conditions.push('s.archived=?');bindings.push(request.state==='archived'?1:0);}
  if(end){conditions.push('(d.created_at<? OR (d.created_at=? AND d.id<?))');bindings.push(end.at,end.at,end.id);}
  const select=summarySelect.replace('SELECT d.id,',"SELECT d.id,d.item_id,d.scope,sc.revision AS scope_revision,json_extract(origin.request_json,'$.input.sourceDocumentId') AS copied_from_id,local_origin.version_id AS copied_from_local_id,json_extract(origin.request_json,'$.input.sourceLocalVersionId') AS expected_local_id,");
  const rows=this.db.prepare(`${select} JOIN lyrics_document_scope sc ON sc.scope=d.scope AND sc.item_id=d.item_id LEFT JOIN playable_item p ON p.id=d.item_id LEFT JOIN lyrics_document_change origin ON origin.document_id=d.id AND origin.action='import' LEFT JOIN lyrics_document_local_origin local_origin ON local_origin.document_id=d.id ${conditions.length?`WHERE ${conditions.join(' AND ')}`:''} ORDER BY d.created_at DESC,d.id DESC LIMIT 21`).all(...bindings) as Array<SummaryRow&{item_id:string;scope:string;copied_from_id:string|null;copied_from_local_id:string|null;expected_local_id:string|null;scope_revision:number}>;
  const items=new Map<string,LibraryItem|null>(),resolve=(id:string)=>{if(!items.has(id))items.set(id,lookup(id));return items.get(id)!;},last=rows[19];
  return {items:rows.slice(0,20).map(row=>this.savedSummary(row,resolve)),nextCursor:rows.length>20?Buffer.from(JSON.stringify({key,at:last.created_at,id:last.id})).toString('base64url'):null};
 }
 savedDocument(id:unknown,lookup:(id:string)=>LibraryItem|null):import('../shared/contracts.js').SavedLyricsDocument{
  if(typeof id!=='string'||!hash.test(id))throw new Error('无效保存的歌词');
  const row=this.db.prepare("SELECT d.*,s.archived,s.changed_at,sc.revision AS scope_revision,json_extract(origin.request_json,'$.input.sourceDocumentId') AS copied_from_id,local_origin.version_id AS copied_from_local_id,json_extract(origin.request_json,'$.input.sourceLocalVersionId') AS expected_local_id FROM lyrics_document d JOIN lyrics_document_state s ON s.document_id=d.id JOIN lyrics_document_scope sc ON sc.scope=d.scope AND sc.item_id=d.item_id LEFT JOIN lyrics_document_change origin ON origin.document_id=d.id AND origin.action='import' LEFT JOIN lyrics_document_local_origin local_origin ON local_origin.document_id=d.id WHERE d.id=?").get(id) as Row&{item_id:string;scope:string;copied_from_id:string|null;copied_from_local_id:string|null;expected_local_id:string|null;scope_revision:number;rights_id:string;import_revision:number}|undefined;
  if(!row)throw new Error('保存的用户歌词不存在');
  if(row.rights_id!=='local-private-v1')throw new Error('此文档不属于可复用的用户导入歌词');
  if(row.raw_bytes.length<1||row.raw_bytes.length>1048576||digest(row.raw_bytes)!==row.raw_sha256)throw new Error('保存的歌词原文校验失败');
  const document=parsed(row),version=this.savedSummary({...row,kind:document.kind,line_count:document.lines.length,raw_size:row.raw_bytes.length},lookup);
  return {summary:version,rawBase64:Buffer.from(row.raw_bytes).toString('base64'),preview:{scopeSnapshot:this.context(row.id,row.scope,row.item_id),text:row.decoded_text,encoding:row.encoding,rawSha256:row.raw_sha256,rawBytes:row.raw_bytes.length,document}};
 }
 checkOrigin(value:LyricsImportInput):void{
  const input=validateLyricsImport(value);
  if(input.sourceLocalVersionId){
   const source=this.localSource(input.sourceLocalVersionId),raw=Buffer.from(input.rawBase64,'base64');
   if(source.summary.rawSha256!==digest(raw)||input.rawBase64!==source.rawBase64)throw new Error('本地歌词复制来源与原始字节不一致，请重新选择来源');return;
  }
  if(!input.sourceDocumentId)return;
  const row=this.db.prepare('SELECT raw_bytes,raw_sha256,rights_id FROM lyrics_document WHERE id=?').get(input.sourceDocumentId) as {raw_bytes:Uint8Array;raw_sha256:string;rights_id:string}|undefined;
  if(!row||row.rights_id!=='local-private-v1')throw new Error('复制来源不是保存的用户歌词');
  if(digest(row.raw_bytes)!==row.raw_sha256||digest(Buffer.from(input.rawBase64,'base64'))!==row.raw_sha256)throw new Error('复制来源与预览原始内容不一致，请重新选择来源');
 }
 changes(item:LibraryItem,cursor?:string):import('../shared/contracts.js').LyricsDocumentChangePage{
  const scope=lyricsScope(item);let end:number|null=null;
  if(cursor!==undefined){
   if(typeof cursor!=='string'||cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error('无效歌词修订分页');
   try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(value.scope!==scope||!Number.isSafeInteger(value.revision)||value.revision<1)throw new Error();end=value.revision;}catch{throw new Error('无效歌词修订分页');}
  }
  const select="SELECT c.command_id,c.document_id,c.action,c.created_at,d.label,c.revision FROM lyrics_document_change c JOIN lyrics_document d ON d.id=c.document_id WHERE c.scope=?";
  type ChangeRow={command_id:string;document_id:string;action:'import'|'archive'|'restore';created_at:string;label:string;revision:number};
  const rows=(end!==null?this.db.prepare(`${select} AND c.revision<? ORDER BY c.revision DESC LIMIT 21`).all(scope,end):this.db.prepare(`${select} ORDER BY c.revision DESC LIMIT 21`).all(scope)) as ChangeRow[];
  const last=rows[19];
  return {items:rows.slice(0,20).map(row=>{if(!Number.isSafeInteger(row.revision)||row.revision<1)throw new Error('歌词修订记录无效');return {commandId:row.command_id,documentId:row.document_id,action:row.action,label:row.label,revision:row.revision,createdAt:row.created_at};}),nextCursor:rows.length>20?Buffer.from(JSON.stringify({scope,revision:last.revision})).toString('base64url'):null};
 }
 private requestIdentity(request:LyricsDocumentRequest):string{
  // Receipts retain identity and hashes, never duplicate the raw user document.
  if(request.action!=='import')return JSON.stringify(request);
  const {rawBase64,...input}=request.input;return JSON.stringify({...request,input:{...input,rawSha256:digest(Buffer.from(rawBase64,'base64'))}});
 }
 receipt(value:unknown):LyricsDocumentResult|null{
  const request=validateLyricsDocumentRequest(value),row=this.db.prepare('SELECT request_json,result_json,document_id,revision FROM lyrics_document_change WHERE command_id=?').get(request.commandId) as {request_json:string;result_json:string;document_id:string;revision:number}|undefined;
  if(!row)return null;if(row.request_json!==this.requestIdentity(request))throw new Error('同一歌词操作不可更改内容');
  const result=JSON.parse(row.result_json) as LyricsDocumentResult;
  if(result.status!=='saved'||result.documentId!==row.document_id||result.revision!==row.revision||!Number.isSafeInteger(row.revision)||row.revision<1||result.error!=='')throw new Error('歌词操作回执无效');
  return result;
 }
 edit(item:LibraryItem,value:unknown):LyricsDocumentResult{
  const request=validateLyricsDocumentRequest(value),old=this.receipt(request);if(old)return old;
  const preview=request.action==='import'?previewLyricsImport(item,request.input):null;
  if(request.action==='import')this.checkOrigin(request.input);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const replay=this.receipt(request);if(replay){this.db.exec('COMMIT');return replay;}
   const state=this.state(item);
   if(item.id!==request.itemId||state.scope!==request.scope)throw new Error('曲目或 CUE 范围已变化，请重新读取');
   if(state.revision!==request.baseRevision)throw new Error('歌词文档列表已变化，请重新读取后再修改');
   if(state.revision>=Number.MAX_SAFE_INTEGER)throw new Error('歌词文档修订已达上限');
   let id:string;
   const now=new Date().toISOString();
   this.db.prepare('INSERT OR IGNORE INTO lyrics_document_scope VALUES(?,?,0)').run(state.scope,item.id);
   if(request.action==='import'&&preview){
    const input=request.input,raw=Buffer.from(input.rawBase64,'base64'),json=JSON.stringify(preview.document);
    id=digest(JSON.stringify([state.scope,preview.rawSha256,digest(preview.text),input.label,input.language,input.timeBasis,preview.encoding,parserVersion,...(input.sourceLocalVersionId?['local-observation',input.sourceLocalVersionId]:[])]));
    if(this.db.prepare('SELECT id FROM lyrics_document WHERE id=?').get(id))throw new Error('相同歌词版本已保存，可在版本列表恢复或选择');
    const usage=this.db.prepare('SELECT count(*) AS n,coalesce(sum(length(raw_bytes)),0) AS bytes FROM lyrics_document WHERE scope=?').get(state.scope) as {n:number;bytes:number};
    if(usage.n>=64||usage.bytes+raw.length>32*1024*1024)throw new Error('此范围已达 64 个版本或 32 MiB 原文上限，现有用户文档不会被清理');
    this.requireActiveCapacity(state.scope,json);
    this.db.prepare('INSERT INTO lyrics_document VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,state.scope,item.id,input.label,input.language,input.timeBasis,preview.encoding,raw,preview.rawSha256,preview.text,json,parserVersion,'local-private-v1',now,state.revision+1);
    const contextJson=JSON.stringify(preview.scopeSnapshot);if(!preview.scopeSnapshot)throw new Error('导入缺少当前范围快照');
    this.db.prepare('INSERT INTO lyrics_document_context VALUES(?,?,?)').run(id,contextJson,digest(contextJson));
    this.db.prepare('INSERT INTO lyrics_document_state VALUES(?,0,?)').run(id,now);
    if(input.sourceLocalVersionId)this.db.prepare('INSERT INTO lyrics_document_local_origin VALUES(?,?)').run(id,input.sourceLocalVersionId);
   }else if(request.action!=='import'){
    id=request.documentId;this.changeState(state.scope,item.id,id,request.action,now);
   }else throw new Error('无效歌词导入');
   this.db.prepare('UPDATE lyrics_document_scope SET revision=? WHERE scope=?').run(state.revision+1,state.scope);
   const result:LyricsDocumentResult={status:'saved',documentId:id,revision:state.revision+1,error:''};
   this.db.prepare('INSERT INTO lyrics_document_change VALUES(?,?,?,?,?,?,?,?)').run(request.commandId,state.scope,id,request.action,this.requestIdentity(request),JSON.stringify(result),now,state.revision+1);
   this.db.exec('COMMIT');return result;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 savedChanges(documentId:unknown,cursor?:string):SavedLyricsChangePage{
  if(typeof documentId!=='string'||!hash.test(documentId))throw new Error('无效歌词文档');
  const row=this.db.prepare("SELECT d.scope,sc.revision FROM lyrics_document d JOIN lyrics_document_scope sc ON sc.scope=d.scope AND sc.item_id=d.item_id WHERE d.id=? AND d.rights_id='local-private-v1'").get(documentId) as {scope:string;revision:number}|undefined;
  if(!row||!Number.isSafeInteger(row.revision)||row.revision<1)throw new Error('用户歌词范围不存在');
  let end:number|null=null;
  if(cursor!==undefined){try{if(typeof cursor!=='string'||cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error();const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(c.documentId!==documentId||c.scope!==row.scope||c.scopeRevision!==row.revision||!Number.isSafeInteger(c.revision)||c.revision<1)throw new Error();end=c.revision;}catch{throw new Error('歌词修订分页已变化或无效，请重新读取');}}
  const rows=this.db.prepare(`SELECT c.command_id,c.document_id,c.action,c.created_at,d.label,c.revision FROM lyrics_document_change c JOIN lyrics_document d ON d.id=c.document_id WHERE c.document_id=? ${end===null?'':'AND c.revision<?'} ORDER BY c.revision DESC LIMIT 21`).all(...(end===null?[documentId]:[documentId,end])) as Array<{command_id:string;document_id:string;action:'import'|'archive'|'restore';created_at:string;label:string;revision:number}>;
  const last=rows[19];return {scope:row.scope,revision:row.revision,items:rows.slice(0,20).map(c=>{if(!Number.isSafeInteger(c.revision)||c.revision<1||c.revision>row.revision)throw new Error('歌词修订记录无效');return {commandId:c.command_id,documentId:c.document_id,action:c.action,label:c.label,revision:c.revision,createdAt:c.created_at};}),nextCursor:rows.length>20?Buffer.from(JSON.stringify({documentId,scope:row.scope,scopeRevision:row.revision,revision:last.revision})).toString('base64url'):null};
 }
 editSaved(value:unknown):LyricsDocumentResult{
  const request=validateSavedLyricsStateRequest(value),old=this.receipt(request);if(old)return old;
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const replay=this.receipt(request);if(replay){this.db.exec('COMMIT');return replay;}
   const state=this.db.prepare('SELECT item_id,revision FROM lyrics_document_scope WHERE scope=?').get(request.scope) as {item_id:string;revision:number}|undefined;
   if(!state||state.item_id!==request.itemId||!Number.isSafeInteger(state.revision)||state.revision<1)throw new Error('保存的歌词范围关联无效');
   if(state.revision!==request.baseRevision)throw new Error('此歌词范围已变化，请重新读取后再修改');
   if(state.revision>=Number.MAX_SAFE_INTEGER)throw new Error('歌词文档修订已达上限');
   const now=new Date().toISOString();this.changeState(request.scope,request.itemId,request.documentId,request.action,now);
   this.db.prepare('UPDATE lyrics_document_scope SET revision=? WHERE scope=?').run(state.revision+1,request.scope);
   const result:LyricsDocumentResult={status:'saved',documentId:request.documentId,revision:state.revision+1,error:''};
   this.db.prepare('INSERT INTO lyrics_document_change VALUES(?,?,?,?,?,?,?,?)').run(request.commandId,request.scope,request.documentId,request.action,this.requestIdentity(request),JSON.stringify(result),now,state.revision+1);
   this.db.exec('COMMIT');return result;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 private changeState(scope:string,itemId:string,id:string,action:'archive'|'restore',now:string):void{
  const row=this.db.prepare('SELECT d.item_id,d.rights_id,d.raw_bytes,d.raw_sha256,d.parsed_json,s.archived FROM lyrics_document d JOIN lyrics_document_state s ON s.document_id=d.id WHERE d.id=? AND d.scope=?').get(id,scope) as {item_id:string;rights_id:string;raw_bytes:Uint8Array;raw_sha256:string;parsed_json:string;archived:number}|undefined;
  if(!row||row.item_id!==itemId||row.rights_id!=='local-private-v1')throw new Error('用户歌词不属于所选范围');
  const archive=action==='archive';if(!!row.archived===archive)throw new Error(archive?'此文档已归档':'此文档已启用');
  if(!archive){
   if(row.raw_bytes.length<1||row.raw_bytes.length>1048576||digest(row.raw_bytes)!==row.raw_sha256)throw new Error('歌词原文字节校验失败，不能恢复');
   parsed({id,parsed_json:row.parsed_json});this.context(id,scope,itemId);this.requireActiveCapacity(scope,row.parsed_json);
  }
  this.db.prepare('UPDATE lyrics_document_state SET archived=?,changed_at=? WHERE document_id=?').run(archive?1:0,now,id);
 }
 private requireActiveCapacity(scope:string,newJson:string):void{
  const active=this.db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(d.parsed_json AS BLOB))),0) AS bytes FROM lyrics_document d JOIN lyrics_document_state s ON s.document_id=d.id WHERE d.scope=? AND s.archived=0').get(scope) as {n:number;bytes:number};
  if(active.n>=16||active.bytes+Buffer.byteLength(newJson,'utf8')>4*1024*1024)throw new Error('启用文档已达 16 份或 4 MiB 解析内容上限，可先归档一个版本');
 }
}
