import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {CatalogChangeResult,EntityReferenceKind,EntityReferenceRef,EntityReferenceRequest,EntityReferences,ExternalReference} from '../shared/contracts.js';
import {normalizedReferences,referenceOrder,safeReferenceUrl} from './external-references.js';
import {readCredit} from './artist-credit.js';
import {requireOnlineRetention} from './provider-retention.js';
import {readMetadataIdentityApply,type MetadataIdentityApplyRequest,type MetadataIdentityResult} from '../shared/metadata-identities.js';
export interface IdentityTrackContext {trackKind?:'audio'|'pregap';releaseId:string;recordingId:string;discNumber:number;position:number;printedNumber:string;groupId:string|null}
export interface ReviewedIdentityTarget {key:string;entity:EntityReferences;reference:ExternalReference;positions:string[];trackContext?:IdentityTrackContext}
export interface IdentityAcceptanceSource {provider:'musicbrainz';rightsId:'musicbrainz-core-cc0-2026-09-30';releaseId:string;sourceUrl:string;fetchedAt:string}
export const entityReferenceSchema=`
 CREATE TABLE entity_reference_state(entity_kind TEXT NOT NULL CHECK(entity_kind IN('recording','release','release_group')),entity_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0),PRIMARY KEY(entity_kind,entity_id));
 CREATE TRIGGER entity_reference_state_insert BEFORE INSERT ON entity_reference_state BEGIN
  SELECT CASE WHEN NOT((NEW.entity_kind='recording' AND EXISTS(SELECT 1 FROM recording WHERE id=NEW.entity_id))
   OR(NEW.entity_kind='release' AND EXISTS(SELECT 1 FROM release WHERE id=NEW.entity_id))
   OR(NEW.entity_kind='release_group' AND EXISTS(SELECT 1 FROM release_group WHERE id=NEW.entity_id))) THEN RAISE(ABORT,'invalid reference entity') END;
 END;
 CREATE TRIGGER entity_reference_state_identity BEFORE UPDATE OF entity_kind,entity_id ON entity_reference_state BEGIN SELECT RAISE(ABORT,'reference state identity is immutable'); END;
 CREATE TABLE entity_reference_change(id TEXT PRIMARY KEY,action TEXT NOT NULL CHECK(action IN('entity-references','undo')),title TEXT NOT NULL,before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),created_at INTEGER NOT NULL,undone_at INTEGER);
 CREATE INDEX idx_entity_reference_change_time ON entity_reference_change(created_at DESC,id);
 CREATE TRIGGER recording_reference_delete BEFORE DELETE ON recording WHEN EXISTS(SELECT 1 FROM external_ref WHERE entity_kind='recording' AND entity_id=OLD.id) OR EXISTS(SELECT 1 FROM entity_reference_state WHERE entity_kind='recording' AND entity_id=OLD.id) BEGIN SELECT RAISE(ABORT,'录音引用身份必须保留');END;
 CREATE TRIGGER release_reference_delete BEFORE DELETE ON release WHEN EXISTS(SELECT 1 FROM external_ref WHERE entity_kind='release' AND entity_id=OLD.id) OR EXISTS(SELECT 1 FROM entity_reference_state WHERE entity_kind='release' AND entity_id=OLD.id) BEGIN SELECT RAISE(ABORT,'发行引用身份必须保留');END;
 CREATE TRIGGER group_reference_delete BEFORE DELETE ON release_group WHEN EXISTS(SELECT 1 FROM external_ref WHERE entity_kind='release_group' AND entity_id=OLD.id) OR EXISTS(SELECT 1 FROM entity_reference_state WHERE entity_kind='release_group' AND entity_id=OLD.id) BEGIN SELECT RAISE(ABORT,'专辑概念引用身份必须保留');END;`;
