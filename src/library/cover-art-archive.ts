import {type ProviderTransport,type ProviderPolicy} from './provider-broker.js';
import {RELEASE} from '../shared/release.js';
import {createHash} from 'node:crypto';
import {imageMime} from './artwork.js';
import type {CoverArtSourceEntry,CoverArtSourceIndex,CoverArtSourceRequest,MetadataCandidate} from '../shared/contracts.js';

const mbid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const gallery=(id:string)=>`https://musicbrainz.org/release/${id}/cover-art`;
function archiveIndex(url:URL,id:string):boolean{
 if(url.search||url.hash||url.port||url.username||url.password||url.protocol!=='https:')return false;
 if(url.hostname==='archive.org')return url.pathname===`/download/mbid-${id}/index.json`;
 return /^(?:[a-z0-9-]+\.)+archive\.org$/.test(url.hostname)&&new RegExp(`^/\\d{1,4}/items/mbid-${id}/index\\.json$`).test(url.pathname);
}
function archiveImage(url:URL,id:string,imageId:string):boolean{
 if(url.search||url.hash||url.port||url.username||url.password||url.protocol!=='https:')return false;
 const filename=`mbid-${id}-${imageId}_thumb1200.jpg`;
 if(url.hostname==='archive.org')return url.pathname===`/download/mbid-${id}/${filename}`;
 return /^(?:[a-z0-9-]+\.)+archive\.org$/.test(url.hostname)&&new RegExp(`^/\\d{1,4}/items/mbid-${id}/${filename.replace(/\./g,'\\.')}$`).test(url.pathname);
}
export const coverArtArchivePolicy:ProviderPolicy={
 id:'cover-art-archive',capabilities:{'release-index':{origin:'https://coverartarchive.org',path:/^\/release\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/$/,emptyOnNotFound:true,
  redirects:{maxHops:3,forwardHeaders:['accept','user-agent'],accept:(original,from,to)=>{
   const id=original.pathname.split('/')[2];return mbid.test(id)&&!original.search&&(from.href===original.href||archiveIndex(from,id))&&archiveIndex(to,id);
  }}},'release-image':{origin:'https://coverartarchive.org',path:/^\/release\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[1-9][0-9]{0,19}-1200$/,format:'bytes',maxResponseBytes:16777216,contentTypes:['image/jpeg','image/png','image/webp','image/gif','image/bmp'],
   redirects:{maxHops:3,forwardHeaders:['accept','user-agent'],accept:(original,from,to)=>{
    const [, ,id,image]=original.pathname.split('/'),imageId=image?.replace(/-1200$/,'');return mbid.test(id)&&/^[1-9][0-9]{0,19}$/.test(imageId)&&!original.search&&(from.href===original.href||archiveImage(from,id,imageId))&&archiveImage(to,id,imageId);
   }}}},
 intervalMs:1100,timeoutMs:18000,deadlineMs:45000,maxAttempts:3,maxQueued:16,maxResponseBytes:2000000,cacheMs:60000,reviewMs:600000,
 rights:{display:true,cache:'memory',persist:false,label:'文字索引与主动临时图片预览；逐图片权利未核实',termsUrl:'https://musicbrainz.org/doc/Cover_Art_Archive',verifiedAt:'2026-10-12'}
};
function text(value:unknown,maximum:number):string{
 if(typeof value!=='string'||value.length>maximum||/[\u0000-\u001f\u007f]/.test(value))throw new Error('封面来源条目文字无效');return value;
}
export class CoverArtArchiveProvider {
 constructor(private readonly broker:ProviderTransport){}
 async image(releaseId:string,imageId:string,signal:AbortSignal):Promise<import('./provider-broker.js').ProviderResult<{bytes:Uint8Array;token:string}>>{
  if(!mbid.test(releaseId)||!/^[1-9][0-9]{0,19}$/.test(imageId))throw new Error('封面图片来源身份无效');
  return this.broker.request('cover-art-archive','release-image',new URL(`https://coverartarchive.org/release/${releaseId.toLowerCase()}/${imageId}-1200`),{Accept:'image/jpeg,image/png,image/webp,image/gif,image/bmp','User-Agent':`AuralPrototype/${RELEASE.appVersion}`},value=>{
   if(!(value instanceof Uint8Array)||!value.length||!imageMime(value))throw new Error('封面来源返回了无效图片');
   return {bytes:value,token:createHash('sha256').update(value).digest('hex')};
  },{signal,fresh:true});
 }
 async index(releaseId:string,options:{signal?:AbortSignal;fresh?:boolean}={}):Promise<Omit<CoverArtSourceIndex,'itemId'|'token'|'fingerprint'>>{
  if(!mbid.test(releaseId))throw new Error('发行来源编号无效');const id=releaseId.toLowerCase();
  const envelope=await this.broker.request('cover-art-archive','release-index',new URL(`https://coverartarchive.org/release/${id}/`),
   {Accept:'application/json','User-Agent':`AuralPrototype/${RELEASE.appVersion}`},value=>{
    if(value===null)return {availability:'not-found' as const,entries:[] as CoverArtSourceEntry[]};
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('封面来源索引无效');
    const record=value as {release?:unknown;images?:unknown};
    if(typeof record.release!=='string'||!new RegExp(`^https?://musicbrainz\\.org/release/${id}$`,'i').test(record.release)||!Array.isArray(record.images)||record.images.length>256)throw new Error('封面索引不属于所选发行版或条目过多');
    const seen=new Set<string>(),entries=record.images.map(image=>{
     if(!image||typeof image!=='object'||Array.isArray(image))throw new Error('封面来源条目无效');
     const row=image as {id?:unknown;front?:unknown;back?:unknown;approved?:unknown;types?:unknown;comment?:unknown};
     const imageId=typeof row.id==='string'?row.id:typeof row.id==='number'&&Number.isSafeInteger(row.id)?String(row.id):'';
     if(!/^[1-9][0-9]{0,19}$/.test(imageId)||seen.has(imageId)||typeof row.front!=='boolean'||typeof row.back!=='boolean'||typeof row.approved!=='boolean'||!Array.isArray(row.types)||row.types.length>16)throw new Error('封面来源条目身份或类型无效');
     seen.add(imageId);
     // Network image URLs are deliberately not returned to the renderer.
     return {imageId,front:row.front,back:row.back,editorialApproved:row.approved,types:row.types.map(type=>text(type,80)),comment:text(row.comment??'',1024)};
    });
    return {availability:'found' as const,entries};
   },options);
  return {...envelope.value,provider:'cover-art-archive',releaseId:id,sourceUrl:gallery(id),fetchedAt:envelope.fetchedAt,expiresAt:envelope.expiresAt,cacheHit:envelope.cacheHit,
   indexRights:{display:true,cache:'memory',persist:false},imageRights:{status:'unverified',display:false,cache:false,export:false,preview:'on-request'}};
 }
}

