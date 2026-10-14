import {cueId,cueHash} from './cue-history.js';
import {EMBEDDED_CUE_EXPORT_LIMIT,type EmbeddedCueState} from './embedded-cue-history.js';

export {EMBEDDED_CUE_EXPORT_LIMIT};
export interface EmbeddedCueBinaryMetadata {
 version:1;parserVersion:'aural-flac-cuesheet-1'|'aural-flac-cuesheet-2'|'aural-flac-cuesheet-3'|'aural-flac-cuesheet-4';
 blockOffset:number;sourceHash:string;streamInfoBase64:string;sampleRate:number;totalSamples:number;cd:boolean;catalog:string;leadIn:string;
}
export interface EmbeddedCueTextMetadata {
 version:1;parserVersion:'aural-flac-text-cuesheet-1'|'aural-flac-text-cuesheet-2';
 commentOffset:number;fieldIndex:number;sourceHash:string;streamInfoBase64:string;sampleRate:number;totalSamples:number;notice:string;
}
export interface EmbeddedCueBundleSource {
 version:1;fileId:string;rootId:string;rootPath:string;relativePath:string;fileBytes:number;artist:string;album:string;
 provenance:'scan'|'retained-v68';binary:EmbeddedCueBinaryMetadata|null;text:EmbeddedCueTextMetadata|null;
}
export interface EmbeddedCueSourceBundle {
 format:'aural-embedded-cue-source';version:1;versionId:string;capturedAt:string;source:EmbeddedCueBundleSource;
 binaryRawBase64:string|null;textFieldRawBase64:string|null;
}
export interface EmbeddedCueInterpretation {
 binaryParser:string|null;textParser:string|null;state:EmbeddedCueState;tracks:number;timeBaseDen:number;
 sampleRate:number|null;totalSamples:number|null;notice:string;
}
export interface EmbeddedCueTrackPreview {number:number;hidden:boolean;title:string;performer:string;startSample:number;endSample:number}
export interface EmbeddedCueBundleInspection {
 name:string;archiveSha256:string;versionId:string;capturedAt:string;fileId:string;rootId:string;rootPath:string;relativePath:string;fileBytes:number;
 artist:string;album:string;metadataTruncated:boolean;provenance:'scan'|'retained-v68';binaryHash:string|null;textHash:string|null;binaryBytes:number;textBytes:number;
 saved:EmbeddedCueInterpretation;current:EmbeddedCueInterpretation;interpretationChanged:boolean;
 text:string;textTruncated:boolean;textError:string;binaryText:string;binaryTruncated:boolean;
 tracks:EmbeddedCueTrackPreview[];tracksTruncated:boolean;files:string[];filesTruncated:boolean;
}
const envelopeKeys=['format','version','versionId','capturedAt','source','binaryRawBase64','textFieldRawBase64'];
const sourceKeys=['version','fileId','rootId','rootPath','relativePath','fileBytes','artist','album','provenance','binary','text'];
const binaryKeys=['version','parserVersion','blockOffset','sourceHash','streamInfoBase64','sampleRate','totalSamples','cd','catalog','leadIn'];
const textKeys=['version','parserVersion','commentOffset','fieldIndex','sourceHash','streamInfoBase64','sampleRate','totalSamples','notice'];
function object(value:unknown,keys:string[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('内嵌 CUE 来源备份字段无效');
 return value as Record<string,unknown>;
}
function string(value:unknown,max:number,empty=false):string {
 if(typeof value!=='string'||value.length>max||!empty&&!value)throw new Error('内嵌 CUE 来源备份文字无效');return value;
}
function integer(value:unknown,min:number,max=Number.MAX_SAFE_INTEGER):number {
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new Error('内嵌 CUE 来源备份数值无效');return value;
}
function streamInfo(value:unknown):string {const text=string(value,48);if(text.length!==48)throw new Error('内嵌 CUE 来源备份音频头无效');return text;}
function binaryMetadata(value:unknown):EmbeddedCueBinaryMetadata|null {
 if(value===null)return null;const v=object(value,binaryKeys);
 if(v.version!==1||typeof v.parserVersion!=='string'||!/^aural-flac-cuesheet-[1234]$/.test(v.parserVersion)||typeof v.cd!=='boolean')throw new Error('内嵌 CUE 二进制来源版本无效');
 const leadIn=string(v.leadIn,20);if(!/^(0|[1-9][0-9]*)$/.test(leadIn)||BigInt(leadIn)>0xffffffffffffffffn)throw new Error('内嵌 CUE lead-in 无效');
 return {version:1,parserVersion:v.parserVersion as EmbeddedCueBinaryMetadata['parserVersion'],blockOffset:integer(v.blockOffset,42,32*1024*1024),sourceHash:cueHash(v.sourceHash),streamInfoBase64:streamInfo(v.streamInfoBase64),sampleRate:integer(v.sampleRate,1,655350),totalSamples:integer(v.totalSamples,1,0xfffffffff),cd:v.cd,catalog:string(v.catalog,128,true),leadIn};
}
function textMetadata(value:unknown):EmbeddedCueTextMetadata|null {
 if(value===null)return null;const v=object(value,textKeys);
 if(v.version!==1||typeof v.parserVersion!=='string'||!/^aural-flac-text-cuesheet-[12]$/.test(v.parserVersion))throw new Error('内嵌 CUE 文本来源版本无效');
 return {version:1,parserVersion:v.parserVersion as EmbeddedCueTextMetadata['parserVersion'],commentOffset:integer(v.commentOffset,42,32*1024*1024),fieldIndex:integer(v.fieldIndex,0,32767),sourceHash:cueHash(v.sourceHash),streamInfoBase64:streamInfo(v.streamInfoBase64),sampleRate:integer(v.sampleRate,1,655350),totalSamples:integer(v.totalSamples,1,0xfffffffff),notice:string(v.notice,500,true)};
}
// Shape and bounds only. Library independently reparses both original sources,
// checks hashes and recreates the original full payload to prove versionId.
export function readEmbeddedCueSourceBundle(value:unknown):EmbeddedCueSourceBundle {
 const v=object(value,envelopeKeys),s=object(v.source,sourceKeys);
 if(v.format!=='aural-embedded-cue-source'||v.version!==1||s.version!==1||s.provenance!=='scan'&&s.provenance!=='retained-v68')throw new Error('内嵌 CUE 来源备份格式无效');
 const capturedAt=string(v.capturedAt,24);if(!Number.isFinite(Date.parse(capturedAt))||new Date(capturedAt).toISOString()!==capturedAt)throw new Error('内嵌 CUE 来源备份时间无效');
 const binary=binaryMetadata(s.binary),text=textMetadata(s.text);
 if((binary===null)!==(v.binaryRawBase64===null)||(text===null)!==(v.textFieldRawBase64===null))throw new Error('内嵌 CUE 来源备份原文字节归属无效');
 return {format:'aural-embedded-cue-source',version:1,versionId:cueHash(v.versionId),capturedAt,source:{version:1,fileId:cueId(s.fileId),rootId:cueId(s.rootId),rootPath:string(s.rootPath,32767),relativePath:string(s.relativePath,32767),fileBytes:integer(s.fileBytes,1),artist:string(s.artist,65536,true),album:string(s.album,65536,true),provenance:s.provenance,binary,text},binaryRawBase64:binary?string(v.binaryRawBase64,Math.ceil(256*1024/3)*4):null,textFieldRawBase64:text?string(v.textFieldRawBase64,Math.ceil(512*1024/3)*4):null};
}
