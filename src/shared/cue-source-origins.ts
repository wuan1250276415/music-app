import {cueId,cueHash} from './cue-history.js';
export interface CueSourceOriginsRequest {fileId:string;versionId:string;cursor?:string}
export interface CueSourceOriginRequest {fileId:string;versionId:string;commandId:string}
export interface CueSourceOrigin {commandId:string;archiveSha256:string;createdAt:string;originalVersionId:string;originalFileId:string;originalRootId:string;originalCreatedAt:string;rootPath:string;relativePath:string;sourceHash:string;rawBytes:number;omitted:boolean}
export interface CueSourceOriginsPage {items:CueSourceOrigin[];nextCursor:string|null}
export function readCueSourceOriginsRequest(value:unknown):CueSourceOriginsRequest {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('CUE原备份列表请求无效');const r=value as CueSourceOriginsRequest,hasCursor=Object.hasOwn(r,'cursor'),keys=['fileId','versionId',...(hasCursor?['cursor']:[])];
 if(Object.keys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k))||hasCursor&&(typeof r.cursor!=='string'||!r.cursor||r.cursor.length>1024))throw new Error('CUE原备份分页无效');
 return {fileId:cueId(r.fileId),versionId:cueHash(r.versionId),...(hasCursor?{cursor:r.cursor}:{})};
}
export function readCueSourceOriginRequest(value:unknown):CueSourceOriginRequest {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||['fileId','versionId','commandId'].some(k=>!Object.hasOwn(value,k)))throw new Error('CUE原备份选择请求无效');const r=value as CueSourceOriginRequest;
 return {fileId:cueId(r.fileId),versionId:cueHash(r.versionId),commandId:cueId(r.commandId)};
}