type Item={itemId:string;revision:number};
type Snapshot={entity:EntityReferences;items:Item[]};
const kinds=['recording','release','release_group','release_track'] as const;
function identity(kind:unknown,entityId:unknown):asserts kind is EntityReferenceKind{
 if(!kinds.includes(kind as EntityReferenceKind)||typeof entityId!=='string'||!entityId||entityId.length>128)throw new Error('无效引用实体');
}
export class EntityReferenceRepository{
 constructor(private readonly db:DatabaseSync){}
 private row(kind:EntityReferenceKind,entityId:string):Record<string,unknown>{
  // Table names are selected from the validated closed kind set, never from free text.
  identity(kind,entityId);const row=this.db.prepare(`SELECT * FROM ${kind} WHERE id=?`).get(entityId);
  if(!row)throw new Error('引用实体不存在');return {...row};
 }
 private members(kind:EntityReferenceKind,entityId:string):Array<Record<string,unknown>>{
  return (this.db.prepare(`SELECT p.id itemId,COALESCE(s.revision,0) revision,p.recording_id,p.release_track_id,p.artist_credit_id,m.release_id
   FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id JOIN release r ON r.id=m.release_id
   LEFT JOIN item_catalog_state s ON s.item_id=p.id WHERE ${kind==='recording'?'p.recording_id':kind==='release'?'r.id':kind==='release_track'?'t.id':'r.group_id'}=? ORDER BY p.id`).all(entityId) as Array<Record<string,unknown>>).map(row=>({...row}));
 }
 private releases(kind:EntityReferenceKind,entityId:string):Array<Record<string,unknown>>{
  if(kind==='recording')return [];
  if(kind==='release_track')return (this.db.prepare('SELECT r.* FROM release r JOIN medium m ON m.release_id=r.id JOIN release_track t ON t.medium_id=m.id WHERE t.id=?').all(entityId) as Array<Record<string,unknown>>).map(row=>({...row,credit:readCredit(this.db,row.artist_credit_id as string|null)}));
  return (this.db.prepare(`SELECT * FROM release WHERE ${kind==='release'?'id':'group_id'}=? ORDER BY id`).all(entityId) as Array<Record<string,unknown>>).map(row=>({...row,credit:readCredit(this.db,row.artist_credit_id as string|null)}));
 }
 get(kind:EntityReferenceKind,entityId:string):EntityReferences{
  const row=this.row(kind,entityId),members=this.members(kind,entityId),releases=this.releases(kind,entityId);
  const revision=Number((this.db.prepare('SELECT revision FROM entity_reference_state WHERE entity_kind=? AND entity_id=?').get(kind,entityId) as {revision:number}|undefined)?.revision??0);
  const references=(this.db.prepare('SELECT provider,external_id externalId,url FROM external_ref WHERE entity_kind=? AND entity_id=?').all(kind,entityId) as unknown as ExternalReference[]).map(r=>({...r})).sort(referenceOrder);
  const credit=kind==='recording'||kind==='release_track'?readCredit(this.db,row.artist_credit_id as string|null):[];
  const medium=kind==='release_track'?this.db.prepare('SELECT * FROM medium WHERE id=?').get(String(row.medium_id)):undefined;
  const fingerprint=createHash('sha256').update(JSON.stringify([kind,row,members,releases,credit,revision,references,...(kind==='release_track'?[medium]:[])])).digest('hex');
  return {kind,entityId,revision,fingerprint,title:String(row.title),subtitle:kind==='recording'?[...new Set(credit.map(a=>a.name))].join('、'):kind==='release'?[row.date,row.edition,row.local_context].filter(Boolean).join(' · '):kind==='release_track'?`第${String(row.position)}轨 · ${String(row.printed_number??row.position)}`:String(row.type??''),itemCount:members.length,releaseCount:kind==='recording'?new Set(members.map(m=>m.release_id)).size:releases.length,references};
 }
 private checked(ref:EntityReferenceRef):EntityReferences{
  if(!ref||!Number.isSafeInteger(ref.revision)||ref.revision<0||typeof ref.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(ref.fingerprint))throw new Error('无效引用修订');
  const current=this.get(ref.kind,ref.entityId);if(current.revision!==ref.revision||current.fingerprint!==ref.fingerprint)throw new Error('实体资料、成员或引用已变化，请刷新后重新确认');return current;
 }
 private snapshot(kind:EntityReferenceKind,id:string):Snapshot{return {entity:this.get(kind,id),items:this.members(kind,id).map(row=>({itemId:String(row.itemId),revision:Number(row.revision)}))};}
 private write(entity:EntityReferences,references:ExternalReference[]):void{
  for(const ref of references){const owner=this.db.prepare('SELECT entity_id FROM external_ref WHERE entity_kind=? AND provider=? AND external_id=?').get(entity.kind,ref.provider,ref.externalId) as {entity_id:string}|undefined;
   if(owner&&owner.entity_id!==entity.entityId)throw new Error('外部 ID 已属于另一个本地实体，请先处理原归属');}
  this.db.prepare('DELETE FROM external_ref WHERE entity_kind=? AND entity_id=?').run(entity.kind,entity.entityId);
  for(const r of references)this.db.prepare('INSERT INTO external_ref(entity_kind,entity_id,provider,external_id,url) VALUES(?,?,?,?,?)').run(entity.kind,entity.entityId,r.provider,r.externalId,r.url);
  this.db.prepare(`INSERT INTO entity_reference_state(entity_kind,entity_id,revision) VALUES(?,?,?) ON CONFLICT(entity_kind,entity_id) DO UPDATE SET revision=excluded.revision`).run(entity.kind,entity.entityId,entity.revision+1);
 }
 private save(action:string,before:Snapshot,onlineIdentity?:IdentityAcceptanceSource&{externalId:string;mode:string;positions:string[];trackContext?:IdentityTrackContext}):CatalogChangeResult{
  const after=this.snapshot(before.entity.kind,before.entity.entityId),changeId=randomUUID();this.db.prepare('INSERT INTO entity_reference_change(id,action,title,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)').run(changeId,action,before.entity.title,JSON.stringify(before),JSON.stringify({...after,...(onlineIdentity?{onlineIdentity}: {})}),Date.now());return {changeId,items:after.items};
 }
 private command<T extends CatalogChangeResult>(commandId:string,tuple:unknown,action:()=>T):T{
  if(typeof commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(commandId))throw new Error('无效引用命令 ID');
  const fingerprint=createHash('sha256').update(JSON.stringify(['entity-references',tuple])).digest('hex');this.db.exec('BEGIN IMMEDIATE');
  try{const prior=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as {fingerprint:string;result_json:string}|undefined;
   if(prior){if(prior.fingerprint!==fingerprint)throw new Error('命令 ID 已用于不同操作');this.db.exec('COMMIT');return JSON.parse(prior.result_json);}
   const result=action();this.db.prepare('INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)').run(commandId,fingerprint,JSON.stringify(result),new Date().toISOString());this.db.exec('COMMIT');return result;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
  releaseGroupScope(releaseId:string):{entity:EntityReferences;positions:string[]}|null {
   const release=this.row('release',releaseId),groupId=release.group_id as string|null;if(!groupId)return null;
   const entity=this.get('release_group',groupId);if(entity.releaseCount>5000||entity.itemCount>5000)return {entity,positions:['专辑概念影响范围超过5000条目／发行版，暂不能确认；录音与发行版可分别审核']};
   return {entity,positions:this.releases('release_group',groupId).map(r=>`${String(r.title)} · ${[r.date,r.country,r.edition].filter(Boolean).join(' / ')||'版本资料未填写'} · 本地发行 ${String(r.id)}`)};
  }
  musicBrainzOwner(kind:EntityReferenceKind,externalId:string):string|null {return (this.db.prepare("SELECT entity_id FROM external_ref WHERE entity_kind=? AND provider='musicbrainz' AND external_id=?").get(kind,externalId) as {entity_id:string}|undefined)?.entity_id??null;}
 identityUndoPreview(id:string):import('../shared/metadata-identities.js').MetadataIdentityUndoPreview {
  if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error('无效身份修订');const row=this.db.prepare('SELECT action,title,before_json,after_json,undone_at FROM entity_reference_change WHERE id=?').get(id) as {action:string;title:string;before_json:string;after_json:string;undone_at:number|null}|undefined;if(!row)throw new Error('身份修订不存在');
   const before=JSON.parse(row.before_json) as Snapshot,after=JSON.parse(row.after_json) as Snapshot&{onlineIdentity?:IdentityAcceptanceSource};if(row.action!=='entity-references'||after.onlineIdentity?.provider!=='musicbrainz'||!kinds.includes(after.entity.kind))throw new Error('不属于在线录音／发行／专辑概念身份修订');
  const current=this.get(after.entity.kind,after.entity.entityId),status=row.undone_at!==null?'undone':current.revision===after.entity.revision&&current.fingerprint===after.entity.fingerprint?'ready':'conflict';return {changeId:id,kind:after.entity.kind,title:row.title,affectedItems:current.itemCount,before:before.entity.references,after:after.entity.references,current:current.references,status,reason:status==='conflict'?'身份资料、成员或外部引用已变化，保留当前值':status==='undone'?'已撤销此身份确认':''};
 }
 identityReceipt(raw:MetadataIdentityApplyRequest):MetadataIdentityResult|null {
  const request=readMetadataIdentityApply(raw),row=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(request.commandId) as {fingerprint:string;result_json:string}|undefined;if(!row)return null;
  if(row.fingerprint!==createHash('sha256').update(JSON.stringify(['entity-references',['online-identities',request]])).digest('hex'))throw new Error('命令 ID 已用于不同操作');return JSON.parse(row.result_json);
 }
 applyIdentities(raw:MetadataIdentityApplyRequest,targets:ReviewedIdentityTarget[],source:IdentityAcceptanceSource,authorize:()=>void):MetadataIdentityResult {
  const request=readMetadataIdentityApply(raw);return this.command(request.commandId,['online-identities',request],()=>{
   requireOnlineRetention(this.db,'musicbrainz');authorize();if(targets.length!==request.targets.length||!targets.length)throw new Error('身份目标与已审核范围不同');
   const seen=new Map<string,string>(),members=new Map<string,number>(),prepared=targets.map(target=>{
    const selected=request.targets.find(t=>t.key===target.key);if(!selected)throw new Error('身份目标不属于本次审核');const current=this.checked(target.entity);
    if(current.kind==='recording'&&!request.confirmedRecordingScope||current.kind==='release'&&!request.confirmedReleaseScope||current.kind==='release_group'&&!request.confirmedReleaseGroupScope||current.kind==='release_track'&&!request.confirmedReleaseTrackScope)throw new Error('请分别确认录音、发行、发行曲目和专辑概念身份的影响范围');
    if(!kinds.includes(current.kind)||current.itemCount>5000||current.releaseCount>5000)throw new Error('身份确认超出范围');
    const values=selected.mode==='replace-musicbrainz'?current.references.filter(r=>r.provider!=='musicbrainz'):[...current.references];if(!values.some(r=>r.provider===target.reference.provider&&r.externalId===target.reference.externalId))values.push(target.reference);
    const references=normalizedReferences(current.kind,values);if(JSON.stringify(references)===JSON.stringify(current.references))throw new Error('所选身份没有变化');
    for(const ref of references){const key=`${current.kind}:${ref.provider}:${ref.externalId}`;if(seen.has(key)&&seen.get(key)!==current.entityId)throw new Error('同一外部标识不能归属多个本地实体');seen.set(key,current.entityId);const owner=this.db.prepare('SELECT entity_id FROM external_ref WHERE entity_kind=? AND provider=? AND external_id=?').get(current.kind,ref.provider,ref.externalId) as {entity_id:string}|undefined;if(owner&&owner.entity_id!==current.entityId)throw new Error('外部标识已属于其他本地实体，请先处理原关联');}
    const before=this.snapshot(current.kind,current.entityId);for(const item of before.items)members.set(item.itemId,item.revision);return {current,references,before,target,mode:selected.mode};
   });
   if(members.size>5000)throw new Error('每次身份确认最多影响5000个可播放条目');
   const changes=prepared.map(p=>{this.write(p.current,p.references);const result=this.save('entity-references',p.before,{...source,externalId:p.target.reference.externalId,mode:p.mode,positions:p.target.positions,...(p.target.trackContext?{trackContext:p.target.trackContext}:{})});return {changeId:result.changeId,kind:p.current.kind,entityId:p.current.entityId,title:p.current.title};});
   return {changeId:changes[0].changeId,items:[...members].map(([itemId,revision])=>({itemId,revision})),changes};
  });
 }
 edit(request:EntityReferenceRequest):CatalogChangeResult{
  if(!request?.entity)throw new Error('无效引用请求');identity(request.entity.kind,request.entity.entityId);const references=normalizedReferences(request.entity.kind,request.references);
  return this.command(request.commandId,[request.entity.kind,request.entity.entityId,request.entity.revision,request.entity.fingerprint,references],()=>{
   const current=this.checked(request.entity);if(current.itemCount>5000||current.releaseCount>5000)throw new Error('每次引用编辑最多涉及 5000 个文件或发行版');
   if(JSON.stringify(references)===JSON.stringify(current.references))throw new Error('外部引用没有变化');
   const before=this.snapshot(current.kind,current.entityId);this.write(current,references);return this.save('entity-references',before);
  });
 }
 referenceUrl(ref:EntityReferenceRef,provider:string,externalId:string):string{
  const current=this.checked(ref),reference=current.references.find(r=>r.provider===provider&&r.externalId===externalId);if(!reference?.url)throw new Error('引用没有可打开的来源链接');return safeReferenceUrl(reference.url)!;
 }
 owns(changeId:string):boolean{return Boolean(this.db.prepare('SELECT 1 FROM entity_reference_change WHERE id=?').get(changeId));}
 undo(changeId:string,commandId:string):CatalogChangeResult{
  return this.command(commandId,['undo',changeId],()=>{
   const row=this.db.prepare('SELECT * FROM entity_reference_change WHERE id=?').get(changeId) as {action:string;before_json:string;after_json:string;undone_at:number|null}|undefined;
   if(!row||row.action==='undo'||row.undone_at!==null)throw new Error('引用修订不存在或已撤销');const before=JSON.parse(row.before_json) as Snapshot,after=JSON.parse(row.after_json) as Snapshot,current=this.checked(after.entity);
   const snapshot=this.snapshot(current.kind,current.entityId);this.write(current,normalizedReferences(current.kind,before.entity.references));this.db.prepare('UPDATE entity_reference_change SET undone_at=? WHERE id=?').run(Date.now(),changeId);return this.save('undo',snapshot);
  });
 }
}
