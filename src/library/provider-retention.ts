import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {ProviderId,ProviderRetentionMode,ProviderRetention,ProviderRetentionRequest,ProviderStoredChangePage} from '../shared/contracts.js';

const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const providers:ProviderId[]=['musicbrainz','cover-art-archive','acoustid'];
const coreRights='musicbrainz-core-cc0-2026-09-30';
export const providerRetentionSchema=`
 CREATE TABLE provider_retention(provider_id TEXT PRIMARY KEY REFERENCES provider_setting(provider_id),mode TEXT NOT NULL CHECK(mode IN('reviewed','preview-only')),revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0));
 INSERT INTO provider_retention VALUES('musicbrainz','reviewed',0),('cover-art-archive','preview-only',0),('acoustid','preview-only',0);
 CREATE TABLE provider_retention_change(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES provider_setting(provider_id),before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),created_at TEXT NOT NULL);
 CREATE TRIGGER provider_retention_change_immutable BEFORE UPDATE ON provider_retention_change BEGIN SELECT RAISE(ABORT,'来源保存设置审计不可改写'); END;
 CREATE TRIGGER provider_retention_change_no_delete BEFORE DELETE ON provider_retention_change BEGIN SELECT RAISE(ABORT,'来源保存设置审计不可删除'); END;
 CREATE INDEX metadata_change_provider_page ON metadata_change(provider,created_at DESC,id DESC);
 CREATE INDEX metadata_observation_source_count ON metadata_observation(source);
 CREATE INDEX metadata_collection_observation_source_count ON metadata_collection_observation(source);
 CREATE INDEX metadata_collection_change_source_count ON metadata_collection_change(CASE WHEN json_valid(after_json) THEN json_extract(after_json,'$.online.provider') ELSE NULL END);
`;

function registered(id:unknown):asserts id is ProviderId{if(!providers.includes(id as ProviderId))throw new Error('数据源未注册');}
export function retentionState(db:DatabaseSync,id:ProviderId):{mode:ProviderRetentionMode;revision:number}{
 registered(id);const row=db.prepare('SELECT mode,revision FROM provider_retention WHERE provider_id=?').get(id) as {mode:ProviderRetentionMode;revision:number}|undefined;
 if(!row||!['reviewed','preview-only'].includes(row.mode)||!Number.isSafeInteger(row.revision)||row.revision<0)throw new Error('数据源保存策略缺失或无效');return {...row};
}
export function requireOnlineRetention(db:DatabaseSync,id:ProviderId):void{
 if(id!=='musicbrainz'||retentionState(db,id).mode!=='reviewed')throw new Error('此数据源当前仅允许候选预览，请先在数据源设置中允许保存审核后的修改');
 const row=db.prepare('SELECT policy_json FROM provider_rights WHERE id=? AND source=?').get(coreRights,id) as {policy_json:string}|undefined;
 const policy=row?JSON.parse(row.policy_json):null;
 if(!policy||policy.display!==true||policy.persist!==true||policy.expires!=null&&(!Number.isFinite(Date.parse(policy.expires))||Date.parse(policy.expires)<=Date.now()))throw new Error('来源快照不允许保存或显示当前数据');
}

