import {cueId,cueHash,cueLatest,readCueEncoding,readCueGapPolicy,type CueEncoding,type CueGapPolicy,type CueSourceSummary} from './cue-history.js';
export interface CueSourceSelectionRequest {commandId:string;fileId:string;baseRevision:number;latestVersion:string|null;selectedVersion:string|null;encoding:CueEncoding;gapPolicy:CueGapPolicy;reviewSha256:string}
export interface CueSourceSelectionResult {status:'saved'|'rejected';source:CueSourceSummary|null;error:string}
export interface CueSourceApplication {fileId:string;selectedVersion:string|null;interpretedVersion:string;selectionCommand:string|null;sourcePresence?:'present'|'absent'}
export function readCueSourceSelectionRequest(value:unknown):CueSourceSelectionRequest {
 const keys=['commandId','fileId','baseRevision','latestVersion','selectedVersion','encoding','gapPolicy','reviewSha256'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('CUE 原文选择请求无效');const r=value as CueSourceSelectionRequest;
 if(!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0||r.baseRevision>=Number.MAX_SAFE_INTEGER-1)throw new Error('CUE 原文选择基础修订无效');
 return {commandId:cueId(r.commandId),fileId:cueId(r.fileId),baseRevision:r.baseRevision,latestVersion:cueLatest(r.latestVersion),selectedVersion:r.selectedVersion===null?null:cueHash(r.selectedVersion),encoding:readCueEncoding(r.encoding),gapPolicy:readCueGapPolicy(r.gapPolicy),reviewSha256:cueHash(r.reviewSha256)};
}
