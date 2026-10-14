import {cueId,cueHash,cueLatest,type CueSourceSummary} from './cue-history.js';
export interface CueSourceImportRequest {commandId:string;fileId:string;baseRevision:number;latestVersion:string|null;archiveSha256:string}
export interface CueSourceImportResult {status:'saved'|'rejected';source:CueSourceSummary|null;versionId:string|null;error:string}
export function readCueSourceImportRequest(value:unknown):CueSourceImportRequest {
 const keys=['commandId','fileId','baseRevision','latestVersion','archiveSha256'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('CUE来源备份导入请求无效');const r=value as CueSourceImportRequest;
 if(!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0||r.baseRevision>=Number.MAX_SAFE_INTEGER-1)throw new Error('CUE来源备份导入修订无效');
 return {commandId:cueId(r.commandId),fileId:cueId(r.fileId),baseRevision:r.baseRevision,latestVersion:cueLatest(r.latestVersion),archiveSha256:cueHash(r.archiveSha256)};
}