export async function readCandidateCoverArtImage(request:import('../shared/contracts.js').CoverArtImageRequest,provider:CoverArtArchiveProvider,dependencies:Parameters<typeof readCandidateCoverArt>[2]&{
 convert:(bytes:Uint8Array,signal:AbortSignal)=>Promise<import('../shared/contracts.js').ConvertedCoverImage>;
},signal:AbortSignal):Promise<import('../shared/contracts.js').CoverArtImagePreview>{
 validateCoverArtSourceRequest(request);
 if(typeof request.imageId!=='string'||!/^[1-9][0-9]{0,19}$/.test(request.imageId))throw new Error('无效封面图片编号');
 const candidate=dependencies.resolve(request.itemId,request.token),index=await readCandidateCoverArt(request,provider,dependencies,signal);
 if(!index.entries.some(entry=>entry.imageId===request.imageId))throw new Error('图片不属于当前发行版来源条目');
 const check=()=>{signal.throwIfAborted();if(!dependencies.enabled()||dependencies.resolve(request.itemId,request.token)!==candidate||dependencies.fingerprint(request.itemId)!==request.fingerprint||Date.parse(index.expiresAt)<=Date.now())throw new Error('图片预览期间候选或歌曲资料已变化，请重新匹配');};
 check();const source=await provider.image(index.releaseId,request.imageId,signal);check();
 const image=await dependencies.convert(source.value.bytes,signal);check();
 if(image.token!==source.value.token)throw new Error('图片转换来源指纹不符');
 return {...image,itemId:request.itemId,candidateToken:request.token,fingerprint:request.fingerprint,releaseId:index.releaseId,imageId:request.imageId,sourceUrl:index.sourceUrl,fetchedAt:source.fetchedAt,
  expiresAt:new Date(Math.min(Date.parse(index.expiresAt),Date.parse(source.expiresAt))).toISOString(),rights:{status:'unverified',display:true,cache:'session',persist:false,export:false}};
}

export function validateCoverArtSourceRequest(value:unknown):CoverArtSourceRequest{
 const request=value as CoverArtSourceRequest;
 if(!request||typeof request.itemId!=='string'||!request.itemId||request.itemId.length>128||typeof request.token!=='string'||!mbid.test(request.token)||typeof request.requestId!=='string'||!mbid.test(request.requestId)||typeof request.fingerprint!=='string'||!/^[0-9a-f]{64}$/.test(request.fingerprint)||request.fresh!==undefined&&typeof request.fresh!=='boolean')throw new Error('无效封面来源查询');
 return request;
}
export async function readCandidateCoverArt(request:CoverArtSourceRequest,provider:CoverArtArchiveProvider,dependencies:{
 resolve:(itemId:string,token:string)=>MetadataCandidate|null;fingerprint:(itemId:string)=>string;enabled:()=>boolean;
},signal:AbortSignal):Promise<CoverArtSourceIndex>{
 validateCoverArtSourceRequest(request);signal.throwIfAborted();
 if(!dependencies.enabled())throw new Error('请先启用元数据查询和 Cover Art Archive 来源查询');
 const candidate=dependencies.resolve(request.itemId,request.token);
 if(!candidate)throw new Error('候选已过期或取消，请重新匹配');
 if(!candidate.releaseId)throw new Error('此候选没有关联发行版');
 if(dependencies.fingerprint(request.itemId)!==request.fingerprint)throw new Error('歌曲资料已变化，请重新匹配');
 const index=await provider.index(candidate.releaseId,{signal,fresh:request.fresh});signal.throwIfAborted();
 if(!dependencies.enabled()||dependencies.resolve(request.itemId,request.token)!==candidate||dependencies.fingerprint(request.itemId)!==request.fingerprint)throw new Error('查询期间候选或歌曲资料已变化，请重新匹配');
 return {...index,itemId:request.itemId,token:request.token,fingerprint:request.fingerprint,
  expiresAt:new Date(Math.min(Date.parse(index.expiresAt),Date.parse(candidate.expiresAt??index.expiresAt))).toISOString()};
}