export class ProviderRetentionRepository {
 constructor(private readonly db:DatabaseSync){}
 get(id:ProviderId):ProviderRetention{
  const state=retentionState(this.db,id),count=(sql:string)=>Number((this.db.prepare(sql).get(id) as {count:number}).count);
  return {providerId:id,...state,rightsId:id==='musicbrainz'?coreRights:null,
   retention:id==='musicbrainz'?'仅保存明确审核的核心文本；查询预览只保留于短期内存。已确认的核心文本按其 CC0 授权快照保留。':id==='cover-art-archive'?'仅保存用户明确选定的本机曲库封面与来源；图片许可未核实，不开放导出或文件写回。暂停新的保存不会删除已有封面。':'能力与保留授权尚未接入，不能保存来源内容。',
   scalarChanges:count('SELECT COUNT(*) count FROM metadata_change WHERE provider=?'),
   pendingScalarChanges:count('SELECT COUNT(*) count FROM metadata_change WHERE provider=? AND undone_at IS NULL'),
   groupLinkChanges:count("SELECT COUNT(*) count FROM catalog_change WHERE action='group' AND json_extract(after_json,'$.onlineGroup.provider')=?"),
   pendingGroupLinkChanges:count("SELECT COUNT(*) count FROM catalog_change WHERE action='group' AND undone_at IS NULL AND json_extract(after_json,'$.onlineGroup.provider')=?"),
   identityChanges:count("SELECT COUNT(*) count FROM entity_reference_change WHERE action='entity-references' AND json_extract(after_json,'$.onlineIdentity.provider')=?"),
   pendingIdentityChanges:count("SELECT COUNT(*) count FROM entity_reference_change WHERE action='entity-references' AND undone_at IS NULL AND json_extract(after_json,'$.onlineIdentity.provider')=?"),
   releaseChanges:count("SELECT COUNT(*) count FROM release_profile_change WHERE action='release-profile' AND json_extract(after_json,'$.onlineRelease.provider')=?"),
   pendingReleaseChanges:count("SELECT COUNT(*) count FROM release_profile_change WHERE action='release-profile' AND undone_at IS NULL AND json_extract(after_json,'$.onlineRelease.provider')=?"),
   collectionChanges:count("SELECT COUNT(*) count FROM metadata_collection_change WHERE CASE WHEN json_valid(after_json) THEN json_extract(after_json,'$.online.provider') ELSE NULL END=?"),
   scalarObservations:count('SELECT COUNT(*) count FROM metadata_observation WHERE source=?'),
   collectionObservations:count('SELECT COUNT(*) count FROM metadata_collection_observation WHERE source=?')};
 }
 configure(request:ProviderRetentionRequest):ProviderRetention{
  if(!request||typeof request.commandId!=='string'||!uuid.test(request.commandId)||!Number.isSafeInteger(request.revision)||request.revision<0||!['reviewed','preview-only'].includes(request.mode))throw new Error('无效数据源保存设置');
  registered(request.providerId);if(request.mode==='reviewed'&&!['musicbrainz','cover-art-archive'].includes(request.providerId))throw new Error('此数据源的保存能力与授权尚未完成');
  const identity=createHash('sha256').update(JSON.stringify(['provider-retention',request.providerId,request.revision,request.mode])).digest('hex');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const prior=this.db.prepare('SELECT fingerprint FROM user_command_receipt WHERE command_id=?').get(request.commandId) as {fingerprint:string}|undefined;
   if(prior&&prior.fingerprint!==identity)throw new Error('命令 ID 已用于不同保存设置');
   if(!prior){
   const before=retentionState(this.db,request.providerId);if(before.revision!==request.revision)throw new Error('数据源保存设置已变化，请刷新');
   this.db.prepare('UPDATE provider_retention SET mode=?,revision=revision+1 WHERE provider_id=?').run(request.mode,request.providerId);
   if(request.mode==='reviewed'&&request.providerId==='musicbrainz')requireOnlineRetention(this.db,request.providerId);
   this.db.prepare('INSERT INTO provider_retention_change VALUES(?,?,?,?,?)').run(randomUUID(),request.providerId,JSON.stringify(before),JSON.stringify(retentionState(this.db,request.providerId)),new Date().toISOString());
   this.db.prepare('INSERT INTO user_command_receipt VALUES(?,?,?,?)').run(request.commandId,identity,'{}',new Date().toISOString());
   }
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
  return this.get(request.providerId);
 }
 storedChanges(id:ProviderId,cursor?:string):ProviderStoredChangePage{
  registered(id);let position:{at:string;id:string}|undefined;
  if(cursor!==undefined){try{if(typeof cursor!=='string'||cursor.length>2048)throw new Error();const value=JSON.parse(cursor);if(!value||typeof value.at!=='string'||value.at.length>32||!Number.isFinite(Date.parse(value.at))||typeof value.id!=='string'||!uuid.test(value.id))throw new Error();position=value;}catch{throw new Error('无效来源修订分页位置');}}
  const rows=this.db.prepare(`SELECT * FROM (
   SELECT m.id,m.item_id itemId,COALESCE(o.title,p.title) title,m.created_at createdAt,m.undone_at undoneAt,'item' kind FROM metadata_change m JOIN playable_item p ON p.id=m.item_id LEFT JOIN metadata_override o ON o.item_id=p.id WHERE m.provider=?
   UNION ALL SELECT id,'' itemId,title,strftime('%Y-%m-%dT%H:%M:%fZ',created_at/1000.0,'unixepoch') createdAt,undone_at undoneAt,'release' kind FROM release_profile_change WHERE action='release-profile' AND json_extract(after_json,'$.onlineRelease.provider')=?
   UNION ALL SELECT id,'' itemId,title,strftime('%Y-%m-%dT%H:%M:%fZ',created_at/1000.0,'unixepoch') createdAt,undone_at undoneAt,'identity' kind FROM entity_reference_change WHERE action='entity-references' AND json_extract(after_json,'$.onlineIdentity.provider')=?
   UNION ALL SELECT id,'' itemId,json_extract(after_json,'$.onlineGroup.title') title,strftime('%Y-%m-%dT%H:%M:%fZ',created_at/1000.0,'unixepoch') createdAt,undone_at undoneAt,'group-link' kind FROM catalog_change WHERE action='group' AND json_extract(after_json,'$.onlineGroup.provider')=?
   UNION ALL SELECT id,'' itemId,title,strftime('%Y-%m-%dT%H:%M:%fZ',created_at/1000.0,'unixepoch') createdAt,undone_at undoneAt,'album-credit' kind FROM metadata_collection_change WHERE action='metadata-collection' AND json_extract(after_json,'$.albumCredit.provider')=?
  ) WHERE 1=1 ${position?'AND (createdAt<? OR (createdAt=? AND id<?))':''} ORDER BY createdAt DESC,id DESC LIMIT 31`).all(id,id,id,id,id,...(position?[position.at,position.at,position.id]:[])) as unknown as Array<{id:string;itemId:string;title:string;createdAt:string;undoneAt:string|null;kind:'item'|'release'|'identity'|'group-link'|'album-credit'}>;
  const page=rows.slice(0,30),last=page.at(-1);
  return {items:page.map(({undoneAt,...row})=>({...row,undone:undoneAt!==null})),nextCursor:rows.length>30&&last?JSON.stringify({at:last.createdAt,id:last.id}):null};
 }
}
