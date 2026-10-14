import {randomUUID} from 'node:crypto';
import type {MetadataCandidate,MetadataProviderCredit} from '../shared/contracts.js';
import {readMetadataAlbumCreditsPreview,readMetadataAlbumCreditsApply,type MetadataAlbumCreditsPreviewRequest,type MetadataAlbumCreditsPreview,type MetadataAlbumCreditTarget,type MetadataAlbumCreditsApplyRequest,type MetadataAlbumCreditsResult} from '../shared/metadata-album-credits.js';
import {MetadataAlbumReviewRepository,type MetadataIdentitySelection} from './metadata-album-review.js';
import {MetadataCollectionRepository,type ReviewedAlbumCreditTarget} from './metadata-collections.js';
import {providerArtistIdentity} from './online-credits.js';
import type {DatabaseSync} from 'node:sqlite';
import {fieldLocked} from './metadata-provenance.js';
type Grant={preview:MetadataAlbumCreditsPreview;request:MetadataAlbumCreditsPreviewRequest;targets:ReviewedAlbumCreditTarget[];bytes:number};
export class MetadataAlbumCreditsRepository {
 private readonly grants=new Map<string,Grant>();private timer:NodeJS.Timeout|undefined;
 constructor(private readonly db:DatabaseSync,private readonly albums:MetadataAlbumReviewRepository,private readonly collections:MetadataCollectionRepository){}
 clear(requestId?:string):void{for(const [key,g] of this.grants)if(requestId===undefined||g.request.requestId===requestId)this.grants.delete(key);this.schedule();}
 private prune():void{for(const [key,g] of this.grants)if(Date.parse(g.preview.expiresAt)<=Date.now())this.grants.delete(key);}
 private schedule():void{if(this.timer)clearTimeout(this.timer);this.timer=undefined;if(!this.grants.size)return;this.timer=setTimeout(()=>{this.prune();this.schedule();},Math.max(1,Math.min(...[...this.grants.values()].map(g=>Date.parse(g.preview.expiresAt)))-Date.now()));this.timer.unref();}
 preview(raw:MetadataAlbumCreditsPreviewRequest,authorize:(itemId:string,token:string,fingerprint:string)=>boolean):MetadataAlbumCreditsPreview {
  const request=readMetadataAlbumCreditsPreview(raw),s=this.albums.identitySelection(request,authorize);this.prune();
  const targets:ReviewedAlbumCreditTarget[]=[],publicTargets:MetadataAlbumCreditTarget[]=[];
  const add=(kind:'playable_item'|'recording'|'release',entityId:string,itemId:string,matches:MetadataIdentitySelection['matches'],credits:MetadataProviderCredit[]|undefined,scope:'track'|'recording'|'release',reason='')=>{
   const field=kind==='release'?'albumArtists':'artists',current=this.collections.get(kind,entityId,field),ref={kind,entityId,field,revision:current.revision,fingerprint:current.fingerprint} as ReviewedAlbumCreditTarget['ref'],key=randomUUID(),members=(credits??[]).map(c=>({...c,...providerArtistIdentity(this.db,c.externalId)})),affectedItems=this.collections.affectedCount(ref),first=matches[0];
   if(!members.length)reason=scope==='recording'?'来源未提供该录音的完整主署名；不会用发行曲目署名代替':'来源未提供该轨目／发行的完整主署名；不会借用其他范围';
   if(current.locked||kind==='playable_item'&&fieldLocked(this.db,kind,itemId,'artist'))reason='署名集合或歌曲展示字段已锁定';if(members.some(m=>m.archived))reason='来源艺人已在本地归档，请先处理身份';if(affectedItems>5000)reason='单个署名范围超过5000条目';
   const sourceUrl=scope==='recording'?`https://musicbrainz.org/recording/${first.track.recordingId}`:s.header.sourceUrl;
   const candidate:MetadataCandidate={token:'',provider:'musicbrainz',recordingId:first.track.recordingId!,releaseId:s.context.releaseId,title:first.track.title,artist:'',album:s.context.title,date:s.context.date,score:0,sourceUrl,fetchedAt:s.fetchedAt,expiresAt:s.header.expiresAt,...(kind==='release'?{releaseCredits:credits,releaseCreditAt:s.fetchedAt}:{recordingCredits:credits,recordingCreditAt:s.fetchedAt})};
   targets.push({key,itemId,ref,candidate,members,trackIds:[...new Set(matches.map(m=>m.track.id))],scope});publicTargets.push({key,ref,title:current.title,sourceTitle:scope==='release'?s.context.title:scope==='recording'?first.track.recordingTitle??first.track.title:first.track.title,sourceUrl,positions:matches.map(m=>`第${m.discNumber}碟／第${m.track.position}轨 ${m.track.number} · ${m.track.title}`),affectedItems,current:current.values,candidates:members,blocked:Boolean(reason),reason});
  };
  const grouped=new Map<string,MetadataIdentitySelection['matches']>();for(const match of s.matches){const rows=grouped.get(match.local.localTrackId)??[];rows.push(match);grouped.set(match.local.localTrackId,rows);}
  for(const [localTrackId,matches] of grouped){const first=matches[0];for(const row of s.rows.filter(r=>r.localTrackId===localTrackId)){const known=row.knownRecordingIds??(row.knownRecordingId?[row.knownRecordingId]:[]),owner=this.db.prepare("SELECT entity_id FROM external_ref WHERE entity_kind='recording' AND provider='musicbrainz' AND external_id=?").get(first.track.recordingId!) as {entity_id:string}|undefined;add('playable_item',row.itemId,row.itemId,matches,first.track.credits,'track',known.length&&!known.includes(first.track.recordingId!)||owner&&owner.entity_id!==row.localRecordingId?'来源录音与本地已确认身份不同，请先处理录音关联':'');}}
  const recordings=new Map<string,MetadataIdentitySelection['matches']>();for(const match of s.matches){const rows=recordings.get(match.local.localRecordingId)??[];rows.push(match);recordings.set(match.local.localRecordingId,rows);}
  for(const [id,matches] of recordings){const first=matches[0],identities=new Set(matches.map(m=>m.track.recordingId)),credits=new Set(matches.map(m=>JSON.stringify(m.track.recordingCredits)));const known=first.local.knownRecordingIds??(first.local.knownRecordingId?[first.local.knownRecordingId]:[]);const owner=this.db.prepare("SELECT entity_id FROM external_ref WHERE entity_kind='recording' AND provider='musicbrainz' AND external_id=?").get(first.track.recordingId!) as {entity_id:string}|undefined;add('recording',id,first.local.itemId,matches,first.track.recordingCredits,'recording',owner&&owner.entity_id!==id?'来源录音已属于其他本地录音，请先处理关联':identities.size>1||credits.size>1?'同一本地录音的来源标识或完整主署名不一致，请核对录音关联':known.length&&!known.includes(first.track.recordingId!)?'所选录音与本地已确认标识不同，请先核对录音身份':'');}
  add('release',s.header.localReleaseId,s.matches[0].local.itemId,s.matches,s.context.artists,'release');
  const preview={previewToken:randomUUID(),expiresAt:s.header.expiresAt,releaseTitle:s.header.title,sourceTitle:s.context.title,warnings:[...s.header.warnings,'来源主署名不声明本地作曲／指挥／乐团角色；请明确选择角色、顺序和连接词。歌曲署名采用发行曲目的主署名，录音署名仅采用录音层数据。'],targets:publicTargets};
  const bytes=Buffer.byteLength(JSON.stringify([preview,targets,request]));if(bytes>16777216)throw new Error('整专辑署名审核超过16MiB预算，请减少映射');while(this.grants.size>=4||[...this.grants.values()].reduce((n,g)=>n+g.bytes,0)+bytes>16777216)this.grants.delete(this.grants.keys().next().value!);
  this.grants.set(preview.previewToken,{preview:structuredClone(preview),request,targets:structuredClone(targets),bytes});this.schedule();return preview;
 }
 receipt(raw:MetadataAlbumCreditsApplyRequest):MetadataAlbumCreditsResult|null{return this.collections.albumCreditReceipt(readMetadataAlbumCreditsApply(raw));}
 apply(raw:MetadataAlbumCreditsApplyRequest,authorize:(itemId:string,token:string,fingerprint:string)=>boolean):MetadataAlbumCreditsResult {
  const request=readMetadataAlbumCreditsApply(raw),prior=this.receipt(request);if(prior)return prior;this.prune();const g=this.grants.get(request.previewToken);if(!g)throw new Error('署名审核已过期或取消');
  const targets=request.targets.map(t=>{const target=g.targets.find(x=>x.key===t.key),visible=g.preview.targets.find(x=>x.key===t.key);if(!target||!visible||visible.blocked)throw new Error('所选署名目标不属于可采用的审核范围');return target;});
  return this.collections.albumCredits(request,targets,()=>{if(Date.parse(g.preview.expiresAt)<=Date.now())throw new Error('署名审核已过期');this.albums.identitySelection(g.request,authorize);});
 }
}
