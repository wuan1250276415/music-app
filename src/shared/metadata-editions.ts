import type {MetadataCandidate} from './contracts';
export interface MetadataEditionsRequest {itemId:string;token:string;fingerprint:string;requestId:string;cursor?:string;fresh?:boolean}
export interface MetadataEditionsPage {itemId:string;token:string;fingerprint:string;requestId:string;recordingId:string;candidates:MetadataCandidate[];offset:number;total:number;nextCursor:string|null;fetchedAt:string;expiresAt:string;cacheHit:boolean}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function readMetadataEditionsRequest(value:unknown):MetadataEditionsRequest{
 const v=value as MetadataEditionsRequest,keys=['itemId','token','fingerprint','requestId','cursor','fresh'];
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||!['itemId','token','fingerprint','requestId'].every(k=>Object.hasOwn(v,k))||typeof v.itemId!=='string'||!v.itemId||v.itemId.length>128||v.itemId.includes('\0')||typeof v.token!=='string'||!uuid.test(v.token)||typeof v.requestId!=='string'||!uuid.test(v.requestId)||typeof v.fingerprint!=='string'||!/^[0-9a-f]{64}$/.test(v.fingerprint)||v.cursor!==undefined&&(typeof v.cursor!=='string'||!uuid.test(v.cursor))||v.fresh!==undefined&&typeof v.fresh!=='boolean')throw new Error('无效录音发行版查询');
 return {itemId:v.itemId,token:v.token,fingerprint:v.fingerprint,requestId:v.requestId,...(v.cursor!==undefined?{cursor:v.cursor}:{}),...(v.fresh!==undefined?{fresh:v.fresh}:{})};
}
