import {readBatchReviewToken} from './metadata-batch-review';
import {normalizeISRC} from './isrc';
export interface MetadataMatchRequest {itemId:string;requestId:string;fresh?:boolean;recordingId?:string;isrc?:string;reviewToken?:string}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function readMetadataMatchRequest(raw:unknown):MetadataMatchRequest {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('无效在线查询');
 const v=raw as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['itemId','requestId','fresh','recordingId','isrc','reviewToken'].includes(k))||typeof v.itemId!=='string'||!v.itemId||v.itemId.length>128||typeof v.requestId!=='string'||!uuid.test(v.requestId)||v.fresh!==undefined&&typeof v.fresh!=='boolean'||v.recordingId!==undefined&&(typeof v.recordingId!=='string'||!uuid.test(v.recordingId)))throw new Error('无效在线查询');
 const isrc=v.isrc===undefined?undefined:normalizeISRC(v.isrc);if(isrc===null||v.isrc!==undefined&&v.recordingId!==undefined)throw new Error('请选择一种有效的录音查询依据');
 return {itemId:v.itemId,requestId:v.requestId,...(v.fresh===undefined?{}:{fresh:v.fresh as boolean}),...(v.recordingId===undefined?{}:{recordingId:(v.recordingId as string).toLowerCase()}),...(isrc===undefined?{}:{isrc}),...(v.reviewToken===undefined?{}:{reviewToken:readBatchReviewToken(v.reviewToken)})};
}
