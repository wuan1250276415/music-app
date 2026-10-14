import type {MetadataField} from './contracts';
export interface MetadataAlbumBinding {trackKind?:'audio'|'pregap';releaseId:string;trackId:string;recordingId:string;discNumber:number;position:number;printedNumber:string;sourceUrl:string;localRecordingId:string;localRecordingReferenceFingerprint:string}
export class MetadataReviewConflictError extends Error {constructor(message:string){super(message);this.name='MetadataReviewConflictError';}}
export interface MetadataAlbumRemoteTrack {
 kind?:'audio'|'pregap';trackId:string;recordingId:string|null;discNumber:number;position:number;printedNumber:string;title:string;artist:string|null;durationSeconds:number|null;
}
export interface MetadataAlbumSuggestion extends MetadataAlbumRemoteTrack {score:number;titleMatch:'exact'|'similar'|'different';positionMatch:boolean;durationDifference:number|null;recordingMatch:'exact'|'conflict'|'unknown';warnings:string[]}
export interface MetadataAlbumReviewHeader {
 reviewToken:string;itemId:string;localReleaseId:string;title:string;sourceReleaseId:string;sourceTitle:string;sourceUrl:string;expiresAt:string;
 localFiles:number;localTracks:number;remoteLoadedTracks:number;remoteDeclaredTracks:number;remoteDataTracks?:number;localMedia:Array<{discNumber:number;trackCount:number}>;remoteMedia:Array<{discNumber:number;trackCount:number}>;warnings:string[];
}
export interface MetadataAlbumReviewRow {
 itemId:string;localTrackId:string;localRecordingId:string;title:string;artist:string;album:string;codec:string;discNumber:number|null;trackNumber:number|null;durationSeconds:number|null;versionCount:number;knownRecordingId:string|null;knownRecordingIds?:string[];lockedFields:MetadataField[];creditConfirmed:boolean;suggestions:MetadataAlbumSuggestion[];
}
export interface MetadataAlbumPageRequest {reviewToken:string;offset?:number}
export interface MetadataAlbumReviewPage {header:MetadataAlbumReviewHeader;offset:number;total:number;rows:MetadataAlbumReviewRow[];nextOffset:number|null}
export interface MetadataAlbumTrackRequest extends MetadataAlbumPageRequest {query?:string}
export interface MetadataAlbumTrackPage {reviewToken:string;offset:number;total:number;tracks:MetadataAlbumRemoteTrack[];nextOffset:number|null}
export interface MetadataAlbumBatchRequest {commandId:string;reviewToken:string;title:string;entries:Array<{itemId:string;trackId:string;fields:MetadataField[]}>;confirmedAlbumScope:true}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function object(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error('无效整专辑审核请求');return v as Record<string,unknown>;}
function id(v:unknown):string{if(typeof v!=='string'||!uuid.test(v))throw new Error('无效整专辑审核标识');return v;}
export function readMetadataAlbumPage(value:unknown):MetadataAlbumPageRequest {const v=object(value,['reviewToken','offset']);if(v.offset!==undefined&&(!Number.isSafeInteger(v.offset)||Number(v.offset)<0||Number(v.offset)>5000))throw new Error('无效整专辑分页');return {reviewToken:id(v.reviewToken),...(v.offset===undefined?{}:{offset:Number(v.offset)})};}
export function readMetadataAlbumTracks(value:unknown):MetadataAlbumTrackRequest {const v=object(value,['reviewToken','offset','query']);if(v.query!==undefined&&(typeof v.query!=='string'||v.query.length>120||/[\u0000-\u001f\u007f]/.test(v.query)))throw new Error('无效发行曲目检索');return {...readMetadataAlbumPage({reviewToken:v.reviewToken,...(v.offset===undefined?{}:{offset:v.offset})}),...(v.query===undefined?{}:{query:String(v.query)})};}
export function readMetadataAlbumBatch(value:unknown):MetadataAlbumBatchRequest {
 const v=object(value,['commandId','reviewToken','title','entries','confirmedAlbumScope']);if(typeof v.title!=='string'||!v.title.trim()||v.title.length>160||/[\u0000-\u001f\u007f]/.test(v.title)||!Array.isArray(v.entries)||!v.entries.length||v.entries.length>100||v.confirmedAlbumScope!==true)throw new Error('请确认批次名称、范围和 1–100 个条目');
 const seen=new Set<string>(),entries=v.entries.map(raw=>{const e=object(raw,['itemId','trackId','fields']);if(typeof e.itemId!=='string'||!e.itemId||e.itemId.length>128||/[\u0000-\u001f\u007f]/.test(e.itemId)||seen.has(e.itemId)||!Array.isArray(e.fields)||!e.fields.length||e.fields.length>3||new Set(e.fields).size!==e.fields.length||e.fields.some(f=>!['title','artist','album'].includes(f)))throw new Error('无效或重复的专辑条目／字段');seen.add(e.itemId);return {itemId:e.itemId,trackId:id(e.trackId),fields:[...e.fields].sort() as MetadataField[]};});
 return {commandId:id(v.commandId),reviewToken:id(v.reviewToken),title:v.title.trim(),entries:entries.sort((a,b)=>a.itemId.localeCompare(b.itemId,'en')),confirmedAlbumScope:true};
}
export function readMetadataAlbumBinding(value:unknown,recordingId:string,releaseId:string|null):MetadataAlbumBinding{
 const v=object(value,['trackKind','releaseId','trackId','recordingId','discNumber','position','printedNumber','sourceUrl','localRecordingId','localRecordingReferenceFingerprint']);if(v.releaseId!==releaseId||v.recordingId!==recordingId||!Number.isSafeInteger(v.discNumber)||Number(v.discNumber)<1||Number(v.discNumber)>64||!Number.isSafeInteger(v.position)||Number(v.position)<0||Number(v.position)>1000||v.position===0&&v.trackKind!=='pregap'||v.position!==0&&v.trackKind==='pregap'||v.trackKind!==undefined&&!['audio','pregap'].includes(String(v.trackKind))||typeof v.printedNumber!=='string'||v.printedNumber.length>64||/[\u0000-\u001f\u007f]/.test(v.printedNumber)||v.sourceUrl!==`https://musicbrainz.org/release/${releaseId}`||typeof v.localRecordingId!=='string'||!v.localRecordingId||v.localRecordingId.length>128||typeof v.localRecordingReferenceFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(v.localRecordingReferenceFingerprint))throw new Error('无效审核发行曲目来源');
 return {...(v.trackKind===undefined?{}:{trackKind:v.trackKind as 'audio'|'pregap'}),releaseId:id(v.releaseId),trackId:id(v.trackId),recordingId:id(v.recordingId),discNumber:Number(v.discNumber),position:Number(v.position),printedNumber:v.printedNumber,sourceUrl:String(v.sourceUrl),localRecordingId:v.localRecordingId,localRecordingReferenceFingerprint:v.localRecordingReferenceFingerprint};
}
export function readMetadataFieldSources(value:unknown,recordingId:string,releaseId:string|null):Partial<Record<MetadataField,string>>{
 if(value===undefined)return {};const v=object(value,['title','artist','album']),result:Partial<Record<MetadataField,string>>={};for(const [field,url] of Object.entries(v)){if(url!==`https://musicbrainz.org/recording/${recordingId}`&&(releaseId===null||url!==`https://musicbrainz.org/release/${releaseId}`))throw new Error('字段来源不属于所选录音／发行版');result[field as MetadataField]=String(url);}return result;
}
