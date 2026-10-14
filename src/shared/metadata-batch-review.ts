import type {MetadataCandidate} from './contracts';
export interface MetadataBatchReviewLease {reviewToken:string;expiresAt:string}
export interface MetadataBatchReviewStatus extends MetadataBatchReviewLease {valid:boolean;rows:Array<{itemId:string;state:'pending'|'ready'|'changed'|'expired';reason:string}>}
export interface MetadataBatchLookup {version:1;sourceFingerprint:string;kind:'text'|'confirmed-recording'|'isrc';recordingId?:string;isrc?:string}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function readBatchReviewToken(raw:unknown):string {if(typeof raw!=='string'||!uuid.test(raw))throw new Error('无效批量预览凭据');return raw;}
export function readBatchReviewItems(raw:unknown):string[] {
 if(!Array.isArray(raw)||!raw.length||raw.length>100||raw.some(id=>typeof id!=='string'||!id||id.length>128)||new Set(raw).size!==raw.length)throw new Error('批量预览需包含1–100个不同的曲目');return [...raw];
}
export function readBatchLookup(raw:unknown):MetadataBatchLookup {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('批次查询来源无效');const v=raw as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['version','sourceFingerprint','kind','recordingId','isrc'].includes(k))||v.version!==1||typeof v.sourceFingerprint!=='string'||!/^[0-9a-f]{64}$/.test(v.sourceFingerprint)||!['text','confirmed-recording','isrc'].includes(String(v.kind)))throw new Error('批次查询来源无效');
 if(v.kind==='confirmed-recording'&&(typeof v.recordingId!=='string'||!uuid.test(v.recordingId))||v.kind!=='confirmed-recording'&&v.recordingId!==undefined||v.kind==='isrc'&&(typeof v.isrc!=='string'||!/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(v.isrc))||v.kind!=='isrc'&&v.isrc!==undefined)throw new Error('批次查询依据与来源不符');return {...v} as unknown as MetadataBatchLookup;
}
export function batchLookup(candidate:MetadataCandidate,sourceFingerprint:string):MetadataBatchLookup {
 const e=candidate.matchEvidence?.retrieval;return readBatchLookup({version:1,sourceFingerprint,kind:e?.kind??'text',...(e?.kind==='confirmed-recording'?{recordingId:e.recordingId}:e?.kind==='isrc'?{isrc:e.isrc}:{})});
}
