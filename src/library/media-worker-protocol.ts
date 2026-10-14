import {readTagFieldChanges,readFlacTagPreview,type TagFieldChange,type FlacTagPreview} from '../shared/tag-write.js';
import {readCueEncoding,readCueGapPolicy} from '../shared/cue-history.js';
import {validateReplayGain} from '../shared/audio-processing.js';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {Stats} from 'node:fs';
import type {ParsedFile} from './database.js';
import type {ParsedCueSource} from './cue-read.js';
import {CUE_PARSER_VERSION} from './cue.js';
import {readFlacCueSource} from './flac-cuesheet.js';
import {readFlacCueTextSource,FLAC_CUE_TEXT_PARSER} from './flac-cue-text.js';
import type {ArtworkCandidate,LyricsDocument} from '../shared/contracts.js';
import type {LyricsContext} from './lyrics.js';

export const MEDIA_PROTOCOL_VERSION=16 as const;
export const MEDIA_REQUEST_LIMIT=65536;
export const MEDIA_RESPONSE_LIMIT=2*1024*1024;
export const CUE_RESPONSE_LIMIT=6*1024*1024;
export const ARTWORK_RESPONSE_LIMIT=3*1024*1024;
export const LYRICS_RESPONSE_LIMIT=26*1024*1024;
export interface LocalLyricsObservation {documentId:string;source:string;rawBase64:string;rawSha256:string;encoding:'utf-8'|'utf-16le'|'utf-16be'|'gb18030';before:MediaStat}
export interface MediaStat {size:number;mtimeMs:number;ctimeMs:number;dev:number;ino:number}
export interface MediaRequest {version:typeof MEDIA_PROTOCOL_VERSION;kind:'tags'|'cue'|'artwork'|'image'|'lyrics'|'flac-tag-preview';id:string;rootPath:string;realRootPath:string;fullPath:string;relativePath:string;before:MediaStat;tagChanges?:TagFieldChange[];thumbnailSize?:256|1024;rejectedTokens?:string[];artworkSource?:'embedded'|'sidecar';lyricsContext?:LyricsContext;cueEncoding?:import('../shared/cue-history.js').CueEncoding;cueGapPolicy?:import('../shared/cue-history.js').CueGapPolicy}
export class MediaBoundaryError extends Error{}
export type MediaResponse={version:typeof MEDIA_PROTOCOL_VERSION;id:string}&({kind:'image';image:import('../shared/contracts.js').ConvertedCoverImage;after:MediaStat}|{kind:'flac-tag-preview';preview:FlacTagPreview;after:MediaStat}|{kind:'result';file:ParsedFile;after:MediaStat}|{kind:'cue';source:ParsedCueSource;after:MediaStat}|{kind:'artwork';candidate:ArtworkCandidate|null;after:MediaStat}|{kind:'lyrics';documents:LyricsDocument[];observations:LocalLyricsObservation[];notice:string;after:MediaStat}|{kind:'error';category:'boundary'|'parse';message:string});
export function mediaStat(stat:Stats):MediaStat{return {size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,dev:stat.dev,ino:stat.ino};}
export function sameMediaStat(a:MediaStat,b:MediaStat):boolean{return ['size','mtimeMs','ctimeMs','dev','ino'].every(key=>a[key as keyof MediaStat]===b[key as keyof MediaStat]);}
export function insideMediaRoot(root:string,value:string):boolean{const relative=path.relative(root,value);return relative===''||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`);}
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const text=(value:unknown,max=16384):value is string=>typeof value==='string'&&value.length<=max&&!value.includes('\0');
function statValid(value:unknown):value is MediaStat{return record(value)&&Object.keys(value).length===5&&['size','mtimeMs','ctimeMs','dev','ino'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key]))&&Number.isSafeInteger(value.size)&&Number(value.size)>=0;}
export function validateMediaRequest(value:unknown):MediaRequest{
 if(!record(value)||Object.keys(value).length!==(value.kind==='artwork'?11:value.kind==='cue'?10:value.kind==='lyrics'||value.kind==='flac-tag-preview'||value.kind==='image'?9:8)||value.version!==MEDIA_PROTOCOL_VERSION||(typeof value.kind!=='string'||!['tags','cue','artwork','image','lyrics','flac-tag-preview'].includes(value.kind))||!text(value.id,36)||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.id)||!statValid(value.before))throw new Error('无效媒体解析请求');
 if(value.kind==='image'&&(![256,1024].includes(value.thumbnailSize as number)||value.before.size<1||value.before.size>16777216))throw new Error('无效图片转换请求');
 if(value.kind==='flac-tag-preview')readTagFieldChanges(value.tagChanges);
 if(value.kind==='cue'){readCueEncoding(value.cueEncoding);readCueGapPolicy(value.cueGapPolicy);}
 if(value.kind==='lyrics'){
  const c=value.lyricsContext,seconds=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER,frame=(v:unknown)=>v===null||Number.isSafeInteger(v)&&Number(v)>=0;
  if(!record(c)||!([7,8].includes(Object.keys(c).length))||!['file','cue'].includes(String(c.kind))||!text(c.title,16384)||!seconds(c.sourceStartSeconds)||c.sourceEndSeconds!==null&&(!seconds(c.sourceEndSeconds)||Number(c.sourceEndSeconds)<=Number(c.sourceStartSeconds))||!frame(c.sourceStartCueFrame)||!frame(c.sourceEndCueFrame)||!frame(c.cueIndex01Frame)||c.kind==='file'&&c.cueIndex01Frame!==null||c.cueIndex01Frame!==null&&(c.sourceStartCueFrame===null||Number(c.cueIndex01Frame)<Number(c.sourceStartCueFrame)||c.sourceEndCueFrame!==null&&Number(c.cueIndex01Frame)>=Number(c.sourceEndCueFrame))||c.sourceStartCueFrame!==null&&c.sourceEndCueFrame!==null&&Number(c.sourceEndCueFrame)<=Number(c.sourceStartCueFrame))throw new Error('无效歌词范围');
  if(c.cueIndex01Seconds!==undefined&&c.cueIndex01Seconds!==null&&(!seconds(c.cueIndex01Seconds)||c.kind!=='cue'||Number(c.cueIndex01Seconds)<Number(c.sourceStartSeconds)||c.sourceEndSeconds!==null&&Number(c.cueIndex01Seconds)>=Number(c.sourceEndSeconds)||c.cueIndex01Frame!==null&&Math.abs(Number(c.cueIndex01Seconds)-Number(c.cueIndex01Frame)/75)>1e-9))throw new Error('歌词 INDEX01 与采样时间范围不符');
  if(Object.keys(c).some(key=>!['kind','title','sourceStartSeconds','sourceEndSeconds','sourceStartCueFrame','sourceEndCueFrame','cueIndex01Frame','cueIndex01Seconds'].includes(key)))throw new Error('歌词范围含未知字段');
 }
 if(value.kind==='artwork'&&(!['embedded','sidecar'].includes(String(value.artworkSource))||![256,1024].includes(value.thumbnailSize as number)||!Array.isArray(value.rejectedTokens)||value.rejectedTokens.length>8||value.rejectedTokens.some(token=>!text(token,64)||!/^[0-9a-f]{64}$/.test(token))))throw new Error('无效缩略图请求');
 for(const key of ['rootPath','realRootPath','fullPath'])if(!text(value[key],32768)||!path.isAbsolute(value[key]))throw new Error('媒体路径无效');
 if(!text(value.relativePath,32768)||!value.relativePath||path.isAbsolute(value.relativePath)||!insideMediaRoot(value.rootPath as string,value.fullPath as string)||path.resolve(value.rootPath as string,value.relativePath)!==path.resolve(value.fullPath as string))throw new Error('媒体路径越过授权目录');
 return (value.kind==='flac-tag-preview'?{...value,tagChanges:readTagFieldChanges(value.tagChanges)}:value) as unknown as MediaRequest;
}
export function validateMediaResponse(value:unknown,request:MediaRequest):MediaResponse{
 if(!record(value)||value.version!==MEDIA_PROTOCOL_VERSION||value.id!==request.id)throw new Error('媒体解析回执身份不符');
 if(value.kind==='error'&&Object.keys(value).length===5&&['boundary','parse'].includes(String(value.category))&&text(value.message,500)&&value.message)return value as unknown as MediaResponse;
 if(request.kind==='flac-tag-preview'){
  if(!tagWritePreviewEnvelope(value,request))throw new Error('FLAC 标签预览文件观察无效');
  const preview=readFlacTagPreview(value.preview,request.tagChanges);if(preview.sourceFileBytes!==String(request.before.size))throw new Error('FLAC 标签预览来源大小与请求不符');
  return {...value,preview} as unknown as MediaResponse;
 }
 if(request.kind==='lyrics'){
  if(value.kind!=='lyrics'||Object.keys(value).length!==7||!statValid(value.after)||!sameMediaStat(request.before,value.after)||!text(value.notice,500))throw new Error('歌词文件观察无效');
  validateLyricsDocuments(value.documents,request);validateLyricsObservations(value.observations,value.documents);return value as unknown as MediaResponse;
 }
 if(request.kind==='image'){
  const image=value.image;
  if(value.kind!=='image'||Object.keys(value).length!==5||!statValid(value.after)||!sameMediaStat(request.before,value.after)||!record(image)||Object.keys(image).length!==4||!text(image.url,ARTWORK_RESPONSE_LIMIT)||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.url)||!text(image.token,64)||!/^[0-9a-f]{64}$/.test(image.token)||!Number.isSafeInteger(image.width)||Number(image.width)<1||Number(image.width)>request.thumbnailSize!||!Number.isSafeInteger(image.height)||Number(image.height)<1||Number(image.height)>request.thumbnailSize!)throw new Error('图片转换回执无效');
  return value as unknown as MediaResponse;
 }
 if(request.kind==='artwork'){
  if(value.kind!=='artwork'||Object.keys(value).length!==5||!statValid(value.after)||!sameMediaStat(request.before,value.after))throw new Error('封面文件观察无效');
  const image=value.candidate;
  if(image!==null&&(!record(image)||Object.keys(image).length!==6||!text(image.url,ARTWORK_RESPONSE_LIMIT)||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.url)||!text(image.token,64)||!/^[0-9a-f]{64}$/.test(image.token)||image.sourceKind!==request.artworkSource||!text(image.label,512)||!Number.isSafeInteger(image.width)||Number(image.width)<1||Number(image.width)>request.thumbnailSize!||!Number.isSafeInteger(image.height)||Number(image.height)<1||Number(image.height)>request.thumbnailSize!))throw new Error('缩略图回执无效');
  return value as unknown as MediaResponse;
 }
 if(request.kind==='cue'){
  if(value.kind!=='cue'||Object.keys(value).length!==5||!statValid(value.after)||!sameMediaStat(request.before,value.after)||!record(value.source)||Object.keys(value.source).length!==9||!text(value.source.sourceHash,64)||!/^[0-9a-f]{64}$/.test(value.source.sourceHash)||!['utf-8','utf-16le','utf-16be','gb18030'].includes(String(value.source.encoding))||value.source.parserVersion!==CUE_PARSER_VERSION)throw new Error('CUE 来源观察无效');
  if(value.source.gapPolicy!==request.cueGapPolicy||value.source.requestedEncoding!==request.cueEncoding||!text(value.source.parseError,500)||!text(value.source.rawBase64,2796204)||!Number.isSafeInteger(value.source.rawBytes)||value.source.rawBytes!==request.before.size)throw new Error('CUE 原文回执无效');
  const raw=Buffer.from(value.source.rawBase64 as string,'base64');if(raw.length>2097152||raw.length!==value.source.rawBytes||raw.toString('base64')!==value.source.rawBase64||createHash('sha256').update(raw).digest('hex')!==value.source.sourceHash)throw new Error('CUE 原文字节校验失败');
  if(Buffer.byteLength(JSON.stringify(value.source.document),'utf8')>2097152)throw new Error('CUE 编排超过预算');
  validateCueSheet(value.source.document);if(!record(value.source.document)||value.source.document.gapPolicy!==request.cueGapPolicy)throw new Error('CUE 前间隙回执不符');return value as unknown as MediaResponse;
 }
 const file=value.file;
 if(value.kind!=='result'||Object.keys(value).length!==5||!record(file)||!statValid(value.after)||!sameMediaStat(request.before,value.after)||file.relativePath!==request.relativePath||file.size!==request.before.size||file.mtimeMs!==request.before.mtimeMs||file.parseError!==undefined)throw new Error('媒体解析文件观察不符');
 const fields=['relativePath','size','mtimeMs','title','artist','album','genre','durationSeconds','codec','sampleRate','bitsPerSample','trackNumber','discNumber','catalog','replayGain','embeddedCue','embeddedCueText'];
 if(Object.keys(file).some(key=>!fields.includes(key))||['title','artist','album','genre','codec'].some(key=>!text(file[key])))throw new Error('媒体解析标签无效');
 for(const key of ['sampleRate','bitsPerSample','trackNumber','discNumber'])if(file[key]!==null&&(!Number.isSafeInteger(file[key])||Number(file[key])<0||Number(file[key])>2147483647))throw new Error('媒体解析数值无效');
 if(file.durationSeconds!==null&&(typeof file.durationSeconds!=='number'||!Number.isFinite(file.durationSeconds)||file.durationSeconds<0))throw new Error('媒体解析时长无效');
 if(file.replayGain!==undefined)validateReplayGain(file.replayGain);
 if(Object.hasOwn(file,'embeddedCue')!==Object.hasOwn(file,'embeddedCueText'))throw new Error('FLAC 内嵌编排观察不完整');
 if(file.embeddedCue!==undefined&&file.embeddedCue!==null){const source=readFlacCueSource(file.embeddedCue,request.before.size);if(source.sampleRate!==file.sampleRate||typeof file.durationSeconds!=='number'||Math.abs(source.totalSamples/source.sampleRate-file.durationSeconds)>0.000001)throw new Error('FLAC CUESHEET 与媒体音频参数不符');}
 if(file.embeddedCueText!==undefined&&file.embeddedCueText!==null){const source=readFlacCueTextSource(file.embeddedCueText,request.before.size);if(source.parserVersion!==FLAC_CUE_TEXT_PARSER||file.embeddedCue===undefined||source.sampleRate!==file.sampleRate||typeof file.durationSeconds!=='number'||Math.abs(source.totalSamples/source.sampleRate-file.durationSeconds)>0.000001||file.embeddedCue!==null&&(file.embeddedCue as Record<string,unknown>).streamInfoBase64!==source.streamInfoBase64)throw new Error('FLAC 内嵌 CUE 文本与媒体音频参数不符');}
 if(file.catalog!==undefined){
  if(!record(file.catalog))throw new Error('媒体解析集合无效');
  const arrays=['artists','albumArtists','composers','conductors','orchestras','genres','isrcs'],strings=['albumArtist','date','country','edition','label','catalogNumber','barcode'];
  for(const [key,field] of Object.entries(file.catalog)){
   if(arrays.includes(key)){if(!Array.isArray(field)||field.length>128||field.some(v=>!text(v)))throw new Error('媒体解析署名集合无效');}
   else if(strings.includes(key)){if(!text(field))throw new Error('媒体解析发行字段无效');}
   else if(key==='fieldOrigins'){if(!record(field)||Object.entries(field).some(([name,origin])=>!['title','artist','album'].includes(name)||!['file-tag','cue','filename','missing'].includes(String(origin))))throw new Error('媒体解析字段来源无效');}
   else throw new Error('媒体解析字段不在契约内');
  }
 }
 return value as unknown as MediaResponse;
}
export function lyricsDocumentId(document:LyricsDocument):string{return createHash('sha256').update(JSON.stringify([document.sourceKind,document.sourceKind==='sidecar'?document.source:'embedded',document.language??'',document.descriptor??'',document.sourceOffsetMs??0,document.kind,document.lines])).digest('hex');}
export function validateLyricsObservations(value:unknown,documents:LyricsDocument[]):asserts value is LocalLyricsObservation[]{
 if(!Array.isArray(value)||value.length>16)throw new Error('歌词原文观察数量无效');const seen=new Set<string>();let total=0;
 for(const o of value){
  if(!record(o)||Object.keys(o).length!==6||!text(o.documentId,64)||seen.has(o.documentId)||!text(o.source,32768)||!text(o.rawBase64,1398104)||!text(o.rawSha256,64)||!/^[0-9a-f]{64}$/.test(o.rawSha256)||!['utf-8','utf-16le','utf-16be','gb18030'].includes(String(o.encoding))||!statValid(o.before))throw new Error('歌词原文观察字段无效');
  const document=documents.find(d=>d.id===o.documentId&&d.sourceKind==='sidecar'&&d.source===o.source);if(!document)throw new Error('歌词原文不属于返回来源');
  const raw=Buffer.from(o.rawBase64,'base64');if(!raw.length||raw.length>1048576||raw.length!==o.before.size||raw.toString('base64')!==o.rawBase64||createHash('sha256').update(raw).digest('hex')!==o.rawSha256)throw new Error('歌词原文字节无效');total+=raw.length;seen.add(o.documentId);
 }
 if(total>16*1024*1024||documents.some(d=>d.sourceKind==='sidecar'&&!seen.has(d.id!)))throw new Error('歌词原文观察不完整或超过预算');
}
export function validateLyricsDocuments(value:unknown,request:MediaRequest):asserts value is LyricsDocument[]{
 if(!Array.isArray(value)||value.length>16||Buffer.byteLength(JSON.stringify(value),'utf8')>1536*1024)throw new Error('歌词集合超过预算');
 const ids=new Set<string>();
 for(const doc of value){
  if(!record(doc)||Object.keys(doc).some(key=>!['source','sourceKind','id','label','language','encoding','descriptor','sourceOffsetMs','kind','lines'].includes(key))||!text(doc.source,32768)||!['embedded','sidecar'].includes(String(doc.sourceKind))||!text(doc.id,64)||!/^[0-9a-f]{64}$/.test(doc.id)||ids.has(doc.id)||!text(doc.label,512)||!doc.label||!text(doc.encoding,64)||doc.language!==undefined&&!text(doc.language,32)||doc.descriptor!==undefined&&!text(doc.descriptor,128)||!Number.isSafeInteger(doc.sourceOffsetMs)||!['timed','plain'].includes(String(doc.kind))||!Array.isArray(doc.lines)||!doc.lines.length||doc.lines.length>5000)throw new Error('歌词文档字段无效');
  if(doc.sourceKind==='sidecar'){if(!path.isAbsolute(doc.source)||path.dirname(doc.source)!==path.dirname(request.fullPath)||!insideMediaRoot(request.rootPath,doc.source))throw new Error('歌词来源路径无效');}
  else if(!['歌曲内嵌歌词','歌曲内嵌同步歌词'].includes(doc.source))throw new Error('内嵌歌词来源无效');
  let previous=-Infinity,bytes=0;
  for(const line of doc.lines){if(!record(line)||Object.keys(line).length!==2||!text(line.text,32768)||!line.text||Buffer.byteLength(line.text,'utf8')>32768||typeof line.atSeconds!=='number'||!Number.isFinite(line.atSeconds)||Math.abs(line.atSeconds)>Number.MAX_SAFE_INTEGER||doc.kind==='plain'&&line.atSeconds!==0||doc.kind==='timed'&&line.atSeconds<previous)throw new Error('歌词行无效');previous=line.atSeconds;bytes+=Buffer.byteLength(line.text,'utf8');}
  if(bytes>1024*1024||lyricsDocumentId(doc as unknown as LyricsDocument)!==doc.id)throw new Error('歌词内容或身份无效');ids.add(doc.id);
 }
}
function tagWritePreviewEnvelope(value:Record<string,unknown>,request:MediaRequest):boolean{return value.kind==='flac-tag-preview'&&Object.keys(value).length===5&&statValid(value.after)&&sameMediaStat(request.before,value.after);}
function validateCueSheet(value:unknown):void{
 if(!record(value)||Object.keys(value).some(key=>!['title','performer','songwriter','catalog','cdTextFile','fields','entries','hiddenEntries','warnings','invalid','gapPolicy'].includes(key))||!['previous','current'].includes(String(value.gapPolicy))||!text(value.title)||!text(value.performer)||typeof value.invalid!=='boolean'||!Array.isArray(value.entries)||value.entries.length>1000||!Array.isArray(value.hiddenEntries)||value.hiddenEntries.length>1000||!Array.isArray(value.warnings)||value.warnings.length>256||value.warnings.some(v=>!text(v)))throw new Error('CUE 编排回执无效');
 const frame=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
 const fields=(v:unknown)=>v===undefined||Array.isArray(v)&&v.length<=128&&v.every(f=>record(f)&&Object.keys(f).length===3&&text(f.command,64)&&text(f.value)&&Number.isSafeInteger(f.line)&&Number(f.line)>0);
 if(!fields(value.fields)||['songwriter','catalog','cdTextFile'].some(key=>value[key]!==undefined&&!text(value[key])))throw new Error('CUE 文档字段无效');
 for(const [list,hidden] of [[value.entries,false],[value.hiddenEntries,true]] as const){for(const entry of list){
  if(!record(entry)||Object.keys(entry).some(key=>!['number','file','title','performer','index00Frame','index01Frame','startFrame','endFrame','sourceOrdinal','hidden','fileType','performerOrigin','pregapFrame','postgapFrame','songwriter','isrc','indices','flags','fields'].includes(key))||!frame(entry.number)||Number(entry.number)>999||hidden&&entry.number!==0||!hidden&&entry.number===0||!text(entry.file)||!text(entry.title)||!text(entry.performer)||!frame(entry.sourceOrdinal)||Number(entry.sourceOrdinal)>=1000||!frame(entry.index01Frame)||!frame(entry.startFrame)||Number(entry.startFrame)>Number(entry.index01Frame)||entry.hidden!==undefined&&entry.hidden!==hidden||!fields(entry.fields)||!['cue','missing'].includes(String(entry.performerOrigin)))throw new Error('CUE 音轨字段无效');
  for(const key of ['index00Frame','endFrame','pregapFrame','postgapFrame'])if(entry[key]!==undefined&&!frame(entry[key]))throw new Error('CUE 时间字段无效');
  if(hidden&&entry.index01Frame!==0||entry.startFrame!==(hidden?0:value.gapPolicy==='current'?entry.index00Frame??entry.index01Frame:entry.index01Frame)||entry.endFrame!==undefined&&Number(entry.endFrame)<=Number(entry.index01Frame))throw new Error('CUE 实际播放范围无效');
  for(const key of ['fileType','songwriter','isrc'])if(entry[key]!==undefined&&!text(entry[key]))throw new Error('CUE 文本字段无效');
  if(!Array.isArray(entry.indices)||entry.indices.length>100||entry.indices.some(i=>!record(i)||Object.keys(i).length!==2||!frame(i.number)||Number(i.number)>99||!frame(i.frame))||!Array.isArray(entry.flags)||entry.flags.length>4||entry.flags.some(f=>!['DCP','4CH','PRE','SCMS'].includes(f)))throw new Error('CUE 索引或标志无效');
 }}
 // Invalid source documents remain archivable diagnostics. A valid arrangement
 // must additionally prove adjacency and unique ownership of the file prefix.
 if(!value.invalid){
  const key=(file:unknown)=>(file as string).replaceAll('\\','/').toLowerCase(),groups=new Map<string,Array<Record<string,unknown>>>();
  for(const entry of value.entries as Array<Record<string,unknown>>){const file=key(entry.file),tracks=groups.get(file)??[];tracks.push(entry);groups.set(file,tracks);}
  const hidden=value.hiddenEntries as Array<Record<string,unknown>>;
  for(const [file,tracks] of groups){
   for(let index=0;index<tracks.length;index++){
    const track=tracks[index],next=tracks[index+1],indices=track.indices as Array<{number:number;frame:number}>;
    if(next?(track.endFrame!==next.startFrame||Number(next.index01Frame)<=Number(track.index01Frame)||next.index00Frame!==undefined&&Number(next.index00Frame)<=Number(track.index01Frame)):track.endFrame!==undefined)throw new Error('CUE 相邻播放范围不符');
    if(indices.some((point,index)=>index>0&&(point.number<=indices[index-1].number||point.frame<indices[index-1].frame||point.number>1&&point.frame===indices[index-1].frame))||indices.find(point=>point.number===1)?.frame!==track.index01Frame||indices.find(point=>point.number===0)?.frame!==track.index00Frame||track.endFrame!==undefined&&indices.some(point=>point.number>1&&point.frame>=Number(track.endFrame)))throw new Error('CUE 原始索引与播放范围不符');
   }
   const first=tracks[0],prefix=hidden.filter(entry=>key(entry.file)===file);
   if(Number(first.startFrame)>0?(prefix.length!==1||prefix[0].endFrame!==first.startFrame||prefix[0].sourceOrdinal!==first.sourceOrdinal):prefix.length!==0)throw new Error('CUE 前导音频范围不符');
  }
  if(hidden.some(entry=>!groups.has(key(entry.file))))throw new Error('CUE 前导音频缺少正常音轨');
 }
}
export function mediaFrame(value:unknown,limit:number):Buffer{const payload=Buffer.from(JSON.stringify(value),'utf8');if(!payload.length||payload.length>limit)throw new Error('媒体消息超过预算');const frame=Buffer.allocUnsafe(payload.length+4);frame.writeUInt32LE(payload.length);payload.copy(frame,4);return frame;}
