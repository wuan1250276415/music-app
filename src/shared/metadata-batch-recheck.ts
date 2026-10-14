import type {LibraryItem,MetadataBatchOutcome,MetadataBatchRow,MetadataCandidate} from './contracts';

export interface MetadataBatchOrigin {batchId:string;revision:number}
export interface MetadataBatchRecheckResult {origin:MetadataBatchOrigin;title:string;items:Array<{item:LibraryItem;previous:MetadataBatchRow}>;unavailable:Array<{itemId:string;title:string;reason:string}>}
export interface MetadataBatchEdition {releaseId:string;title:string|null;date:string|null;country:string|null;status:string|null;disambiguation:string|null;format:string|null;barcode:string|null}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function readMetadataBatchOrigin(raw:unknown):MetadataBatchOrigin {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('无效批次重新审核来源');const v=raw as Record<string,unknown>;
 if(Object.keys(v).length!==2||!Object.hasOwn(v,'batchId')||!Object.hasOwn(v,'revision')||typeof v.batchId!=='string'||!uuid.test(v.batchId)||!Number.isSafeInteger(v.revision)||(v.revision as number)<0)throw new Error('无效批次重新审核来源');
 return {batchId:v.batchId,revision:v.revision as number};
}
export function canRecheckMetadataOutcome(outcome:MetadataBatchOutcome):boolean {return ['pending','conflict','failed','expired','skipped'].includes(outcome);}
export function readMetadataBatchEdition(raw:unknown):MetadataBatchEdition {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('无效已审核发行版记录');const v=raw as Record<string,unknown>,keys=['releaseId','title','date','country','status','disambiguation','format','barcode'];
 if(Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k))||typeof v.releaseId!=='string'||!uuid.test(v.releaseId))throw new Error('无效已审核发行版记录');
 for(const key of keys.slice(1)){const value=v[key],limit=key==='date'||key==='status'?32:key==='country'?16:key==='barcode'?64:240;if(value!==null&&(typeof value!=='string'||value.length>limit||/[\u0000-\u001f\u007f]/.test(value)))throw new Error('无效已审核发行版记录');}
 return {...v} as unknown as MetadataBatchEdition;
}
export function metadataBatchEdition(candidate:MetadataCandidate):MetadataBatchEdition|undefined {
 if(!candidate.releaseId)return undefined;return readMetadataBatchEdition({releaseId:candidate.releaseId,title:candidate.album,date:candidate.date,...{country:null,status:null,disambiguation:null,format:null,barcode:null},...candidate.edition});
}
