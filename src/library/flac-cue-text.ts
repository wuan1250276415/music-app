import {createHash} from 'node:crypto';
import {parseCue,parseCueLegacy3,type CueSheet,type CueEntry} from './cue.js';
import {flacCueEntries,type FlacCueSource,type FlacCueTrack} from './flac-cuesheet.js';

export const FLAC_CUE_TEXT_PARSER='aural-flac-text-cuesheet-2' as const;
const LEGACY_FLAC_CUE_TEXT_PARSER='aural-flac-text-cuesheet-1' as const;
export const FLAC_CUE_TEXT_LIMIT=512*1024;
export interface FlacCueTextSource {version:1;parserVersion:typeof FLAC_CUE_TEXT_PARSER|typeof LEGACY_FLAC_CUE_TEXT_PARSER;commentOffset:number;fieldIndex:number;rawBase64:string;sourceHash:string;streamInfoBase64:string;sampleRate:number;totalSamples:number;document:CueSheet;notice:string}
export interface EmbeddedCueView {entries:CueEntry[];notice:string;timeBaseDen:number;album:string;performer:string;fields:CueSheet['fields'];textState:'none'|'matched'|'text-only'|'rejected'}
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function parseFlacCueText(raw:Buffer,info:Buffer,commentOffset:number,fieldIndex:number):FlacCueTextSource {
 return parseTextWithVersion(raw,info,commentOffset,fieldIndex,FLAC_CUE_TEXT_PARSER);
}
// Portable retained sources omit the derived document. Recreate the exact
// saved parser version before checking its full immutable payload digest.
export function replayFlacCueTextSource(raw:Buffer,info:Buffer,commentOffset:number,fieldIndex:number,parserVersion:unknown):FlacCueTextSource {
 if(parserVersion!==FLAC_CUE_TEXT_PARSER&&parserVersion!==LEGACY_FLAC_CUE_TEXT_PARSER)throw new Error('FLAC 内嵌 CUE 文本解析版本不受支持');
 return parseTextWithVersion(raw,info,commentOffset,fieldIndex,parserVersion);
}
function parseTextWithVersion(raw:Buffer,info:Buffer,commentOffset:number,fieldIndex:number,parserVersion:FlacCueTextSource['parserVersion']):FlacCueTextSource {
 if(raw.length<9||raw.length>FLAC_CUE_TEXT_LIMIT||info.length!==34||!Number.isSafeInteger(commentOffset)||commentOffset<42||commentOffset+raw.length>32*1024*1024||!Number.isSafeInteger(fieldIndex)||fieldIndex<0||fieldIndex>=32768||raw.subarray(0,9).toString('ascii').toUpperCase()!=='CUESHEET=')throw new Error('FLAC 内嵌 CUE 文本来源无效');
 const packed=info.readBigUInt64BE(10),sampleRate=Number(packed>>44n),totalSamples=Number(packed&0xfffffffffn);
 if(sampleRate<1||sampleRate>655350||totalSamples<1)throw new Error('内嵌 CUE 文本要求已知采样率和完整采样数');
 let document:CueSheet,notice='';
 try{const parser=parserVersion===LEGACY_FLAC_CUE_TEXT_PARSER?parseCueLegacy3:parseCue;document=parser(new TextDecoder('utf-8',{fatal:true}).decode(raw.subarray(9)));if(document.invalid)notice=document.warnings.join('；').slice(0,500)||'内嵌 CUE 文本编排无效';}
 catch(error){notice=String(error instanceof Error?error.message:error).replaceAll('\0','').slice(0,500);document={title:'',performer:'',entries:[],fields:[],hiddenEntries:[],invalid:true,warnings:[notice],gapPolicy:'previous'};}
 return {version:1,parserVersion,commentOffset,fieldIndex,rawBase64:raw.toString('base64'),sourceHash:hash(raw),streamInfoBase64:info.toString('base64'),sampleRate,totalSamples,document,notice};
}
export function readFlacCueTextSource(value:unknown,size:number):FlacCueTextSource {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('FLAC 内嵌 CUE 文本回执无效');
 const v=value as Record<string,unknown>;
 if(typeof v.rawBase64!=='string'||v.rawBase64.length>Math.ceil(FLAC_CUE_TEXT_LIMIT/3)*4||typeof v.streamInfoBase64!=='string'||v.streamInfoBase64.length!==48||typeof v.commentOffset!=='number'||typeof v.fieldIndex!=='number'||!Number.isSafeInteger(size))throw new Error('FLAC 内嵌 CUE 文本回执超过预算');
 const raw=Buffer.from(v.rawBase64,'base64'),info=Buffer.from(v.streamInfoBase64,'base64');
 if(raw.toString('base64')!==v.rawBase64||info.toString('base64')!==v.streamInfoBase64||v.commentOffset+raw.length>=size)throw new Error('FLAC 内嵌 CUE 原始字节或文件位置无效');
 if(v.parserVersion!==FLAC_CUE_TEXT_PARSER&&v.parserVersion!==LEGACY_FLAC_CUE_TEXT_PARSER)throw new Error('FLAC 内嵌 CUE 文本解析版本不受支持');
 const parsed=parseTextWithVersion(raw,info,v.commentOffset,v.fieldIndex,v.parserVersion),keys=Object.keys(parsed);
 if(Object.keys(v).length!==keys.length||keys.some(key=>JSON.stringify(v[key])!==JSON.stringify(parsed[key as keyof FlacCueTextSource])))throw new Error('FLAC 内嵌 CUE 文本解析与原字节不符');
 return parsed;
}
function textPositions(source:FlacCueTextSource):FlacCueTrack[] {
 const doc=source.document;if(doc.invalid||!doc.entries.length)throw new Error(source.notice||'内嵌 CUE 文本没有有效音轨');
 // FILE in an embedded single-stream sheet describes the original image name.
 // Bind it to the owning FLAC; never open or resolve that text as a second file.
 const files=new Set(doc.entries.map(entry=>entry.file.replaceAll('\\','/').toLowerCase()));
 if(files.size!==1||[...files].some(file=>/^(?:[a-z]:|\/)/i.test(file)||file.split('/').includes('..')))throw new Error('内嵌 CUE 文本必须是单文件编排，不能引用绝对或上级路径');
 const tick=(frame:number)=>Number(BigInt(frame)*BigInt(source.sampleRate)/75n);
 const tracks=doc.entries.map(entry=>({number:entry.number,offset:tick(entry.index00Frame??entry.index01Frame),audio:true,preEmphasis:entry.flags?.includes('PRE')??false,isrc:entry.isrc??'',indices:(entry.indices??[{number:1,frame:entry.index01Frame}]).map(index=>({number:index.number,sample:tick(index.frame)}))}));
 for(let i=0;i<tracks.length;i++){const track=tracks[i],end=tracks[i+1]?.offset??source.totalSamples;if(track.offset>=end||track.indices.some(index=>index.sample<track.offset||index.sample>=end)||track.indices.some((index,j)=>j>0&&index.sample<=track.indices[j-1].sample))throw new Error('内嵌 CUE 文本的采样边界越界或重叠');}
 tracks.push({number:255,offset:source.totalSamples,audio:true,preEmphasis:false,isrc:'',indices:[]});return tracks;
}
export function embeddedCueView(binary:FlacCueSource|null,text:FlacCueTextSource|null,file:string,defaultArtist:string,defaultAlbum:string):EmbeddedCueView {
 const base=binary?flacCueEntries(binary,file,defaultArtist):{entries:[],notice:'',timeBaseDen:75};
 const result:EmbeddedCueView={...base,album:defaultAlbum,performer:defaultArtist,fields:[],textState:'none'};
 if(!text)return result;
 try{
  const tracks=textPositions(text);
  if(binary){
   if(binary.streamInfoBase64!==text.streamInfoBase64||binary.tracks.length!==tracks.length)throw new Error('内嵌文本与二进制编排的音频参数或轨数不同');
   for(let i=0;i<tracks.length-1;i++){const actual=binary.tracks[i],declared=tracks[i],explicitFlags=text.document.entries[i].fields?.some(field=>field.command==='FLAGS');if(actual.number!==declared.number||!actual.audio||explicitFlags&&actual.preEmphasis!==declared.preEmphasis||JSON.stringify(actual.indices)!==JSON.stringify(declared.indices)||declared.isrc&&actual.isrc&&declared.isrc.toUpperCase()!==actual.isrc.toUpperCase())throw new Error(`内嵌文本与二进制 TRACK ${declared.number} 的索引或标志不一致`);}
  }else Object.assign(result,flacCueEntries({sampleRate:text.sampleRate,tracks},file,defaultArtist));
  if(!result.entries.length)throw new Error(result.notice||'此内嵌编排尚不可分轨');
  const doc=text.document;result.album=doc.title||defaultAlbum;result.performer=doc.performer||defaultArtist;result.fields=doc.fields??[];result.textState=binary?'matched':'text-only';
  const duration=(frame:number|undefined)=>{if(frame===undefined)return undefined;const value=result.timeBaseDen===75?frame:Number(BigInt(frame)*BigInt(result.timeBaseDen)/75n);if(!Number.isSafeInteger(value)||value<0)throw new Error('内嵌 CUE 声明间隙超过时间预算');return value;};
  result.entries=result.entries.map(entry=>{
   const metadata=entry.hidden?undefined:doc.entries.find(track=>track.number===entry.number);
   if(!metadata)return entry;
   return {...entry,title:metadata.fields?.some(field=>field.command==='TITLE')?metadata.title:entry.title,performer:metadata.performerOrigin==='cue'?metadata.performer:defaultArtist,performerOrigin:metadata.performerOrigin,songwriter:metadata.songwriter||doc.songwriter,isrc:entry.isrc||metadata.isrc,flags:metadata.fields?.some(field=>field.command==='FLAGS')?metadata.flags:entry.flags,pregapFrame:duration(metadata.pregapFrame),postgapFrame:duration(metadata.postgapFrame),fields:metadata.fields??[]};
  });
  if(doc.entries.some(entry=>(entry.pregapFrame??0)>0||(entry.postgapFrame??0)>0))result.notice='内嵌 CUE 的声明间隙已保留；当前播放尚未插入额外静音。';
  return result;
 }catch(error){return {...result,...base,album:defaultAlbum,performer:defaultArtist,fields:[],textState:'rejected',notice:`内嵌 CUE 文本未采用：${String(error instanceof Error?error.message:error).replaceAll('\0','').slice(0,400)}`};}
}
