import {cueId,cueHash,readCueEncoding,readCueGapPolicy,type CueEncoding,type CueGapPolicy} from './cue-history.js';
export const CUE_SOURCE_RAW_LIMIT=2*1024*1024;
export const CUE_SOURCE_EXPORT_LIMIT=8*1024*1024;
export type CueSourceExportKind='raw'|'bundle';
export interface CueSourceExportRequest {fileId:string;versionId:string;kind:CueSourceExportKind}
export interface CueSourceExportData extends CueSourceExportRequest {rawBase64:string;sha256:string;bytes:number}
export interface CueSourceExportResult {name:string;sha256:string;bytes:number}
export interface CueSourceBundle {
 format:'aural-cue-source';version:1;fileId:string;versionId:string;versionDerivation:'v42'|'v43';
 rootId:string;rootPath:string;relativePath:string;createdAt:string;
 sourceHash:string;rawBytes:number;rawBase64:string;encoding:Exclude<CueEncoding,'auto'>;requestedEncoding:CueEncoding;
 gapPolicy:CueGapPolicy;parserVersion:string;parseError:string;parsedJson:string;parsedSha256:string;
}
export interface CueBundleInspection {
 name:string;archiveSha256:string;fileId:string;versionId:string;rootPath:string;relativePath:string;createdAt:string;
 sourceHash:string;rawBytes:number;encoding:Exclude<CueEncoding,'auto'>;requestedEncoding:CueEncoding;gapPolicy:CueGapPolicy;
 snapshotParser:string;snapshotTracks:number;snapshotNotice:string;currentParser:string;currentTracks:number|null;currentEncoding:Exclude<CueEncoding,'auto'>|null;currentParsed:boolean;
 currentNotice:string;currentInvalid:boolean;text:string;textTruncated:boolean;textError:string;files:string[];filesTruncated:boolean;
}
const keys=['format','version','fileId','versionId','versionDerivation','rootId','rootPath','relativePath','createdAt','sourceHash','rawBytes','rawBase64','encoding','requestedEncoding','gapPolicy','parserVersion','parseError','parsedJson','parsedSha256'] as const;
function text(v:unknown,max:number,empty=false):string {if(typeof v!=='string'||v.length>max||(!empty&&!v)||v.includes('\0'))throw new Error('CUE 来源备份文字无效');return v;}
export function readCueSourceExportRequest(value:unknown):CueSourceExportRequest {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||['fileId','versionId','kind'].some(k=>!Object.hasOwn(value,k)))throw new Error('CUE 原文导出请求无效');
 const v=value as CueSourceExportRequest;if(v.kind!=='raw'&&v.kind!=='bundle')throw new Error('CUE 原文导出类型无效');return {fileId:cueId(v.fileId),versionId:cueHash(v.versionId),kind:v.kind};
}
// Shape and text bounds only. Library independently checks all byte hashes and
// the historical version derivation before returning a bounded preview.
export function readCueSourceBundle(value:unknown):CueSourceBundle {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('CUE 来源备份字段无效');
 const v=value as CueSourceBundle;
 if(v.format!=='aural-cue-source'||v.version!==1||!['v42','v43'].includes(v.versionDerivation)||!Number.isSafeInteger(v.rawBytes)||v.rawBytes<0||v.rawBytes>CUE_SOURCE_RAW_LIMIT||typeof v.rawBase64!=='string'||v.rawBase64.length>Math.ceil(CUE_SOURCE_RAW_LIMIT/3)*4||typeof v.parsedJson!=='string'||v.parsedJson.length>CUE_SOURCE_RAW_LIMIT||!/^aural-cue-[1234]$/.test(v.parserVersion))throw new Error('CUE 来源备份版本或预算无效');
 const encoding=readCueEncoding(v.encoding);if(encoding==='auto')throw new Error('CUE 来源备份必须保留实际编码');
 const createdAt=text(v.createdAt,24);if(!Number.isFinite(Date.parse(createdAt))||new Date(createdAt).toISOString()!==createdAt)throw new Error('CUE 来源备份时间无效');
 const gapPolicy=readCueGapPolicy(v.gapPolicy);if(v.versionDerivation==='v42'&&gapPolicy!=='previous')throw new Error('旧 CUE 版本的间隙解释无效');
 return {format:'aural-cue-source',version:1,fileId:cueId(v.fileId),versionId:cueHash(v.versionId),versionDerivation:v.versionDerivation,rootId:cueId(v.rootId),rootPath:text(v.rootPath,32767),relativePath:text(v.relativePath,32767),createdAt,sourceHash:cueHash(v.sourceHash),rawBytes:v.rawBytes,rawBase64:v.rawBase64,encoding,requestedEncoding:readCueEncoding(v.requestedEncoding),gapPolicy,parserVersion:v.parserVersion,parseError:text(v.parseError,500,true),parsedJson:v.parsedJson,parsedSha256:cueHash(v.parsedSha256)};
}
