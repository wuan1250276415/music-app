import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {cueId,cueHash} from '../shared/cue-history.js';
import {readEmbeddedCueRequest,readEmbeddedCueExportRequest,EMBEDDED_CUE_EXPORT_LIMIT,type EmbeddedCueSource,type EmbeddedCueVersion,type EmbeddedCuePage,type EmbeddedCueVersionPage,type EmbeddedCuePreview,type EmbeddedCueExportData} from '../shared/embedded-cue-history.js';
import {readFlacCueSource,FLAC_CUE_PARSER,type FlacCueSource} from './flac-cuesheet.js';
import {readFlacCueTextSource,embeddedCueView,type FlacCueTextSource} from './flac-cue-text.js';

const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const MAX_PARSED=2*1024*1024;
export const embeddedCueHistorySchema=`
 CREATE TABLE embedded_cue_asset(id TEXT PRIMARY KEY CHECK(length(id)=64),raw_bytes BLOB NOT NULL CHECK(typeof(raw_bytes)='blob' AND length(raw_bytes) BETWEEN 1 AND 524288),created_at TEXT NOT NULL);
 CREATE TABLE embedded_cue_file(file_id TEXT PRIMARY KEY,root_id TEXT NOT NULL,root_path TEXT NOT NULL,relative_path TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740990),latest_version TEXT REFERENCES embedded_cue_version(id),observed_at TEXT NOT NULL);
 CREATE TABLE embedded_cue_version(id TEXT PRIMARY KEY CHECK(length(id)=64),file_id TEXT NOT NULL REFERENCES embedded_cue_file(file_id),binary_asset TEXT REFERENCES embedded_cue_asset(id),text_asset TEXT REFERENCES embedded_cue_asset(id),payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=2097152),payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),created_at TEXT NOT NULL);
 CREATE INDEX embedded_cue_file_page ON embedded_cue_file(observed_at DESC,file_id DESC);
 CREATE INDEX embedded_cue_version_page ON embedded_cue_version(file_id,created_at DESC,id DESC);
 CREATE TABLE embedded_cue_usage(id INTEGER PRIMARY KEY CHECK(id=1),raw_bytes INTEGER NOT NULL CHECK(raw_bytes BETWEEN 0 AND 536870912),assets INTEGER NOT NULL CHECK(assets BETWEEN 0 AND 32768),parsed_bytes INTEGER NOT NULL CHECK(parsed_bytes BETWEEN 0 AND 536870912),versions INTEGER NOT NULL CHECK(versions BETWEEN 0 AND 65536),files INTEGER NOT NULL CHECK(files BETWEEN 0 AND 65536),generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740990));
 INSERT INTO embedded_cue_usage VALUES(1,0,0,0,0,0,0);
 CREATE TRIGGER embedded_cue_asset_immutable BEFORE UPDATE ON embedded_cue_asset BEGIN SELECT RAISE(ABORT,'内嵌 CUE 原始字节不可修改'); END;
 CREATE TRIGGER embedded_cue_asset_no_delete BEFORE DELETE ON embedded_cue_asset BEGIN SELECT RAISE(ABORT,'内嵌 CUE 原始字节不可作为缓存清理'); END;
 CREATE TRIGGER embedded_cue_version_immutable BEFORE UPDATE ON embedded_cue_version BEGIN SELECT RAISE(ABORT,'内嵌 CUE 历史版本不可修改'); END;
 CREATE TRIGGER embedded_cue_version_no_delete BEFORE DELETE ON embedded_cue_version BEGIN SELECT RAISE(ABORT,'内嵌 CUE 历史版本不可删除'); END;
 CREATE TRIGGER embedded_cue_file_no_delete BEFORE DELETE ON embedded_cue_file BEGIN SELECT RAISE(ABORT,'内嵌 CUE 来源历史不可随音乐文件删除'); END;
`;
type FileRow={file_id:string;root_id:string;root_path:string;relative_path:string;revision:number;latest_version:string;observed_at:string};
type VersionRow={id:string;file_id:string;binary_asset:string|null;text_asset:string|null;payload_json:string;payload_sha256:string;created_at:string};
type Payload={version:1;fileId:string;rootId:string;rootPath:string;relativePath:string;fileBytes:number;artist:string;album:string;provenance:'scan'|'retained-v68';binary:Omit<FlacCueSource,'rawBase64'>|null;text:Omit<FlacCueTextSource,'rawBase64'>|null};
const withoutRaw=<T extends {rawBase64:string}>(value:T|null):Omit<T,'rawBase64'>|null=>{if(!value)return null;const {rawBase64,...metadata}=value;return metadata;};
export class EmbeddedCueHistory {
 private readonly cursorKey=randomBytes(32);
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T){}
 private file(id:unknown):FileRow {const row=this.db.prepare('SELECT * FROM embedded_cue_file WHERE file_id=?').get(cueId(id)) as FileRow|undefined;if(!row?.latest_version)throw new Error('内嵌 CUE 来源历史不存在，请重新扫描');return row;}
 private raw(id:string|null):Buffer|null {
  if(id===null)return null;cueHash(id);const row=this.db.prepare('SELECT raw_bytes FROM embedded_cue_asset WHERE id=?').get(id) as {raw_bytes:Uint8Array}|undefined;
  if(!row||row.raw_bytes.length<1||row.raw_bytes.length>524288||hash(row.raw_bytes)!==id)throw new Error('内嵌 CUE 原始字节校验失败');return Buffer.from(row.raw_bytes);
 }
 private binary(value:unknown,size:number):FlacCueSource|null {
  if(value===null)return null;const v=value as FlacCueSource;
  if(!v||!['aural-flac-cuesheet-1','aural-flac-cuesheet-2','aural-flac-cuesheet-3',FLAC_CUE_PARSER].includes(v.parserVersion))throw new Error('内嵌 CUE 历史解析版本不受支持');
  // Historical parser markers remain historical. Validate the same retained
  // bytes and all parsed fields with the current strict binary parser.
  const parsed=readFlacCueSource({...v,parserVersion:FLAC_CUE_PARSER},size);return {...parsed,parserVersion:v.parserVersion};
 }
 observe(input:{fileId:string;rootId:string;rootPath:string;relativePath:string;size:number;artist:string;album:string;binary:FlacCueSource|null;text:FlacCueTextSource|null;provenance?:'scan'|'retained-v68'}):string|null {
  const fileId=cueId(input.fileId),rootId=cueId(input.rootId),relative=path.relative(input.rootPath,path.resolve(input.rootPath,input.relativePath));
  if(!path.isAbsolute(input.rootPath)||!input.relativePath||path.isAbsolute(input.relativePath)||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||input.rootPath.length>32767||input.relativePath.length>32767||!Number.isSafeInteger(input.size)||input.size<1||input.artist.length>65536||input.album.length>65536)throw new Error('内嵌 CUE 历史来源无效');
  const binary=this.binary(input.binary,input.size),text=input.text?readFlacCueTextSource(input.text,input.size):null;
  if(binary&&text&&binary.streamInfoBase64!==text.streamInfoBase64)throw new Error('内嵌 CUE 历史的音频头不一致');
  return this.transaction(()=>{
   const old=this.db.prepare('SELECT * FROM embedded_cue_file WHERE file_id=?').get(fileId) as FileRow|undefined;
   if(!old&&!binary&&!text)return null;const now=new Date().toISOString();
   if(old&&old.root_id!==rootId)throw new Error('内嵌 CUE 来源身份归属已改变');
   if(!old){const reserved=this.db.prepare('UPDATE embedded_cue_usage SET files=files+1 WHERE id=1 AND files<65536').run();if(Number(reserved.changes)!==1)throw new Error('内嵌 CUE 来源历史容量已满，旧版本保留');this.db.prepare('INSERT INTO embedded_cue_file VALUES(?,?,?,?,0,NULL,?)').run(fileId,rootId,input.rootPath,input.relativePath,now);}
   for(const source of [binary,text])if(source){const raw=Buffer.from(source.rawBase64,'base64'),stored=this.rawIfPresent(source.sourceHash);if(stored){if(!stored.equals(raw))throw new Error('内嵌 CUE 摘要对应不同字节');}else{const reserved=this.db.prepare('UPDATE embedded_cue_usage SET raw_bytes=raw_bytes+?,assets=assets+1 WHERE id=1 AND raw_bytes+?<=536870912 AND assets<32768').run(raw.length,raw.length);if(Number(reserved.changes)!==1)throw new Error('内嵌 CUE 原文历史容量已满，旧版本保留');this.db.prepare('INSERT INTO embedded_cue_asset VALUES(?,?,?)').run(source.sourceHash,raw,now);}}
   const payload:Payload={version:1,fileId,rootId,rootPath:input.rootPath,relativePath:input.relativePath,fileBytes:input.size,artist:input.artist,album:input.album,provenance:input.provenance??'scan',binary:withoutRaw(binary),text:withoutRaw(text)};
   const json=JSON.stringify(payload),bytes=Buffer.byteLength(json),id=hash(json);if(bytes>MAX_PARSED)throw new Error('内嵌 CUE 解析历史超过单版本预算，旧版本保留');
   const existing=this.db.prepare('SELECT payload_json FROM embedded_cue_version WHERE id=?').get(id) as {payload_json:string}|undefined;
   if(existing){if(existing.payload_json!==json)throw new Error('内嵌 CUE 版本摘要冲突');}else{const reserved=this.db.prepare('UPDATE embedded_cue_usage SET parsed_bytes=parsed_bytes+?,versions=versions+1 WHERE id=1 AND parsed_bytes+?<=536870912 AND versions<65536').run(bytes,bytes);if(Number(reserved.changes)!==1)throw new Error('内嵌 CUE 解析历史容量已满，旧版本保留');this.db.prepare('INSERT INTO embedded_cue_version VALUES(?,?,?,?,?,?,?)').run(id,fileId,binary?.sourceHash??null,text?.sourceHash??null,json,id,now);}
   if(old?.latest_version!==id){const changed=this.db.prepare('UPDATE embedded_cue_file SET root_path=?,relative_path=?,latest_version=?,revision=revision+1,observed_at=? WHERE file_id=? AND revision<9007199254740990').run(input.rootPath,input.relativePath,id,now,fileId);if(Number(changed.changes)!==1)throw new Error('内嵌 CUE 历史修订耗尽');const bumped=this.db.prepare('UPDATE embedded_cue_usage SET generation=generation+1 WHERE id=1 AND generation<9007199254740990').run();if(Number(bumped.changes)!==1)throw new Error('内嵌 CUE 历史分页修订耗尽');}
   return id;
  });
 }
 private rawIfPresent(id:string):Buffer|null {return this.db.prepare('SELECT 1 FROM embedded_cue_asset WHERE id=?').get(id)?this.raw(id):null;}
 adoptRetainedDocuments():void {
  const rows=this.db.prepare("SELECT c.id,COALESCE(c.fields_json,'null') fields_json,f.id file_id,f.root_id,r.path root_path,f.relative_path,f.size,COALESCE((SELECT p.artist FROM playable_item p WHERE p.file_id=f.id AND p.kind='file' LIMIT 1),'') artist,COALESCE((SELECT p.album FROM playable_item p WHERE p.file_id=f.id AND p.kind='file' LIMIT 1),'') album FROM cue_document c JOIN media_file f ON f.root_id=c.root_id AND f.relative_path=c.relative_path JOIN library_root r ON r.id=f.root_id WHERE c.parser_version IN('aural-flac-cuesheet-1','aural-flac-cuesheet-2','aural-flac-cuesheet-3','aural-flac-cuesheet-4')");
  for(const raw of rows.iterate()){
   const row=raw as {id:string;fields_json:string;file_id:string;root_id:string;root_path:string;relative_path:string;size:number;artist:string;album:string};
   if(Buffer.byteLength(row.fields_json)>4*1024*1024)throw new Error('既有内嵌 CUE 来源超过迁移预算，原库和迁移前备份保留');
   const document=JSON.parse(row.fields_json);if(!document?.embedded&&!document?.embeddedText)continue;
   const id=this.observe({fileId:row.file_id,rootId:row.root_id,rootPath:row.root_path,relativePath:row.relative_path,size:row.size,artist:row.artist,album:row.album,binary:document.embedded??null,text:document.embeddedText??null,provenance:'retained-v68'});
   this.db.prepare('UPDATE cue_document SET fields_json=? WHERE id=?').run(JSON.stringify({...document,embeddedVersion:id}),row.id);
  }
 }
 private loaded(fileId:unknown,versionId:unknown):{row:VersionRow;payload:Payload;binary:FlacCueSource|null;text:FlacCueTextSource|null} {
  const row=this.db.prepare('SELECT * FROM embedded_cue_version WHERE file_id=? AND id=?').get(cueId(fileId),cueHash(versionId)) as VersionRow|undefined;
  if(!row||Buffer.byteLength(row.payload_json)>MAX_PARSED||hash(row.payload_json)!==row.payload_sha256||row.payload_sha256!==row.id)throw new Error('内嵌 CUE 版本记录校验失败');
  const payload=JSON.parse(row.payload_json) as Payload;
  if(!payload||Object.keys(payload).length!==11||payload.version!==1||payload.fileId!==row.file_id||!Number.isSafeInteger(payload.fileBytes)||payload.fileBytes<1||!['scan','retained-v68'].includes(payload.provenance)||typeof payload.artist!=='string'||typeof payload.album!=='string'||typeof payload.rootPath!=='string'||typeof payload.relativePath!=='string')throw new Error('内嵌 CUE 版本内容无效');cueId(payload.rootId);
  if(payload.rootId!==this.file(row.file_id).root_id||!path.isAbsolute(payload.rootPath)||!payload.relativePath||path.isAbsolute(payload.relativePath)||payload.rootPath.length>32767||payload.relativePath.length>32767||payload.artist.length>65536||payload.album.length>65536)throw new Error('内嵌 CUE 历史来源归属或路径无效');
  if((payload.binary?.sourceHash??null)!==row.binary_asset||(payload.text?.sourceHash??null)!==row.text_asset)throw new Error('内嵌 CUE 原文与版本归属不符');
  const binaryRaw=this.raw(row.binary_asset),textRaw=this.raw(row.text_asset),binary=binaryRaw?this.binary({...payload.binary,rawBase64:binaryRaw.toString('base64')},payload.fileBytes):null,text=textRaw?readFlacCueTextSource({...payload.text,rawBase64:textRaw.toString('base64')},payload.fileBytes):null;
  if(binary&&text&&binary.streamInfoBase64!==text.streamInfoBase64)throw new Error('内嵌 CUE 版本音频头不一致');return {row,payload,binary,text};
 }
 private summary(data:ReturnType<EmbeddedCueHistory['loaded']>):EmbeddedCueVersion {
  const {row,payload:p,binary,text}=data,file=this.file(row.file_id),view=embeddedCueView(binary,text,path.basename(p.relativePath),p.artist,p.album);
  const document=this.db.prepare('SELECT fields_json FROM cue_document WHERE root_id=? AND relative_path=?').get(p.rootId,p.relativePath) as {fields_json:string}|undefined;
  let applied=false;if(document)try{applied=JSON.parse(document.fields_json)?.embeddedVersion===row.id;}catch{throw new Error('当前内嵌 CUE 编排内容无效');}
  return {id:row.id,fileId:row.file_id,rootPath:p.rootPath,relativePath:p.relativePath,fileBytes:p.fileBytes,createdAt:row.created_at,binaryHash:row.binary_asset,textHash:row.text_asset,binaryBytes:binary?Buffer.from(binary.rawBase64,'base64').length:0,textBytes:text?Buffer.from(text.rawBase64,'base64').length:0,binaryParser:binary?.parserVersion??null,textParser:text?.parserVersion??null,sampleRate:binary?.sampleRate??text?.sampleRate??null,totalSamples:binary?.totalSamples??text?.totalSamples??null,state:!binary&&!text?'absent':view.textState==='none'?'binary':view.textState,trackCount:view.entries.filter(e=>!e.hidden).length,timeBaseDen:view.timeBaseDen,notice:view.notice.slice(0,500),latest:file.latest_version===row.id,applied,provenance:p.provenance};
 }
 source(id:unknown):EmbeddedCueSource {const f=this.file(id);return {fileId:f.file_id,rootId:f.root_id,rootPath:f.root_path,relativePath:f.relative_path,revision:f.revision,latestVersion:f.latest_version,observedAt:f.observed_at,version:this.summary(this.loaded(f.file_id,f.latest_version))};}
 forItem(value:unknown):EmbeddedCueSource|null {if(typeof value!=='string'||!value||value.length>128)throw new Error('无效内嵌 CUE 曲目');const r=this.db.prepare('SELECT e.file_id FROM playable_item p JOIN embedded_cue_file e ON e.file_id=p.file_id WHERE p.id=?').get(value) as {file_id:string}|undefined;return r?this.source(r.file_id):null;}
 private cursor(value:unknown,scope:string):{at:string;id:string}|null {
  if(value===undefined)return null;if(typeof value!=='string'||value.length>2048)throw new Error('无效内嵌 CUE 历史分页');
  try{const [body,signature,...extra]=value.split('.'),actual=createHmac('sha256',this.cursorKey).update(body).digest(),provided=Buffer.from(signature??'','base64url');if(extra.length||actual.length!==provided.length||!timingSafeEqual(actual,provided))throw new Error();const c=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));if(Object.keys(c).length!==3||c.scope!==scope||typeof c.at!=='string'||c.at.length!==24||!Number.isFinite(Date.parse(c.at))||new Date(c.at).toISOString()!==c.at||typeof c.id!=='string'||c.id.length>64)throw new Error();return {at:c.at,id:c.id};}catch{throw new Error('内嵌 CUE 历史列表已变化，请重新读取');}
 }
 private next(scope:string,at:string,id:string):string {const body=Buffer.from(JSON.stringify({scope,at,id})).toString('base64url');return body+'.'+createHmac('sha256',this.cursorKey).update(body).digest('base64url');}
 files(query:unknown='',cursor?:unknown):EmbeddedCuePage {
  if(typeof query!=='string'||query.length>256||query.includes('\0'))throw new Error('内嵌 CUE 路径检索无效');const generation=(this.db.prepare('SELECT generation FROM embedded_cue_usage WHERE id=1').get() as {generation:number}).generation,scope=JSON.stringify(['files',generation,query]),c=this.cursor(cursor,scope),term='%'+query.trim().replace(/[\\%_]/g,'\\$&')+'%';
  const rows=this.db.prepare("SELECT file_id,observed_at FROM embedded_cue_file WHERE relative_path LIKE ? ESCAPE '\\' AND (? IS NULL OR observed_at<? OR (observed_at=? AND file_id<?)) ORDER BY observed_at DESC,file_id DESC LIMIT 21").all(term,c?.at??null,c?.at??'',c?.at??'',c?.id??'') as Array<{file_id:string;observed_at:string}>;
  return {items:rows.slice(0,20).map(r=>this.source(r.file_id)),nextCursor:rows.length>20?this.next(scope,rows[19].observed_at,rows[19].file_id):null};
 }
 versions(id:unknown,cursor?:unknown):EmbeddedCueVersionPage {const f=this.file(id),scope=JSON.stringify(['versions',f.file_id,f.revision]),c=this.cursor(cursor,scope),rows=this.db.prepare('SELECT id,created_at FROM embedded_cue_version WHERE file_id=? AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 21').all(f.file_id,c?.at??null,c?.at??'',c?.at??'',c?.id??'') as Array<{id:string;created_at:string}>;return {items:rows.slice(0,20).map(r=>this.summary(this.loaded(f.file_id,r.id))),nextCursor:rows.length>20?this.next(scope,rows[19].created_at,rows[19].id):null};}
 preview(value:unknown):EmbeddedCuePreview {
  const r=readEmbeddedCueRequest(value),data=this.loaded(r.fileId,r.versionId),version=this.summary(data);let text='';if(data.text){try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(data.text.rawBase64,'base64').subarray(9));}catch{text='（保存的原文不是有效 UTF-8；可导出原字段字节进行查阅）';}}
  const binaryText=data.binary?JSON.stringify({catalog:data.binary.catalog,cd:data.binary.cd,leadIn:data.binary.leadIn,sampleRate:data.binary.sampleRate,totalSamples:data.binary.totalSamples,tracks:data.binary.tracks.slice(0,128).map(t=>({...t,indices:t.indices.slice(0,32),indicesOmitted:Math.max(0,t.indices.length-32)})),tracksOmitted:Math.max(0,data.binary.tracks.length-128)},null,2):'';
  const current=this.db.prepare('SELECT f.status,r.path,f.relative_path FROM media_file f JOIN library_root r ON r.id=f.root_id WHERE f.id=?').get(r.fileId) as {status:string;path:string;relative_path:string}|undefined;
  return {version,text:text.slice(0,131072),binaryText:binaryText.slice(0,131072),textTruncated:text.length>131072,binaryTruncated:binaryText.length>131072||Boolean(data.binary&&(data.binary.tracks.length>128||data.binary.tracks.some(t=>t.indices.length>32))),currentState:!current||current.status!=='online'?'unavailable':version.latest&&version.applied&&current.path===data.payload.rootPath&&current.relative_path===data.payload.relativePath?'same':'changed'};
 }
 export(value:unknown):EmbeddedCueExportData {
  const request=readEmbeddedCueExportRequest(value),data=this.loaded(request.fileId,request.versionId);let bytes:Buffer;
  if(request.kind==='binary-block'){if(!data.binary)throw new Error('此版本没有二进制 CUESHEET');bytes=Buffer.from(data.binary.rawBase64,'base64');}
  else if(request.kind==='text-field'||request.kind==='cue-text'){if(!data.text)throw new Error('此版本没有内嵌 CUE 文本');const raw=Buffer.from(data.text.rawBase64,'base64');bytes=request.kind==='cue-text'?raw.subarray(9):raw;}
  else {
   // Original bytes plus header, location and parser marker are the lossless
   // source. Avoid duplicating thousands of derived fields in this portable file.
   const {tracks,...binary}=data.payload.binary??{}, {document,...text}=data.payload.text??{};
   const source={...data.payload,binary:data.binary?binary:null,text:data.text?text:null};
   bytes=Buffer.from(JSON.stringify({format:'aural-embedded-cue-source',version:1,versionId:data.row.id,capturedAt:data.row.created_at,source,binaryRawBase64:data.binary?.rawBase64??null,textFieldRawBase64:data.text?.rawBase64??null},null,2)+'\n','utf8');
  }
  if(bytes.length>EMBEDDED_CUE_EXPORT_LIMIT)throw new Error('内嵌 CUE 导出超过2MiB，请分别导出原始字节');return {versionId:request.versionId,kind:request.kind,rawBase64:bytes.toString('base64'),sha256:hash(bytes),bytes:bytes.length};
 }
}
