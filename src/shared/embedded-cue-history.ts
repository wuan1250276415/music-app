import {cueId,cueHash} from './cue-history.js';

export const EMBEDDED_CUE_EXPORT_LIMIT=2*1024*1024;
export type EmbeddedCueState='binary'|'matched'|'text-only'|'rejected'|'absent';
export type EmbeddedCueExportKind='binary-block'|'text-field'|'cue-text'|'bundle';
export interface EmbeddedCueVersion {
 id:string;fileId:string;rootPath:string;relativePath:string;fileBytes:number;createdAt:string;
 binaryHash:string|null;textHash:string|null;binaryBytes:number;textBytes:number;
 binaryParser:string|null;textParser:string|null;sampleRate:number|null;totalSamples:number|null;
 state:EmbeddedCueState;trackCount:number;timeBaseDen:number;notice:string;latest:boolean;applied:boolean;
 provenance:'scan'|'retained-v68';
}
export interface EmbeddedCueSource {fileId:string;rootId:string;rootPath:string;relativePath:string;revision:number;latestVersion:string;observedAt:string;version:EmbeddedCueVersion}
export interface EmbeddedCuePage {items:EmbeddedCueSource[];nextCursor:string|null}
export interface EmbeddedCueVersionPage {items:EmbeddedCueVersion[];nextCursor:string|null}
export interface EmbeddedCuePreview {version:EmbeddedCueVersion;text:string;binaryText:string;textTruncated:boolean;binaryTruncated:boolean;currentState:'same'|'changed'|'unavailable'}
export interface EmbeddedCueRequest {fileId:string;versionId:string}
export interface EmbeddedCueExportRequest extends EmbeddedCueRequest {kind:EmbeddedCueExportKind}
// This private Library-to-Main value is never accepted from Renderer.
export interface EmbeddedCueExportData {versionId:string;kind:EmbeddedCueExportKind;rawBase64:string;sha256:string;bytes:number}
export interface EmbeddedCueExportResult {name:string;sha256:string;bytes:number}
export function readEmbeddedCueRequest(value:unknown):EmbeddedCueRequest {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'fileId')||!Object.hasOwn(value,'versionId'))throw new Error('内嵌 CUE 历史请求无效');
 const v=value as EmbeddedCueRequest;return {fileId:cueId(v.fileId),versionId:cueHash(v.versionId)};
}
export function readEmbeddedCueExportRequest(value:unknown):EmbeddedCueExportRequest {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||!Object.hasOwn(value,'kind'))throw new Error('内嵌 CUE 导出请求无效');
 const v=value as EmbeddedCueExportRequest;
 if(!['binary-block','text-field','cue-text','bundle'].includes(v.kind))throw new Error('内嵌 CUE 导出类型无效');
 return {...readEmbeddedCueRequest({fileId:v.fileId,versionId:v.versionId}),kind:v.kind};
}
