import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {EntityReferences,CatalogChangeResult} from '../shared/contracts.js';
import {readMetadataGroupLinkPreview,readMetadataGroupLinkApply,type MetadataGroupLinkPreviewRequest,type MetadataGroupLinkPreview,type MetadataGroupLinkApplyRequest,type MetadataGroupLinkResult,type MetadataGroupLinkUndoPreview} from '../shared/metadata-group-link.js';
import {MetadataAlbumReviewRepository} from './metadata-album-review.js';
import {EntityReferenceRepository} from './entity-references.js';
import {CatalogRepository} from './catalog.js';
import {requireOnlineRetention} from './provider-retention.js';
import {recordOnlineGroupField} from './metadata-provenance.js';
import {bumpGroupMembership} from './group-membership-revision.js';

type Item={itemId:string;revision:number;binding:{recordingId:string;trackId:string}|null;facts:Record<string,unknown>};
type State={release:EntityReferences;previous:EntityReferences|null;target:EntityReferences|null;items:Item[]};
type Grant={preview:MetadataGroupLinkPreview;request:MetadataGroupLinkPreviewRequest;state:State;newGroupId:string;type:string|null;fetchedAt:string;sourceReleaseId:string;bytes:number};
type Snapshot={items:Item[];releases:Array<{releaseId:string;groupId:string|null;revision:number}>;state:State;oldGroupAfter?:EntityReferences;onlineGroup?:{version:1;provider:'musicbrainz';rightsId:string;sourceId:string;sourceUrl:string;sourceReleaseId:string;fetchedAt:string;targetId:string;created:boolean;title:string;undoOf?:string}};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class MetadataGroupLinkRepository {
 private readonly grants=new Map<string,Grant>();private timer:NodeJS.Timeout|undefined;
 constructor(private readonly db:DatabaseSync,private readonly albums:MetadataAlbumReviewRepository,private readonly references:EntityReferenceRepository,private readonly catalog:CatalogRepository,private readonly refreshSearch:(id:string)=>void){}
 clear(requestId?:string):void{for(const [key,g] of this.grants)if(requestId===undefined||g.request.requestId===requestId)this.grants.delete(key);this.schedule();}
 private prune():void{for(const [key,g] of this.grants)if(Date.parse(g.preview.expiresAt)<=Date.now())this.grants.delete(key);}
 private schedule():void{if(this.timer)clearTimeout(this.timer);this.timer=undefined;if(!this.grants.size)return;this.timer=setTimeout(()=>{this.prune();this.schedule();},Math.max(1,Math.min(...[...this.grants.values()].map(g=>Date.parse(g.preview.expiresAt)))-Date.now()));this.timer.unref();}
 private state(releaseId:string,targetId:string|null):State {
  const release=this.references.get('release',releaseId),group=this.references.releaseGroupScope(releaseId);
  const target=targetId?this.references.get('release_group',targetId):null;
  for(const entity of [release,group?.entity,target])if(entity&&(entity.itemCount>5000||entity.releaseCount>5000))throw new Error('专辑概念关联影响范围超过5000条目／发行版');
  const affected=Number(this.db.prepare('SELECT COUNT(DISTINCT p.id) n FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id JOIN release r ON r.id=m.release_id WHERE r.id=? OR r.group_id IN(?,?)').get(releaseId,group?.entity.entityId??null,targetId)!.n);if(affected>5000)throw new Error('专辑概念关联合计影响范围超过5000条目');
  const rows=this.db.prepare(`SELECT p.id FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id WHERE m.release_id=? ORDER BY p.id`).all(releaseId) as Array<{id:string}>;
  const projected=this.catalog.project(rows.map(r=>r.id));
  const items=rows.map(({id})=>{const binding=this.db.prepare('SELECT recording_id,release_track_id FROM item_catalog_binding WHERE item_id=?').get(id) as {recording_id:string;release_track_id:string}|undefined;const facts=this.db.prepare('SELECT COALESCE(o.title,p.title) title,COALESCE(o.artist,p.artist) artist,COALESCE(o.album,p.album) album,r.path rootPath,f.relative_path relativePath FROM playable_item p JOIN media_file f ON f.id=p.file_id JOIN library_root r ON r.id=f.root_id LEFT JOIN metadata_override o ON o.item_id=p.id WHERE p.id=?').get(id)!;return {itemId:id,revision:projected.get(id)!.revision,binding:binding?{recordingId:binding.recording_id,trackId:binding.release_track_id}:null,facts:{...facts}};});
  return {release,previous:group?.entity??null,target,items};
 }
 private editions(groupId:string|null):string[]{if(!groupId)return [];return (this.db.prepare('SELECT title,date,country,edition,local_context FROM release WHERE group_id=? ORDER BY id').all(groupId) as Array<Record<string,unknown>>).map(r=>[r.title,r.date,r.country,r.edition,r.local_context].filter(Boolean).join(' · '));}
 preview(raw:MetadataGroupLinkPreviewRequest,authorize:(itemId:string,token:string,fingerprint:string)=>boolean):MetadataGroupLinkPreview {
  const request=readMetadataGroupLinkPreview(raw),s=this.albums.identitySelection(request,authorize),source=s.context.group;this.prune();
  if(!source)throw new Error('此来源没有专辑概念标识，不能建立在线关联');
  if(new Set(s.matches.map(m=>m.local.localTrackId)).size!==new Set(s.rows.map(r=>r.localTrackId)).size||s.context.media.some(m=>!m.trackListComplete))throw new Error('请先完成全部本地发行曲目对应并审核完整来源曲目表');
  const releaseOwner=this.references.musicBrainzOwner('release',s.context.releaseId);if(releaseOwner&&releaseOwner!==s.header.localReleaseId)throw new Error('来源发行已属于其他本地发行版，请先处理原归属');
  const targetId=this.references.musicBrainzOwner('release_group',source.id),state=this.state(s.header.localReleaseId,targetId),action=targetId&&state.previous?.entityId===targetId?'already':targetId?'attach':'create';
  const preview:MetadataGroupLinkPreview={previewToken:randomUUID(),expiresAt:s.header.expiresAt,action,releaseTitle:s.header.title,sourceTitle:source.title,sourceId:source.id,sourceUrl:`https://musicbrainz.org/release-group/${source.id}`,release:state.release,previous:state.previous,target:state.target,previousEditions:this.editions(state.previous?.entityId??null),targetEditions:this.editions(targetId),warnings:[...s.header.warnings,...(state.previous&&action!=='already'?['当前发行将离开原专辑概念；原概念的其他发行版、引用和资料保留']:[])]};
  const bytes=Buffer.byteLength(JSON.stringify([preview,state,request]));if(bytes>16777216)throw new Error('专辑概念关联审核超过16MiB预算');while(this.grants.size>=4||[...this.grants.values()].reduce((n,g)=>n+g.bytes,0)+bytes>16777216)this.grants.delete(this.grants.keys().next().value!);
  this.grants.set(preview.previewToken,{preview:structuredClone(preview),request:structuredClone(request),state:structuredClone(state),newGroupId:randomUUID(),type:source.primaryType,fetchedAt:s.fetchedAt,sourceReleaseId:s.context.releaseId,bytes});this.schedule();return preview;
 }
 receipt(raw:MetadataGroupLinkApplyRequest):MetadataGroupLinkResult|null {
  const request=readMetadataGroupLinkApply(raw),row=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(request.commandId) as {fingerprint:string;result_json:string}|undefined;
  if(!row)return null;if(row.fingerprint!==hash(['online-group-link',request]))throw new Error('命令ID已用于不同操作');return JSON.parse(row.result_json);
 }
 private snapshot(releaseId:string,targetId:string):Snapshot {
  const state=this.state(releaseId,targetId),r=this.db.prepare('SELECT group_id,revision FROM release WHERE id=?').get(releaseId) as {group_id:string|null;revision:number};
  return {items:state.items,releases:[{releaseId,groupId:r.group_id,revision:r.revision}],state};
 }
 private refresh(releaseId:string):void{for(const {itemId} of this.state(releaseId,null).items){this.catalog.refreshRevision(itemId);this.refreshSearch(itemId);}}
 apply(raw:MetadataGroupLinkApplyRequest,authorize:(itemId:string,token:string,fingerprint:string)=>boolean):MetadataGroupLinkResult {
  const request=readMetadataGroupLinkApply(raw),prior=this.receipt(request);if(prior)return prior;this.prune();const g=this.grants.get(request.previewToken);if(!g||g.preview.action==='already')throw new Error('审核已过期、取消或已经关联');
  if(!request.confirmedReleaseScope||!request.confirmedTargetScope||g.state.previous&&!request.confirmedPreviousScope)throw new Error('请分别确认当前发行、目标概念及原概念的影响范围');
  this.db.exec('BEGIN IMMEDIATE');try{
   const retry=this.receipt(request);if(retry){this.db.exec('COMMIT');return retry;}
   requireOnlineRetention(this.db,'musicbrainz');if(Date.parse(g.preview.expiresAt)<=Date.now())throw new Error('审核已过期');this.albums.identitySelection(g.request,authorize);
   const owner=this.references.musicBrainzOwner('release_group',g.preview.sourceId);if(owner!==(g.state.target?.entityId??null)||hash(this.state(g.state.release.entityId,owner))!==hash(g.state))throw new Error('专辑概念、发行成员或引用已变化，请重新审核');
   const targetId=owner??g.newGroupId,before:Snapshot={items:g.state.items,releases:[{releaseId:g.state.release.entityId,groupId:g.state.previous?.entityId??null,revision:Number(this.db.prepare('SELECT revision FROM release WHERE id=?').get(g.state.release.entityId)!.revision)}],state:g.state};
   if(!owner){this.db.prepare('INSERT INTO release_group(id,title,type) VALUES(?,?,?)').run(targetId,g.preview.sourceTitle,g.type);recordOnlineGroupField(this.db,targetId,'title',g.preview.sourceTitle,g.preview.sourceUrl,g.fetchedAt);recordOnlineGroupField(this.db,targetId,'type',g.type,g.preview.sourceUrl,g.fetchedAt);this.db.prepare("INSERT INTO external_ref VALUES('release_group',?,'musicbrainz',?,?)").run(targetId,g.preview.sourceId,g.preview.sourceUrl);this.db.prepare("INSERT INTO entity_reference_state VALUES('release_group',?,1)").run(targetId);}
   // Pin the reviewed existing graph without cloning or merging any identity.
   // Subsequent tag scans must not silently derive a different release.
   for(const item of g.state.items)if(!item.binding)this.db.prepare('INSERT INTO item_catalog_binding(item_id,recording_id,release_track_id) SELECT id,recording_id,release_track_id FROM playable_item WHERE id=?').run(item.itemId);
   this.db.prepare('UPDATE release SET group_id=?,revision=revision+1 WHERE id=?').run(targetId,g.state.release.entityId);this.refresh(g.state.release.entityId);
   bumpGroupMembership(this.db,[g.state.previous?.entityId??null,targetId]);
   const after=this.snapshot(g.state.release.entityId,targetId);after.onlineGroup={version:1,provider:'musicbrainz',rightsId:'musicbrainz-core-cc0-2026-09-30',sourceId:g.preview.sourceId,sourceUrl:g.preview.sourceUrl,sourceReleaseId:g.sourceReleaseId,fetchedAt:g.fetchedAt,targetId,created:!owner,title:g.preview.sourceTitle};
   if(g.state.previous&&g.state.previous.entityId!==targetId)after.oldGroupAfter=this.references.get('release_group',g.state.previous.entityId);
   const changeId=randomUUID();this.db.prepare("INSERT INTO catalog_change(id,action,before_json,after_json,created_at) VALUES(?,'group',?,?,?)").run(changeId,JSON.stringify(before),JSON.stringify(after),Date.now());const result={changeId,groupId:targetId,items:after.items.map(i=>({itemId:i.itemId,revision:i.revision}))};
   this.db.prepare('INSERT INTO user_command_receipt VALUES(?,?,?,?)').run(request.commandId,hash(['online-group-link',request]),JSON.stringify(result),new Date().toISOString());this.db.exec('COMMIT');return result;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 private change(id:string):{before:Snapshot;after:Snapshot;undone:boolean} {
  if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error('无效概念关联修订');const row=this.db.prepare('SELECT before_json,after_json,undone_at FROM catalog_change WHERE id=? AND action=\'group\'').get(id) as {before_json:string;after_json:string;undone_at:number|null}|undefined;
  if(!row)throw new Error('概念关联修订不存在');const after=JSON.parse(row.after_json) as Snapshot;if(after.onlineGroup?.provider!=='musicbrainz')throw new Error('不属于在线概念关联');return {before:JSON.parse(row.before_json),after,undone:row.undone_at!==null};
 }
 owns(id:string):boolean{return Boolean(this.db.prepare("SELECT 1 FROM catalog_change WHERE id=? AND json_extract(after_json,'$.onlineGroup.provider')='musicbrainz'").get(id));}
 private eligible(before:Snapshot,after:Snapshot):boolean {
  const current=this.state(after.state.release.entityId,after.onlineGroup!.targetId);
  if(hash(current)!==hash(after.state))return false;
  // Old concept is no longer the release's current concept; still fence its complete scope.
  if(before.state.previous&&before.state.previous.entityId!==after.onlineGroup!.targetId){const old=this.references.get('release_group',before.state.previous.entityId),oldAfter=(after as Snapshot&{oldGroupAfter?:EntityReferences}).oldGroupAfter;if(!oldAfter||old.fingerprint!==oldAfter.fingerprint)return false;}
  return true;
 }
 undoPreview(id:string):MetadataGroupLinkUndoPreview {
  const c=this.change(id),status=c.undone?'undone':this.eligible(c.before,c.after)?'ready':'conflict';return {changeId:id,title:c.after.state.release.title,groupTitle:c.after.onlineGroup!.title,affectedItems:c.after.items.length,status,createdGroup:c.after.onlineGroup!.created,reason:status==='conflict'?'发行、概念成员、资料或引用已变化，保留当前关联':status==='undone'?'已撤销该关联':''};
 }
 undo(id:string,commandId:string):CatalogChangeResult {
  const identity=['online-group-link-undo',id],fingerprint=hash(identity);if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(commandId))throw new Error('无效撤销命令ID');this.db.exec('BEGIN IMMEDIATE');try{
   const old=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as {fingerprint:string;result_json:string}|undefined;if(old){if(old.fingerprint!==fingerprint)throw new Error('命令ID已用于不同操作');this.db.exec('COMMIT');return JSON.parse(old.result_json);}
   const c=this.change(id);if(c.undone||!this.eligible(c.before,c.after))throw new Error('关联或概念范围已变化，不能撤销');const releaseId=c.after.state.release.entityId,targetId=c.after.onlineGroup!.targetId;
   this.db.prepare('UPDATE release SET group_id=?,revision=revision+1 WHERE id=?').run(c.before.releases[0].groupId,releaseId);
   for(const item of c.before.items){if(item.binding)this.db.prepare('INSERT INTO item_catalog_binding VALUES(?,?,?) ON CONFLICT(item_id) DO UPDATE SET recording_id=excluded.recording_id,release_track_id=excluded.release_track_id').run(item.itemId,item.binding.recordingId,item.binding.trackId);else this.db.prepare('DELETE FROM item_catalog_binding WHERE item_id=?').run(item.itemId);this.catalog.sync(item.itemId);}
   bumpGroupMembership(this.db,[targetId,c.before.releases[0].groupId]);
   if(c.after.onlineGroup!.created){this.db.prepare("DELETE FROM external_ref WHERE entity_kind='release_group' AND entity_id=? AND provider='musicbrainz' AND external_id=?").run(targetId,c.after.onlineGroup!.sourceId);this.db.prepare("UPDATE entity_reference_state SET revision=revision+1 WHERE entity_kind='release_group' AND entity_id=?").run(targetId);}
   this.refresh(releaseId);this.db.prepare('UPDATE catalog_change SET undone_at=? WHERE id=?').run(Date.now(),id);
   const changeId=randomUUID(),after=this.snapshot(releaseId,targetId);after.onlineGroup={...c.after.onlineGroup!,undoOf:id};this.db.prepare("INSERT INTO catalog_change(id,action,before_json,after_json,created_at) VALUES(?,'undo',?,?,?)").run(changeId,JSON.stringify(c.after),JSON.stringify(after),Date.now());const result={changeId,...(c.before.releases[0].groupId?{groupId:c.before.releases[0].groupId}:{}),items:after.items.map(i=>({itemId:i.itemId,revision:i.revision}))};this.db.prepare('INSERT INTO user_command_receipt VALUES(?,?,?,?)').run(commandId,fingerprint,JSON.stringify(result),new Date().toISOString());this.db.exec('COMMIT');return result;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
}
