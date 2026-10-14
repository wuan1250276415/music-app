import {cueId,cueHash,cueLatest,readCueEncoding,readCueGapPolicy,type CueEncoding,type CueGapPolicy} from './cue-history.js';
export const CUE_REVIEW_PAGE=128;
export interface CueVersionReviewRequest {fileId:string;versionId:string;baseRevision:number;latestVersion:string|null;encoding:CueEncoding;gapPolicy:CueGapPolicy;offset:number;expectedMappingSha256?:string}
export type CueReferenceState='catalog-online'|'outside-root'|'missing-record'|'offline'|'ignored'|'removed'|'restore-pending'|'writeback-held'|'parse-error'|'unobserved';
export interface CueReviewReference {reference:string;relativePath:string|null;fileId:string|null;state:CueReferenceState;durationSeconds:number|null;observation:string|null;policyRevision:number|null;omitted:boolean}
export interface CueReviewTrack {number:number;hidden:boolean;title:string;performer:string;reference:CueReviewReference;startFrame:number;index01Frame:number;endFrame:number|null;rangeState:'catalog-bounded'|'unbounded'|'outside-duration'|'unavailable';omitted:boolean}
export interface CueVersionReview {
 request:CueVersionReviewRequest;mappingSha256:string;rootId:string;rootPath:string|null;rootStatus:string;rootAuthorized:boolean;rootPermissionSha256:string|null;sourcePath:string;
 savedRootPath:string;savedSourcePath:string;createdAt:string;sourceHash:string;rawBytes:number;savedParser:string;currentParser:string;savedTracks:number;
 sourcePending:boolean;currentEncoding:Exclude<CueEncoding,'auto'>;album:string;performer:string;metadataOmitted:boolean;parseError:string;invalid:boolean;warnings:string[];warningsOmitted:boolean;
 totalTracks:number;visibleTracks:number;hiddenTracks:number;referenceCount:number;catalogOnlineReferences:number;boundedTracks:number;unavailableTracks:number;
 tracks:CueReviewTrack[];offset:number;nextOffset:number|null;
}
export function readCueVersionReviewRequest(value:unknown):CueVersionReviewRequest {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('CUE 历史复审请求无效');const r=value as CueVersionReviewRequest;
 const expected=Object.hasOwn(r,'expectedMappingSha256'),keys=['fileId','versionId','baseRevision','latestVersion','encoding','gapPolicy','offset',...(expected?['expectedMappingSha256']:[])];
 if(Object.keys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k))||!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0||r.baseRevision>=Number.MAX_SAFE_INTEGER-1||!Number.isSafeInteger(r.offset)||r.offset<0||r.offset>1920||r.offset%CUE_REVIEW_PAGE!==0||r.offset>0&&!expected)throw new Error('CUE 历史复审修订或分页无效');
 return {fileId:cueId(r.fileId),versionId:cueHash(r.versionId),baseRevision:r.baseRevision,latestVersion:cueLatest(r.latestVersion),encoding:readCueEncoding(r.encoding),gapPolicy:readCueGapPolicy(r.gapPolicy),offset:r.offset,...(expected?{expectedMappingSha256:cueHash(r.expectedMappingSha256)}:{})};
}
