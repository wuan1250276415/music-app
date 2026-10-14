import {randomUUID} from 'node:crypto';
import {readMetadataIdentityPreview,readMetadataIdentityApply,type MetadataIdentityPreviewRequest,type MetadataIdentityApplyRequest,type MetadataIdentityPreview,type MetadataIdentityResult,type MetadataIdentityTarget} from '../shared/metadata-identities.js';
import {MetadataAlbumReviewRepository} from './metadata-album-review.js';
import {EntityReferenceRepository,type ReviewedIdentityTarget,type IdentityAcceptanceSource,type IdentityTrackContext} from './entity-references.js';
type Grant={preview:MetadataIdentityPreview;request:MetadataIdentityPreviewRequest;targets:ReviewedIdentityTarget[];source:IdentityAcceptanceSource;bytes:number};
export class MetadataIdentityRepository {
 private readonly grants=new Map<string,Grant>();private expiryTimer:NodeJS.Timeout|undefined;
 constructor(private readonly albums:MetadataAlbumReviewRepository,private readonly references:EntityReferenceRepository){}
 clear(requestId?:string):void{for(const [token,g] of this.grants)if(requestId===undefined||g.request.requestId===requestId)this.grants.delete(token);this.schedule();}
 private prune():void{for(const [token,g] of this.grants)if(Date.parse(g.preview.expiresAt)<=Date.now())this.grants.delete(token);}
 private schedule():void{if(this.expiryTimer)clearTimeout(this.expiryTimer);this.expiryTimer=undefined;if(!this.grants.size)return;this.expiryTimer=setTimeout(()=>{this.prune();this.schedule();},Math.max(1,Math.min(...[...this.grants.values()].map(g=>Date.parse(g.preview.expiresAt)))-Date.now()));this.expiryTimer.unref();}
 preview(raw:MetadataIdentityPreviewRequest,authorize:(itemId:string,token:string,fingerprint:string)=>boolean):MetadataIdentityPreview {
  const request=readMetadataIdentityPreview(raw),selection=this.albums.identitySelection(request,authorize);this.prune();
  const targets:ReviewedIdentityTarget[]=[],publicTargets:MetadataIdentityTarget[]=[],groups=new Map<string,typeof selection.matches>();
  for(const match of selection.matches){const rows=groups.get(match.local.localRecordingId)??[];rows.push(match);groups.set(match.local.localRecordingId,rows);}
  const add=(kind:'recording'|'release'|'release_group'|'release_track',entityId:string,sourceId:string,sourceTitle:string,positions:string[],reason='',trackContext?:IdentityTrackContext)=>{
   const entity=this.references.get(kind,entityId),key=randomUUID(),sourceUrl=`https://musicbrainz.org/${kind==='release_group'?'release-group':kind==='release_track'?'track':kind}/${sourceId}`,reference={provider:'musicbrainz',externalId:sourceId,url:sourceUrl};
   const owner=this.references.musicBrainzOwner(kind,sourceId);if(owner&&owner!==entityId)reason='此外部标识已属于其他本地实体，请先处理原关联';
   if(entity.itemCount>5000||entity.releaseCount>5000)reason='单个身份影响范围超过5000条目／发行版';
   const musicbrainz=entity.references.filter(r=>r.provider==='musicbrainz'),status:MetadataIdentityTarget['status']=reason?'conflict':musicbrainz.length===1&&musicbrainz[0].externalId===sourceId&&musicbrainz[0].url===sourceUrl?'already':'ready';
   targets.push({key,entity,reference,positions,...(trackContext?{trackContext}:{})});publicTargets.push({key,kind,entityId,title:entity.title,sourceTitle,sourceId,sourceUrl,affectedItems:entity.itemCount,affectedReleases:entity.releaseCount,current:entity.references,status,reason,positions});
  };
  for(const [entityId,matches] of groups){const ids=new Set(matches.map(m=>m.track.recordingId!)),first=matches[0];add('recording',entityId,first.track.recordingId!,first.track.recordingTitle??first.track.title,matches.map(m=>`第${m.discNumber}碟／第${m.track.position}轨 ${m.track.title}`),ids.size>1?'同一本地录音对应多个不同在线录音，请先核对本地关联':'');}
  const covered=new Set(selection.matches.map(m=>m.local.localTrackId)),all=new Set(selection.rows.map(r=>r.localTrackId));let releaseReason='';
  if(covered.size!==all.size)releaseReason=`尚有${all.size-covered.size}个本地发行曲目未确认对应；录音身份可单独确认`;
  if(selection.context.media.some(m=>!m.trackListComplete))releaseReason='发行曲目表不完整，发行身份暂不能确认';
  add('release',selection.header.localReleaseId,selection.context.releaseId,selection.context.title,selection.matches.map(m=>`第${m.discNumber}碟／第${m.track.position}轨 ${m.track.title}`),releaseReason);
  if(request.includeReleaseTracks){
   const tracks=new Map<string,typeof selection.matches>();
   for(const match of selection.matches){const rows=tracks.get(match.local.localTrackId)??[];rows.push(match);tracks.set(match.local.localTrackId,rows);}
   for(const [entityId,matches] of tracks){
    const first=matches[0],ids=new Set(matches.map(m=>m.track.id));
    add('release_track',entityId,first.track.id,first.track.title,[
     `来源：第${first.discNumber}碟／第${first.track.position}轨，印刷编号 ${first.track.number}`,
     ...matches.map(m=>`本地：第${m.local.discNumber??'?'}碟／第${m.local.trackNumber??'?'}轨 ${m.local.title}`),
    ],ids.size>1?'同一本地发行曲目对应多个在线轨目，请先核对本地关联':'',{
     ...(first.track.kind==='pregap'?{trackKind:'pregap' as const}:{}),releaseId:selection.context.releaseId,recordingId:first.track.recordingId!,discNumber:first.discNumber,position:first.track.position,printedNumber:first.track.number,groupId:selection.context.group?.id??null,
    });
   }
  }
  const warnings=[...selection.header.warnings];
  if(selection.context.group){
   const localGroup=this.references.releaseGroupScope(selection.header.localReleaseId);
   if(localGroup)add('release_group',localGroup.entity.entityId,selection.context.group.id,selection.context.group.title,localGroup.positions,releaseReason?'当前发行对应尚未完成，先核对发行曲目再确认专辑概念':'');
   else warnings.push('来源包含专辑概念，但当前发行尚未关联本地专辑概念；可先审核专辑概念关联，建立或采用对应概念，再重新读取音乐身份审核。');
  }else warnings.push('来源没有提供专辑概念标识，本次只能确认录音和发行版。');
  const owners=new Map<string,string[]>();for(const target of publicTargets){const key=`${target.kind}:${target.sourceId}`;owners.set(key,[...(owners.get(key)??[]),target.entityId]);}
  for(const target of publicTargets)if(new Set(owners.get(`${target.kind}:${target.sourceId}`)).size>1){target.status='conflict';target.reason='同一外部标识对应多个本地身份，请先通过本地录音关联处理';}
  for(const target of publicTargets.filter(t=>t.kind==='release_track')){
   const local=selection.matches.find(m=>m.local.localTrackId===target.entityId)!.local;
   const recording=publicTargets.find(t=>t.kind==='recording'&&t.entityId===local.localRecordingId);
   const releaseOwner=this.references.musicBrainzOwner('release',selection.context.releaseId);
   if(recording?.status==='conflict'){target.status='conflict';target.reason='关联的录音身份存在冲突，请先处理录音关联，再确认发行曲目';}
   if(releaseOwner&&releaseOwner!==selection.header.localReleaseId){target.status='conflict';target.reason='来源发行标识已属于其他本地发行版，请先处理发行归属';}
  }
  const preview:MetadataIdentityPreview={previewToken:randomUUID(),expiresAt:selection.header.expiresAt,releaseTitle:selection.header.title,sourceTitle:selection.context.title,sourceUrl:selection.header.sourceUrl,warnings,targets:publicTargets};
  const source:IdentityAcceptanceSource={provider:'musicbrainz',rightsId:'musicbrainz-core-cc0-2026-09-30',releaseId:selection.context.releaseId,sourceUrl:selection.header.sourceUrl,fetchedAt:selection.fetchedAt};
  const bytes=Buffer.byteLength(JSON.stringify([preview,targets,request]));if(bytes>16777216)throw new Error('身份审核超过16MiB快照预算，请分批处理');while(this.grants.size>=4||[...this.grants.values()].reduce((n,g)=>n+g.bytes,0)+bytes>16777216)this.grants.delete(this.grants.keys().next().value!);
  this.grants.set(preview.previewToken,{preview:structuredClone(preview),request,targets:structuredClone(targets),source,bytes});this.schedule();return preview;
 }
 receipt(raw:MetadataIdentityApplyRequest):MetadataIdentityResult|null{return this.references.identityReceipt(readMetadataIdentityApply(raw));}
 apply(raw:MetadataIdentityApplyRequest,authorize:(itemId:string,token:string,fingerprint:string)=>boolean):MetadataIdentityResult {
  const request=readMetadataIdentityApply(raw),receipt=this.references.identityReceipt(request);if(receipt)return receipt;this.prune();const g=this.grants.get(request.previewToken);if(!g)throw new Error('身份审核已过期或取消，请重新读取');
  const targets=request.targets.map(t=>{const visible=g.preview.targets.find(v=>v.key===t.key),privateTarget=g.targets.find(v=>v.key===t.key);if(!visible||!privateTarget||visible.status!=='ready')throw new Error('所选身份不属于可确认的审核目标');return privateTarget;});
  return this.references.applyIdentities(request,targets,g.source,()=>{if(Date.parse(g.preview.expiresAt)<=Date.now())throw new Error('身份审核已过期');this.albums.identitySelection(g.request,authorize);});
 }
}
