import {randomUUID} from 'node:crypto';
import type {MetadataCandidate,MetadataBatch,MetadataBatchCreateRequest,ReleaseRef,MetadataField} from '../shared/contracts.js';
import type {MetadataReleaseContext} from '../shared/metadata-release-context.js';
import {readMetadataAlbumBatch,readMetadataAlbumPage,readMetadataAlbumTracks,type MetadataAlbumReviewHeader,type MetadataAlbumReviewRow,type MetadataAlbumReviewPage,type MetadataAlbumTrackPage,type MetadataAlbumBatchRequest} from '../shared/metadata-album-review.js';
import {canonicalSearchText} from './search-normalization.js';
import {MetadataAlbumMatcher} from './metadata-album-match.js';
import {readMetadataIdentityPreview,type MetadataIdentityPreviewRequest} from '../shared/metadata-identities.js';
export interface MetadataIdentitySelection {header:MetadataAlbumReviewHeader;context:MetadataReleaseContext;fetchedAt:string;rows:MetadataAlbumLocalSnapshot['rows'];matches:Array<{local:MetadataAlbumLocalSnapshot['rows'][number];track:MetadataReleaseContext['media'][number]['tracks'][number];discNumber:number}>}
export interface MetadataAlbumLocalSnapshot {release:ReleaseRef;title:string;media:Array<{discNumber:number;trackCount:number}>;rows:Array<Omit<MetadataAlbumReviewRow,'suggestions'>&{revision:number;fingerprint:string;referenceFingerprint:string}>}
interface Ports {snapshot(releaseId:string):MetadataAlbumLocalSnapshot;retention():void;receipt(request:MetadataAlbumBatchRequest):MetadataBatch|null;create(request:MetadataBatchCreateRequest,candidates:MetadataCandidate[],identity:MetadataAlbumBatchRequest):MetadataBatch}
type Grant={header:MetadataAlbumReviewHeader;local:MetadataAlbumLocalSnapshot;source:MetadataReleaseContext;candidateToken:string;itemFingerprint:string;requestId:string;fetchedAt:string;matcher:MetadataAlbumMatcher;bytes:number};
export class MetadataAlbumReviewRepository {
 private readonly reviews=new Map<string,Grant>();
 private expiryTimer:NodeJS.Timeout|undefined;
 constructor(private readonly ports:Ports){}
 clear(requestId?:string):void{for(const [token,g] of this.reviews)if(requestId===undefined||g.requestId===requestId)this.reviews.delete(token);this.scheduleExpiry();}
 private scheduleExpiry():void{if(this.expiryTimer)clearTimeout(this.expiryTimer);this.expiryTimer=undefined;if(!this.reviews.size)return;const next=Math.min(...[...this.reviews.values()].map(g=>Date.parse(g.header.expiresAt)));this.expiryTimer=setTimeout(()=>{this.expiryTimer=undefined;this.prune();this.scheduleExpiry();},Math.max(1,next-Date.now()));this.expiryTimer.unref();}
 private prune():void{for(const [token,g] of this.reviews)if(Date.parse(g.header.expiresAt)<=Date.now())this.reviews.delete(token);}
 private tracks(source:MetadataReleaseContext):MetadataAlbumTrackPage['tracks']{return source.media.flatMap(m=>m.tracks.map(t=>({trackId:t.id,recordingId:t.recordingId,discNumber:m.position,position:t.position,printedNumber:t.number,title:t.title,artist:t.credits?.map(a=>a.creditedName+a.joinPhrase).join('')||null,durationSeconds:t.lengthMs===null?null:t.lengthMs/1000})));}
 review(input:{itemId:string;releaseId:string;itemFingerprint:string;candidateToken:string;requestId:string;recordingId:string;context:MetadataReleaseContext;fetchedAt:string;expiresAt:string}):MetadataAlbumReviewHeader|null{
  this.prune();if(!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)<=Date.now()||!input.context.media.some(m=>m.tracks.some(t=>t.recordingId===input.recordingId.toLowerCase())))return null;
  const local=this.ports.snapshot(input.releaseId);if(!local.rows.length||local.rows.length>5000||!local.rows.some(r=>r.itemId===input.itemId))return null;
  const source=structuredClone(input.context),tracks=this.tracks(source),localTracks=new Set(local.rows.map(r=>r.localTrackId)).size,remoteDeclaredTracks=source.media.reduce((n,m)=>n+m.trackCount,0),warnings:string[]=[];
  if(localTracks!==remoteDeclaredTracks)warnings.push('本地与发行版曲目数量不同；可能缺少文件或选中了不同版本');if(local.media.length!==source.media.length)warnings.push('本地与发行版碟数不同');if(source.media.some(m=>!m.trackListComplete))warnings.push('发行曲目表尚未完整载入或含未审核隐藏／数据轨，不能认定完整专辑匹配');
  const header:MetadataAlbumReviewHeader={reviewToken:randomUUID(),itemId:input.itemId,localReleaseId:input.releaseId,title:local.title,sourceReleaseId:source.releaseId,sourceTitle:source.title,sourceUrl:`https://musicbrainz.org/release/${source.releaseId}`,expiresAt:input.expiresAt,localFiles:local.rows.length,localTracks,remoteLoadedTracks:tracks.length,remoteDeclaredTracks,localMedia:local.media,remoteMedia:source.media.map(m=>({discNumber:m.position,trackCount:m.trackCount})),warnings};
  const bytes=Buffer.byteLength(JSON.stringify([header,local,source]));if(bytes>16777216)throw new Error('整专辑审核超过16MiB预览预算，请分组处理');
  while(this.reviews.size>=4||[...this.reviews.values()].reduce((n,g)=>n+g.bytes,0)+bytes>16777216)this.reviews.delete(this.reviews.keys().next().value!);
  this.reviews.set(header.reviewToken,{header:structuredClone(header),local:structuredClone(local),source,candidateToken:input.candidateToken,itemFingerprint:input.itemFingerprint,requestId:input.requestId,fetchedAt:input.fetchedAt,matcher:new MetadataAlbumMatcher(tracks),bytes});this.scheduleExpiry();return header;
 }
 private checked(token:string):Grant{this.prune();const g=this.reviews.get(token);if(!g)throw new Error('整专辑审核已过期或取消，请重新读取');return g;}
 identitySelection(raw:MetadataIdentityPreviewRequest,authorize:(itemId:string,token:string,fingerprint:string)=>boolean):MetadataIdentitySelection {
  const request=readMetadataIdentityPreview(raw),g=this.checked(request.reviewToken);if(!authorize(g.header.itemId,g.candidateToken,g.itemFingerprint))throw new Error('原曲目或候选已变化，请重新读取身份审核');
  const current=this.ports.snapshot(g.header.localReleaseId);if(current.release.revision!==g.local.release.revision||current.release.fingerprint!==g.local.release.fingerprint||JSON.stringify(current.rows.map(r=>[r.itemId,r.fingerprint,r.referenceFingerprint]))!==JSON.stringify(g.local.rows.map(r=>[r.itemId,r.fingerprint,r.referenceFingerprint])))throw new Error('专辑、成员、字段或录音引用已变化，请重新审核');
  const locals=new Map(g.local.rows.map(r=>[r.itemId,r])),tracks=new Map(g.source.media.flatMap(m=>m.tracks.map(t=>[t.id,{t,disc:m.position}] as const))),localMap=new Map<string,string>(),remoteMap=new Map<string,string>();
  const matches=request.mappings.map(m=>{const local=locals.get(m.itemId),remote=tracks.get(m.trackId);if(!local||!remote?.t.recordingId)throw new Error('身份对应不属于已验证的发行曲目');if(localMap.has(local.localTrackId)&&localMap.get(local.localTrackId)!==m.trackId)throw new Error('同一本地发行曲目的版本对应不同在线曲目');if(remoteMap.has(m.trackId)&&remoteMap.get(m.trackId)!==local.localTrackId)throw new Error('不同本地发行曲目重复占用同一在线曲目');localMap.set(local.localTrackId,m.trackId);remoteMap.set(m.trackId,local.localTrackId);return {local,track:remote.t,discNumber:remote.disc};});
  return structuredClone({header:g.header,context:g.source,fetchedAt:g.fetchedAt,rows:g.local.rows,matches});
 }
 page(value:unknown):MetadataAlbumReviewPage{const request=readMetadataAlbumPage(value),g=this.checked(request.reviewToken),offset=request.offset??0;if(offset>g.local.rows.length)throw new Error('整专辑分页位置超出范围');return {header:structuredClone(g.header),offset,total:g.local.rows.length,rows:g.local.rows.slice(offset,offset+25).map(({revision,fingerprint,referenceFingerprint,...row})=>({...structuredClone(row),suggestions:g.matcher.suggestions(row)})),nextOffset:offset+25<g.local.rows.length?offset+25:null};}
 trackPage(value:unknown):MetadataAlbumTrackPage{const request=readMetadataAlbumTracks(value),g=this.checked(request.reviewToken),query=canonicalSearchText(request.query??''),tracks=this.tracks(g.source).filter(t=>!query||canonicalSearchText([t.title,t.artist,t.discNumber,t.position,t.printedNumber].join(' ')).includes(query)),offset=request.offset??0;if(offset>tracks.length)throw new Error('发行曲目分页位置超出范围');return {reviewToken:request.reviewToken,offset,total:tracks.length,tracks:tracks.slice(offset,offset+50),nextOffset:offset+50<tracks.length?offset+50:null};}
 receipt(value:unknown):MetadataBatch|null{return this.ports.receipt(readMetadataAlbumBatch(value));}
 create(value:unknown,authorize:(itemId:string,candidateToken:string,fingerprint:string)=>boolean):MetadataBatch{
  const request=readMetadataAlbumBatch(value),prior=this.ports.receipt(request);if(prior)return prior;
  const g=this.checked(request.reviewToken);this.ports.retention();if(!authorize(g.header.itemId,g.candidateToken,g.itemFingerprint))throw new Error('原曲目或候选已变化，请重新读取整专辑');
  const current=this.ports.snapshot(g.header.localReleaseId);if(current.release.revision!==g.local.release.revision||current.release.fingerprint!==g.local.release.fingerprint||JSON.stringify(current.rows.map(r=>[r.itemId,r.fingerprint,r.referenceFingerprint]))!==JSON.stringify(g.local.rows.map(r=>[r.itemId,r.fingerprint,r.referenceFingerprint])))throw new Error('专辑资料、成员、来源或锁已变化，请重新审核');
  const sourceTracks=new Map(g.source.media.flatMap(m=>m.tracks.map(t=>[t.id,{t,m}] as const))),locals=new Map(g.local.rows.map(r=>[r.itemId,r])),selectedLocal=new Map<string,string>(),selectedRemote=new Map<string,string>(),candidates:MetadataCandidate[]=[],entries:MetadataBatchCreateRequest['entries']=[];
  for(const entry of request.entries){
   const local=locals.get(entry.itemId),remote=sourceTracks.get(entry.trackId);if(!local||!remote?.t.recordingId)throw new Error('所选本地条目或发行曲目不属于本次审核');
   const {t,m}=remote;if((local.knownRecordingIds??(local.knownRecordingId?[local.knownRecordingId]:[])).length&&!(local.knownRecordingIds??[local.knownRecordingId!]).includes(t.recordingId!))throw new Error('发行曲目与本地已有录音引用冲突，请先处理引用');
   if(selectedLocal.has(local.localTrackId)&&selectedLocal.get(local.localTrackId)!==t.id)throw new Error('同一发行曲目的本地版本不能对应不同在线曲目');if(selectedRemote.has(t.id)&&selectedRemote.get(t.id)!==local.localTrackId)throw new Error('不同本地发行曲目不能重复占用同一在线曲目');selectedLocal.set(local.localTrackId,t.id);selectedRemote.set(t.id,local.localTrackId);
   const artist=t.credits?.map(a=>a.creditedName+a.joinPhrase).join('')||'',sourceUrl=g.header.sourceUrl;
   const candidate:MetadataCandidate={token:'',provider:'musicbrainz',recordingId:t.recordingId!,releaseId:g.source.releaseId,title:t.title,artist,album:g.source.title,date:g.source.date,score:0,sourceUrl:`https://musicbrainz.org/recording/${t.recordingId}`,fetchedAt:g.fetchedAt,expiresAt:g.header.expiresAt,fieldSourceUrls:{title:sourceUrl,artist:sourceUrl,album:sourceUrl},albumContext:{releaseId:g.source.releaseId,trackId:t.id,recordingId:t.recordingId!,discNumber:m.position,position:t.position,printedNumber:t.number,sourceUrl,localRecordingId:local.localRecordingId,localRecordingReferenceFingerprint:local.referenceFingerprint}};
   for(const field of entry.fields){if(local.lockedFields.includes(field)||field==='artist'&&local.creditConfirmed)throw new Error('所选字段已锁定或使用已确认署名');const v=candidate[field];if(typeof v!=='string'||!v.trim()||v.trim()===local[field])throw new Error('所选字段缺少曲目来源或没有值差异');}
   entries.push({itemId:local.itemId,revision:local.revision,token:'',fingerprint:local.fingerprint,fields:entry.fields});candidates.push(candidate);
  }
  return this.ports.create({commandId:request.commandId,title:request.title,entries},candidates,request);
 }
}
