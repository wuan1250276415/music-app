import {sqlStatement} from './sql-statements.js';
import {collectionSnapshot,restoreCollections,copyCollections,type CollectionSnapshot} from './metadata-collections.js';
import {createHash,randomUUID} from 'node:crypto';
import {requireOnlineRetention} from './provider-retention.js';
import type {DatabaseSync} from 'node:sqlite';
import type {CatalogRepository} from './catalog.js';
import type {CatalogChangeResult,MetadataEntityKind,MetadataScalar,MetadataSourceEntity,MetadataPolicyRef,MetadataLockRequest,MetadataObservation,MetadataObservationPage,MetadataSelectionRequest,MetadataSelectionMode,MetadataSelectionChange} from '../shared/contracts.js';

type Def={column:string;label:string};
export const metadataFields:Record<MetadataEntityKind,Record<string,Def>>={
 playable_item:{title:{column:'title',label:'歌曲名称'},artist:{column:'artist',label:'歌曲歌手'},album:{column:'album',label:'歌曲专辑'}},
 artist:{name:{column:'name',label:'人物名称'},sortName:{column:'sort_name',label:'排序名称'},disambiguation:{column:'disambiguation',label:'区分说明'}},
 recording:{title:{column:'title',label:'录音名称'},versionLabel:{column:'version_label',label:'录音版本'},durationUs:{column:'duration_us',label:'参考时长（微秒）'}},
 release:{title:{column:'title',label:'发行名称'},date:{column:'date',label:'发行日期'},country:{column:'country',label:'国家／地区'},label:{column:'label',label:'发行公司'},catalogNumber:{column:'catalog_no',label:'目录编号'},barcode:{column:'barcode',label:'条码'},edition:{column:'edition',label:'发行版本'}},
 release_group:{title:{column:'title',label:'专辑概念名称'},type:{column:'type',label:'专辑概念类型'}}
};
export const metadataProvenanceSchema=`
 CREATE TABLE provider_rights(id TEXT PRIMARY KEY,source TEXT NOT NULL,terms_version TEXT NOT NULL,policy_json TEXT NOT NULL CHECK(json_valid(policy_json)));
 INSERT INTO provider_rights VALUES('local-private-v1','local','1','{"display":true,"persist":true,"export":false,"writeback":false,"expires":null,"label":"本地使用，未声明对外授权"}');
 INSERT INTO provider_rights VALUES('musicbrainz-core-cc0-2026-09-30','musicbrainz','2026-09-30','{"display":true,"persist":true,"export":true,"writeback":true,"expires":null,"label":"MusicBrainz 核心文本 CC0","termsUrl":"https://musicbrainz.org/doc/About/Data_License"}');
 CREATE TRIGGER provider_rights_immutable BEFORE UPDATE ON provider_rights BEGIN SELECT RAISE(ABORT,'来源授权版本不可改写'); END;
 CREATE TRIGGER provider_rights_no_delete BEFORE DELETE ON provider_rights BEGIN SELECT RAISE(ABORT,'来源授权版本不可删除'); END;
 CREATE TABLE metadata_policy_state(entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0),PRIMARY KEY(entity_kind,entity_id));
 CREATE TABLE metadata_field_revision(entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,field TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),PRIMARY KEY(entity_kind,entity_id,field));
 CREATE TABLE metadata_observation(id TEXT PRIMARY KEY,entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,field TEXT NOT NULL,value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  source TEXT NOT NULL,source_ref TEXT NOT NULL,rights_id TEXT NOT NULL REFERENCES provider_rights(id),recorded_at TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE);
 CREATE INDEX idx_metadata_observation_entity ON metadata_observation(entity_kind,entity_id,field,recorded_at);
 CREATE TRIGGER metadata_observation_immutable BEFORE UPDATE ON metadata_observation BEGIN SELECT RAISE(ABORT,'元数据来源记录不可改写'); END;
 CREATE TRIGGER metadata_observation_no_delete BEFORE DELETE ON metadata_observation BEGIN SELECT RAISE(ABORT,'元数据来源记录不可删除'); END;
 CREATE TABLE field_decision(entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,field TEXT NOT NULL,observation_id TEXT REFERENCES metadata_observation(id) ON DELETE RESTRICT,
  override_json TEXT CHECK(override_json IS NULL OR json_valid(override_json)),locked INTEGER NOT NULL CHECK(locked IN(0,1)),revision INTEGER NOT NULL CHECK(revision>=0),PRIMARY KEY(entity_kind,entity_id,field));
 CREATE TRIGGER field_decision_observation_insert BEFORE INSERT ON field_decision WHEN NEW.observation_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM metadata_observation o WHERE o.id=NEW.observation_id AND o.entity_kind=NEW.entity_kind AND o.entity_id=NEW.entity_id AND o.field=NEW.field)
 BEGIN SELECT RAISE(ABORT,'字段来源不属于当前实体'); END;
 CREATE TRIGGER field_decision_observation_update BEFORE UPDATE ON field_decision WHEN NEW.observation_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM metadata_observation o WHERE o.id=NEW.observation_id AND o.entity_kind=NEW.entity_kind AND o.entity_id=NEW.entity_id AND o.field=NEW.field)
 BEGIN SELECT RAISE(ABORT,'字段来源不属于当前实体'); END;
 CREATE TABLE metadata_policy_change(id TEXT PRIMARY KEY,action TEXT NOT NULL CHECK(action IN('metadata-lock','undo')),title TEXT NOT NULL,before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)),created_at INTEGER NOT NULL,undone_at INTEGER);
 ${['metadata_policy_state','metadata_field_revision','metadata_observation','field_decision'].flatMap(table=>['INSERT','UPDATE'].map(operation=>`
 CREATE TRIGGER ${table}_owner_${operation.toLowerCase()} BEFORE ${operation} ON ${table} WHEN NOT (
 ${Object.entries(metadataFields).map(([kind,fields])=>`(NEW.entity_kind='${kind}' AND EXISTS(SELECT 1 FROM ${kind} WHERE id=NEW.entity_id)${table==='metadata_policy_state'?'':` AND NEW.field IN(${Object.keys(fields).map(name=>`'${name}'`).join(',')})`})`).join(' OR ')})
 BEGIN SELECT RAISE(ABORT,'元数据实体或字段不存在'); END;`)).join('\n')}
 ${Object.keys(metadataFields).map(kind=>`CREATE TRIGGER ${kind}_metadata_restrict BEFORE DELETE ON ${kind} WHEN EXISTS(SELECT 1 FROM metadata_policy_state WHERE entity_kind='${kind}' AND entity_id=OLD.id) OR EXISTS(SELECT 1 FROM metadata_observation WHERE entity_kind='${kind}' AND entity_id=OLD.id) BEGIN SELECT RAISE(ABORT,'实体仍有元数据来源，请保留或归档'); END;`).join('\n')}`;

export const metadataSelectionSchema=`
 CREATE TABLE metadata_selection(entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,field TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN('automatic','observation','clear')),
  PRIMARY KEY(entity_kind,entity_id,field),FOREIGN KEY(entity_kind,entity_id,field) REFERENCES field_decision(entity_kind,entity_id,field) ON DELETE CASCADE);
 CREATE TABLE metadata_auto_source(entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,field TEXT NOT NULL,observation_id TEXT NOT NULL REFERENCES metadata_observation(id) ON DELETE RESTRICT,
  PRIMARY KEY(entity_kind,entity_id,field));
 ${['INSERT','UPDATE'].map(operation=>`CREATE TRIGGER metadata_auto_source_owner_${operation.toLowerCase()} BEFORE ${operation} ON metadata_auto_source WHEN NOT EXISTS(
 SELECT 1 FROM metadata_observation WHERE id=NEW.observation_id AND entity_kind=NEW.entity_kind AND entity_id=NEW.entity_id AND field=NEW.field)
 BEGIN SELECT RAISE(ABORT,'自动来源不属于当前实体与字段'); END;`).join('\n')}
 CREATE TABLE metadata_selection_change(id TEXT PRIMARY KEY,action TEXT NOT NULL CHECK(action IN('metadata-select','undo')),title TEXT NOT NULL,
 before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),created_at INTEGER NOT NULL,undone_at INTEGER);`;

type Decision={field:string;observation_id:string|null;override_json:string|null;locked:number;revision:number};
export type ProvenanceSnapshot={revision:number;rows:Decision[];collections?:CollectionSnapshot;selections?:Array<{field:string;mode:MetadataSelectionMode}>};
function entity(kind:MetadataEntityKind,id:string):void{if(!Object.hasOwn(metadataFields,kind)||typeof id!=='string'||!id||id.length>128)throw new Error('无效元数据实体');}
function field(kind:MetadataEntityKind,name:string):void{if(!Object.hasOwn(metadataFields[kind],name))throw new Error('此实体不支持该元数据字段');}
export function scalarValues(db:DatabaseSync,kind:MetadataEntityKind,id:string):Record<string,MetadataScalar>{
 entity(kind,id);const defs=metadataFields[kind],row=sqlStatement(db,`SELECT ${Object.entries(defs).map(([name,d])=>`${d.column} ${name}`).join(',')} FROM ${kind} WHERE id=?`).get(id);
 if(!row)throw new Error('元数据实体不存在');return {...row} as Record<string,MetadataScalar>;
}
function bump(db:DatabaseSync,kind:MetadataEntityKind,id:string):void{sqlStatement(db,`INSERT INTO metadata_policy_state(entity_kind,entity_id,revision) VALUES(?,?,1)
 ON CONFLICT(entity_kind,entity_id) DO UPDATE SET revision=revision+1`).run(kind,id);}
export function provenanceSnapshot(db:DatabaseSync,kind:MetadataEntityKind,id:string):ProvenanceSnapshot{
 entity(kind,id);const collections=collectionSnapshot(db,kind,id),selections=sqlStatement(db,'SELECT field,mode FROM metadata_selection WHERE entity_kind=? AND entity_id=? ORDER BY field').all(kind,id) as Array<{field:string;mode:MetadataSelectionMode}>;return {...(collections?{collections}:{}),...(selections.length?{selections:selections.map(row=>({...row}))}:{}),revision:Number((sqlStatement(db,'SELECT revision FROM metadata_policy_state WHERE entity_kind=? AND entity_id=?').get(kind,id) as {revision:number}|undefined)?.revision??0),
  rows:(sqlStatement(db,'SELECT field,observation_id,override_json,locked,revision FROM field_decision WHERE entity_kind=? AND entity_id=? ORDER BY field').all(kind,id) as unknown as Decision[]).map(row=>({...row}))};
}
export function checkProvenanceUndo(db:DatabaseSync,kind:MetadataEntityKind,id:string,snapshot:ProvenanceSnapshot|undefined):void{
 const current=provenanceSnapshot(db,kind,id);if(snapshot?JSON.stringify(current)!==JSON.stringify(snapshot):current.revision!==0||current.rows.length!==0||current.collections!==undefined)throw new Error('字段来源或锁定已变化，不能直接撤销');
}
function nextFieldRevision(db:DatabaseSync,kind:MetadataEntityKind,id:string,name:string):number{
 return Number((sqlStatement(db,`INSERT INTO metadata_field_revision(entity_kind,entity_id,field,revision) VALUES(?,?,?,1)
 ON CONFLICT(entity_kind,entity_id,field) DO UPDATE SET revision=revision+1 RETURNING revision`).get(kind,id,name) as {revision:number}).revision);
}
function decide(db:DatabaseSync,kind:MetadataEntityKind,id:string,name:string,observationId:string|null,value:MetadataScalar,locked:boolean):void{
 sqlStatement(db,`INSERT INTO field_decision(entity_kind,entity_id,field,observation_id,override_json,locked,revision) VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(entity_kind,entity_id,field) DO UPDATE SET observation_id=excluded.observation_id,override_json=excluded.override_json,locked=excluded.locked,revision=excluded.revision`)
  .run(kind,id,name,observationId,JSON.stringify(value),locked?1:0,nextFieldRevision(db,kind,id,name));bump(db,kind,id);
}
export function restoreProvenance(db:DatabaseSync,kind:MetadataEntityKind,id:string,snapshot:ProvenanceSnapshot|undefined):void{
 entity(kind,id);const rows=snapshot?.rows??[];sqlStatement(db,'DELETE FROM field_decision WHERE entity_kind=? AND entity_id=?').run(kind,id);
 for(const row of rows){field(kind,row.field);sqlStatement(db,'INSERT INTO field_decision(entity_kind,entity_id,field,observation_id,override_json,locked,revision) VALUES(?,?,?,?,?,?,?)').run(kind,id,row.field,row.observation_id,row.override_json,row.locked,nextFieldRevision(db,kind,id,row.field));}
 for(const selection of snapshot?.selections??[])sqlStatement(db,'INSERT INTO metadata_selection(entity_kind,entity_id,field,mode) VALUES(?,?,?,?)').run(kind,id,selection.field,selection.mode);
 restoreCollections(db,kind,id,snapshot?.collections);bump(db,kind,id);
}
export function fieldLocked(db:DatabaseSync,kind:MetadataEntityKind,id:string,name:string):boolean{
 return (sqlStatement(db,'SELECT locked FROM field_decision WHERE entity_kind=? AND entity_id=? AND field=?').get(kind,id,name) as {locked:number}|undefined)?.locked===1;
}
export function restoreMetadataField(db:DatabaseSync,itemId:string,name:string,snapshot:ProvenanceSnapshot|undefined,automatic:boolean):void{
 entity('playable_item',itemId);field('playable_item',name);
 const prior=snapshot?.rows.find(row=>row.field===name),mode=snapshot?.selections?.find(row=>row.field===name)?.mode;
 let observationId=prior?.observation_id??null,override=prior?.override_json??null;
 if(automatic){const row=sqlStatement(db,"SELECT a.observation_id,o.value_json FROM metadata_auto_source a JOIN metadata_observation o ON o.id=a.observation_id WHERE a.entity_kind='playable_item' AND a.entity_id=? AND a.field=?").get(itemId,name) as {observation_id:string;value_json:string}|undefined;if(row){observationId=row.observation_id;override=row.value_json;}}
 if(observationId){const row=sqlStatement(db,"SELECT o.source,o.rights_id,r.policy_json FROM metadata_observation o JOIN provider_rights r ON r.id=o.rights_id WHERE o.id=? AND o.entity_kind='playable_item' AND o.entity_id=? AND o.field=?").get(observationId,itemId,name) as {policy_json:string}|undefined;const policy=row?JSON.parse(row.policy_json):null;if(!policy||policy.persist!==true||policy.display!==true||policy.expires!=null&&(!Number.isFinite(Date.parse(policy.expires))||Date.parse(policy.expires)<=Date.now()))throw new Error('恢复来源不允许保存或显示');}
 sqlStatement(db,"DELETE FROM metadata_selection WHERE entity_kind='playable_item' AND entity_id=? AND field=?").run(itemId,name);
 sqlStatement(db,"INSERT INTO field_decision(entity_kind,entity_id,field,observation_id,override_json,locked,revision) VALUES('playable_item',?,?,?,?,?,?) ON CONFLICT(entity_kind,entity_id,field) DO UPDATE SET observation_id=excluded.observation_id,override_json=excluded.override_json,locked=excluded.locked,revision=excluded.revision").run(itemId,name,observationId,override,prior?.locked??0,nextFieldRevision(db,'playable_item',itemId,name));
 if(mode)sqlStatement(db,"INSERT INTO metadata_selection(entity_kind,entity_id,field,mode) VALUES('playable_item',?,?,?)").run(itemId,name,mode);
 bump(db,'playable_item',itemId);
}
export function observe(db:DatabaseSync,kind:MetadataEntityKind,id:string,name:string,value:MetadataScalar,source:string,sourceRef:string,recordedAt=new Date().toISOString()):string{
 entity(kind,id);field(kind,name);const json=JSON.stringify(value);if(json===undefined||json.length>16384||value!==null&&typeof value!=='string'&&typeof value!=='number'||typeof value==='number'&&!Number.isSafeInteger(value))throw new Error('无效元数据来源值');
 if(!['manual','musicbrainz','file-tag','cue','filename','missing','local-scan','local-candidate','legacy'].includes(source)||typeof sourceRef!=='string'||sourceRef.length>4096||!Number.isFinite(Date.parse(recordedAt)))throw new Error('无效元数据来源');
 const rights=source==='musicbrainz'?'musicbrainz-core-cc0-2026-09-30':'local-private-v1',fingerprint=createHash('sha256').update(JSON.stringify([kind,id,name,json,source,sourceRef,rights])).digest('hex');
 const old=sqlStatement(db,'SELECT id FROM metadata_observation WHERE fingerprint=?').get(fingerprint) as {id:string}|undefined;if(old)return old.id;
 const observationId=randomUUID();sqlStatement(db,'INSERT INTO metadata_observation(id,entity_kind,entity_id,field,value_json,source,source_ref,rights_id,recorded_at,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?)').run(observationId,kind,id,name,json,source,sourceRef,rights,recordedAt,fingerprint);return observationId;
}
export function recordManual(db:DatabaseSync,kind:MetadataEntityKind,id:string,before:Record<string,unknown>|null,after:Record<string,unknown>,force=false):void{
 for(const [name,def] of Object.entries(metadataFields[kind])){const value=after[def.column] as MetadataScalar;if(value===undefined)continue;
  if(force||!before||JSON.stringify(before[def.column])!==JSON.stringify(value)){sqlStatement(db,'DELETE FROM metadata_selection WHERE entity_kind=? AND entity_id=? AND field=?').run(kind,id,name);const observationId=observe(db,kind,id,name,value,'manual','用户编辑');decide(db,kind,id,name,observationId,value,fieldLocked(db,kind,id,name));}}
}
export function selectionMode(db:DatabaseSync,kind:MetadataEntityKind,id:string,name:string):MetadataSelectionMode|null{
 return (sqlStatement(db,'SELECT mode FROM metadata_selection WHERE entity_kind=? AND entity_id=? AND field=?').get(kind,id,name) as {mode:MetadataSelectionMode}|undefined)?.mode??null;
}
// Reviewed scalar release values use the same immutable observations and locks as manual edits.
export function recordOnlineReleaseField(db:DatabaseSync,id:string,name:string,value:string,sourceUrl:string,fetchedAt:string):void{
 field('release',name);validateValue('release',name,value);requireOnlineRetention(db,'musicbrainz');
 if(fieldLocked(db,'release',id,name))throw new Error('发行字段已锁定');
 if(!/^https:\/\/musicbrainz\.org\/release\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceUrl))throw new Error('无效发行来源');
 sqlStatement(db,"DELETE FROM metadata_selection WHERE entity_kind='release' AND entity_id=? AND field=?").run(id,name);
 decide(db,'release',id,name,observe(db,'release',id,name,value,'musicbrainz',sourceUrl,fetchedAt),value,false);
}
export function recordOnlineGroupField(db:DatabaseSync,id:string,name:'title'|'type',value:string|null,sourceUrl:string,fetchedAt:string):void{
 field('release_group',name);validateValue('release_group',name,value);requireOnlineRetention(db,'musicbrainz');
 if(fieldLocked(db,'release_group',id,name)||!/^https:\/\/musicbrainz\.org\/release-group\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceUrl))throw new Error('专辑概念字段锁定或来源无效');
 decide(db,'release_group',id,name,observe(db,'release_group',id,name,value,'musicbrainz',sourceUrl,fetchedAt),value,false);
}
export function restoreReleaseField(db:DatabaseSync,id:string,name:string,snapshot:ProvenanceSnapshot):void{
 entity('release',id);field('release',name);const prior=snapshot.rows.find(row=>row.field===name),mode=snapshot.selections?.find(row=>row.field===name)?.mode;
 if(prior?.observation_id){const row=sqlStatement(db,"SELECT r.policy_json FROM metadata_observation o JOIN provider_rights r ON r.id=o.rights_id WHERE o.id=? AND o.entity_kind='release' AND o.entity_id=? AND o.field=?").get(prior.observation_id,id,name) as {policy_json:string}|undefined;const policy=row?JSON.parse(row.policy_json):null;if(!policy||policy.display!==true||policy.persist!==true||policy.expires!=null&&(!Number.isFinite(Date.parse(policy.expires))||Date.parse(policy.expires)<=Date.now()))throw new Error('恢复来源不允许保存或显示');}
 sqlStatement(db,"DELETE FROM field_decision WHERE entity_kind='release' AND entity_id=? AND field=?").run(id,name);
 const revision=nextFieldRevision(db,'release',id,name);
 if(prior)sqlStatement(db,"INSERT INTO field_decision(entity_kind,entity_id,field,observation_id,override_json,locked,revision) VALUES('release',?,?,?,?,?,?)").run(id,name,prior.observation_id,prior.override_json,prior.locked,revision);
 if(mode&&prior)sqlStatement(db,"INSERT INTO metadata_selection(entity_kind,entity_id,field,mode) VALUES('release',?,?,?)").run(id,name,mode);
 bump(db,'release',id);
}
function recordAutomatic(db:DatabaseSync,kind:MetadataEntityKind,id:string,name:string,observationId:string):void{
 const prior=sqlStatement(db,'SELECT observation_id FROM metadata_auto_source WHERE entity_kind=? AND entity_id=? AND field=?').get(kind,id,name) as {observation_id:string}|undefined;
 if(prior?.observation_id===observationId)return;
 sqlStatement(db,`INSERT INTO metadata_auto_source(entity_kind,entity_id,field,observation_id) VALUES(?,?,?,?) ON CONFLICT(entity_kind,entity_id,field) DO UPDATE SET observation_id=excluded.observation_id`).run(kind,id,name,observationId);bump(db,kind,id);
}
export function recordCandidate(db:DatabaseSync,kind:MetadataEntityKind,id:string,incoming?:Record<string,MetadataScalar>):void{
 const values=incoming??scalarValues(db,kind,id),confirmed=kind==='recording'&&Boolean(sqlStatement(db,'SELECT 1 FROM recording_profile_state WHERE recording_id=? AND confirmed=1').get(id));
 for(const [name,value] of Object.entries(values)){
  const observationId=observe(db,kind,id,name,value,'local-candidate','本地候选派生值');recordAutomatic(db,kind,id,name,observationId);
  const current=sqlStatement(db,`SELECT d.locked,d.observation_id,o.source FROM field_decision d LEFT JOIN metadata_observation o ON o.id=d.observation_id WHERE d.entity_kind=? AND d.entity_id=? AND d.field=?`).get(kind,id,name) as {locked:number;observation_id:string|null;source:string|null}|undefined;
  const mode=selectionMode(db,kind,id,name);
  if(current?.locked||mode==='observation'||mode==='clear'||confirmed&&mode!=='automatic'||mode!=='automatic'&&(current?.source==='manual'||current?.source==='musicbrainz'))continue;
  if(current?.observation_id!==observationId)decide(db,kind,id,name,observationId,value,false);
 }
}
export function copySourceDecisions(db:DatabaseSync,kind:MetadataEntityKind,sourceId:string,targetId:string,manualFields:string[]=[]):void{
 const source=provenanceSnapshot(db,kind,sourceId),values=scalarValues(db,kind,targetId);copyCollections(db,kind,sourceId,targetId);
 for(const [name,value] of Object.entries(values)){
  const automatic=sqlStatement(db,'SELECT o.value_json,o.source,o.source_ref,o.recorded_at FROM metadata_auto_source a JOIN metadata_observation o ON o.id=a.observation_id WHERE a.entity_kind=? AND a.entity_id=? AND a.field=?').get(kind,sourceId,name) as {value_json:string;source:string;source_ref:string;recorded_at:string}|undefined;
  if(automatic)recordAutomatic(db,kind,targetId,name,observe(db,kind,targetId,name,JSON.parse(automatic.value_json),automatic.source,automatic.source_ref,automatic.recorded_at));
  const decision=source.rows.find(row=>row.field===name);
  const observation=decision?.observation_id?sqlStatement(db,'SELECT source,source_ref,recorded_at,value_json FROM metadata_observation WHERE id=?').get(decision.observation_id) as {source:string;source_ref:string;recorded_at:string;value_json:string}|undefined:undefined;
  const manual=manualFields.includes(name),matches=observation?.value_json===JSON.stringify(value);
  const observed=observe(db,kind,targetId,name,value,manual?'manual':matches?observation!.source:'legacy',manual?'用户创建或拆分实体':matches?observation!.source_ref:'复制现有曲库值，原来源未记录',manual?undefined:matches?observation!.recorded_at:undefined);
  decide(db,kind,targetId,name,observed,value,decision?.locked===1);
  const mode=source.selections?.find(row=>row.field===name)?.mode;if(mode&&!manual&&matches)sqlStatement(db,'INSERT INTO metadata_selection(entity_kind,entity_id,field,mode) VALUES(?,?,?,?)').run(kind,targetId,name,mode);
 }
}
export function recordItemFile(db:DatabaseSync,itemId:string,origins?:Partial<Record<'title'|'artist'|'album',string>>):void{
 const values=scalarValues(db,'playable_item',itemId),override=sqlStatement(db,'SELECT title,artist,album FROM metadata_override WHERE item_id=?').get(itemId) as Record<string,string|null>|undefined;
 for(const [name,value] of Object.entries(values)){
  const source=origins?.[name as 'title'|'artist'|'album']??'local-scan',observationId=observe(db,'playable_item',itemId,name,value,source,'本地扫描');
  recordAutomatic(db,'playable_item',itemId,name,observationId);
  if(override?.[name]!==undefined&&override[name]!==null||fieldLocked(db,'playable_item',itemId,name))continue;
  const current=sqlStatement(db,"SELECT observation_id FROM field_decision WHERE entity_kind='playable_item' AND entity_id=? AND field=?").get(itemId,name) as {observation_id:string|null}|undefined;
  if(current?.observation_id!==observationId)decide(db,'playable_item',itemId,name,observationId,value,false);
 }
}
export function recordOnline(db:DatabaseSync,itemId:string,values:Partial<Record<'title'|'artist'|'album',string>>,sourceRefs:Record<string,string>,recordedAt?:string):void{
 requireOnlineRetention(db,'musicbrainz');
 for(const [name,value] of Object.entries(values)){if(fieldLocked(db,'playable_item',itemId,name))throw new Error('所选字段已锁定，请先解除锁定');sqlStatement(db,"DELETE FROM metadata_selection WHERE entity_kind='playable_item' AND entity_id=? AND field=?").run(itemId,name);const observationId=observe(db,'playable_item',itemId,name,value!,'musicbrainz',sourceRefs[name],recordedAt);decide(db,'playable_item',itemId,name,observationId,value!,false);}
}

export function recordProviderArtist(db:DatabaseSync,artistId:string,values:Record<string,string>,sourceUrl:string,recordedAt:string):void{
 requireOnlineRetention(db,'musicbrainz');
 if(!/^https:\/\/musicbrainz\.org\/artist\/[0-9a-f-]{36}$/.test(sourceUrl))throw new Error('无效艺人来源');
 for(const [field,value] of Object.entries(values)){if(!['name','sortName','disambiguation'].includes(field))throw new Error('艺人来源字段不支持');const observationId=observe(db,'artist',artistId,field,value,'musicbrainz',sourceUrl,recordedAt);decide(db,'artist',artistId,field,observationId,value,false);}
}

type PolicySnapshot={entity:MetadataSourceEntity;provenance:ProvenanceSnapshot;itemOverride?:Record<string,unknown>|null;items:Array<{itemId:string;revision:number}>};
type SelectionSnapshot=PolicySnapshot&{values:Record<string,MetadataScalar>};
type ObservationRow={id:string;entity_kind:MetadataEntityKind;entity_id:string;field:string;value_json:string;source:string;source_ref:string;recorded_at:string;policy_json:string};
function canClear(kind:MetadataEntityKind,name:string):boolean{return name!=='name'&&name!=='title';}
function clearValue(kind:MetadataEntityKind,name:string):MetadataScalar{return kind==='playable_item'||kind==='artist'&&name==='disambiguation'?'':null;}
function validateValue(kind:MetadataEntityKind,name:string,value:MetadataScalar):void{
 if(name==='durationUs'){if(value!==null&&(!Number.isSafeInteger(value)||Number(value)<0))throw new Error('录音时长需为非负整数微秒或空值');return;}
 if(value===null){if(!canClear(kind,name)||kind==='playable_item'||kind==='artist'&&name==='disambiguation')throw new Error('此字段不能采用空值');return;}
 if(typeof value!=='string'||JSON.stringify(value).length>16384||kind!=='playable_item'&&(value.length>240||/[\u0000-\u001f]/.test(value))||!canClear(kind,name)&&!value.trim())throw new Error('来源值不符合当前字段要求');
 if(kind==='release'&&name==='date'&&value){
  const match=/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value),year=Number(match?.[1]),month=match?.[2]?Number(match[2]):null,day=match?.[3]?Number(match[3]):null;
  const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(!match||year<1||month!==null&&(month<1||month>12)||day!==null&&(day<1||day>days[month!-1]))throw new Error('来源发行日期无效');
 }
}
function sourceUrl(row:ObservationRow):string|null{return row.source==='musicbrainz'&&/^https:\/\/musicbrainz\.org\/(artist|recording|release)\/[0-9a-f-]{36}$/i.test(row.source_ref)?row.source_ref:null;}
const sourceLabels:Record<string,string>={manual:'人工编辑',musicbrainz:'MusicBrainz 核心文本','file-tag':'文件标签','cue':'CUE 信息',filename:'文件名推断',missing:'文件未提供','local-scan':'本地扫描（旧解析信息）','local-candidate':'本地候选派生值','legacy':'现有曲库值（来源未记录）'};
export class MetadataProvenanceRepository{
 constructor(private readonly db:DatabaseSync,private readonly catalog:CatalogRepository,private readonly refreshSearch:(id:string)=>void){}
 get(kind:MetadataEntityKind,id:string):MetadataSourceEntity{
  const values=scalarValues(this.db,kind,id),snapshot=provenanceSnapshot(this.db,kind,id),override=kind==='playable_item'?sqlStatement(this.db,'SELECT title,artist,album,revision FROM metadata_override WHERE item_id=?').get(id) as Record<string,unknown>|undefined:undefined;
  const fields=Object.entries(metadataFields[kind]).map(([name,def])=>{const decision=snapshot.rows.find(row=>row.field===name),observation=decision?.observation_id?sqlStatement(this.db,`SELECT o.source,o.source_ref,o.recorded_at,r.policy_json FROM metadata_observation o JOIN provider_rights r ON r.id=o.rights_id WHERE o.id=?`).get(decision.observation_id) as {source:string;source_ref:string;recorded_at:string;policy_json:string}|undefined:undefined;
   const mode=selectionMode(this.db,kind,id,name);return {...(mode?{decisionMode:mode}:{}),field:name,label:def.label,value:(override?.[name]??values[name]) as MetadataScalar,locked:decision?.locked===1,source:sourceLabels[observation?.source??'legacy']??'来源未记录',recordedAt:observation?.recorded_at??null,rights:observation?String(JSON.parse(observation.policy_json).label):'来源权限未记录',sourceUrl:observation?.source==='musicbrainz'&&/^https:\/\/musicbrainz\.org\/(artist|recording|release)\/[0-9a-f-]{36}$/i.test(observation.source_ref)?observation.source_ref:null};});
  const members=this.members(kind,id),fingerprint=createHash('sha256').update(JSON.stringify([kind,id,values,override??null,snapshot,members])).digest('hex');
  return {kind,entityId:id,revision:snapshot.revision,fingerprint,title:String(fields.find(f=>f.field==='title'||f.field==='name')?.value??'元数据'),fields};
 }
 forItem(itemId:string):MetadataSourceEntity[]{
  entity('playable_item',itemId);
  const item=this.catalog.project([itemId]).get(itemId);if(!item)throw new Error('曲目不存在');
  const pairs:Array<[MetadataEntityKind,string]>=[['playable_item',itemId],['recording',item.recordingId],['release',item.releaseId],...(item.groupId?[['release_group',item.groupId] as [MetadataEntityKind,string]]:[])];
  const artists=[...item.artists,...item.albumArtists,...(item.recordingArtists??[])];for(const id of new Set(artists.map(a=>a.id)))pairs.push(['artist',id]);return pairs.map(([kind,id])=>this.get(kind,id));
 }
 private members(kind:MetadataEntityKind,id:string):Array<{itemId:string;revision:number}>{
  if(kind==='playable_item')return [{itemId:id,revision:this.catalog.project([id]).get(id)?.revision??0}];
  const where=kind==='recording'?'p.recording_id=?':kind==='release'?'r.id=?':kind==='release_group'?'r.group_id=?':`EXISTS(SELECT 1 FROM artist_credit_member c LEFT JOIN artist_identity_binding b ON b.source_artist_id=c.artist_id WHERE (c.credit_id=p.artist_credit_id OR c.credit_id=r.artist_credit_id${this.catalog.recordingCreditCondition()}) AND COALESCE(b.identity_artist_id,c.artist_id)=?)`;
  return (sqlStatement(this.db,`SELECT p.id itemId,COALESCE(s.revision,0) revision FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id JOIN release r ON r.id=m.release_id LEFT JOIN item_catalog_state s ON s.item_id=p.id WHERE ${where} ORDER BY p.id`).all(id) as unknown as Array<{itemId:string;revision:number}>).map(row=>({...row}));
 }
 private snapshot(kind:MetadataEntityKind,id:string):PolicySnapshot{return {entity:this.get(kind,id),provenance:provenanceSnapshot(this.db,kind,id),...(kind==='playable_item'?{itemOverride:sqlStatement(this.db,'SELECT title,artist,album,revision FROM metadata_override WHERE item_id=?').get(id)??null}:{}),items:this.members(kind,id)};}
 private checked(ref:MetadataPolicyRef):MetadataSourceEntity{if(!ref||!Number.isSafeInteger(ref.revision)||ref.revision<0||typeof ref.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(ref.fingerprint))throw new Error('无效元数据修订');const current=this.get(ref.kind,ref.entityId);if(current.revision!==ref.revision||current.fingerprint!==ref.fingerprint)throw new Error('元数据、成员或字段锁已变化，请刷新后重新确认');return current;}
 private refresh(kind:MetadataEntityKind,id:string):void{for(const item of this.members(kind,id)){this.catalog.refreshRevision(item.itemId);this.refreshSearch(item.itemId);}}
 private command(commandId:string,identity:unknown,action:()=>CatalogChangeResult):CatalogChangeResult{
  if(typeof commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(commandId))throw new Error('无效字段锁命令 ID');const fingerprint=createHash('sha256').update(JSON.stringify(['metadata-policy',identity])).digest('hex');this.db.exec('BEGIN IMMEDIATE');
  try{const prior=sqlStatement(this.db,'SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as {fingerprint:string;result_json:string}|undefined;if(prior){if(prior.fingerprint!==fingerprint)throw new Error('命令 ID 已用于不同操作');this.db.exec('COMMIT');return JSON.parse(prior.result_json);}const result=action();sqlStatement(this.db,'INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)').run(commandId,fingerprint,JSON.stringify(result),new Date().toISOString());this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 private save(action:string,before:PolicySnapshot):CatalogChangeResult{const after=this.snapshot(before.entity.kind,before.entity.entityId),changeId=randomUUID();sqlStatement(this.db,'INSERT INTO metadata_policy_change(id,action,title,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)').run(changeId,action,before.entity.title,JSON.stringify(before),JSON.stringify(after),Date.now());return {changeId,items:after.items};}
 private itemOverride(itemId:string,values:Record<string,string|null>):void{const revision=Number((sqlStatement(this.db,'SELECT revision FROM metadata_override WHERE item_id=?').get(itemId) as {revision:number}|undefined)?.revision??0)+1;sqlStatement(this.db,`INSERT INTO metadata_override(item_id,title,artist,album,revision) VALUES(?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET title=excluded.title,artist=excluded.artist,album=excluded.album,revision=excluded.revision`).run(itemId,values.title,values.artist,values.album,revision);this.catalog.sync(itemId);}
 edit(request:MetadataLockRequest):CatalogChangeResult{
  if(!request?.entity||!Array.isArray(request.locks)||!request.locks.length||request.locks.length>8)throw new Error('请选择有效字段锁');entity(request.entity.kind,request.entity.entityId);const seen=new Set<string>(),locks=request.locks.map(lock=>{if(!lock||typeof lock.locked!=='boolean')throw new Error('无效字段锁');field(request.entity.kind,lock.field);if(seen.has(lock.field))throw new Error('字段锁重复');seen.add(lock.field);return {...lock};}).sort((a,b)=>a.field.localeCompare(b.field));
  return this.command(request.commandId,[request.entity,locks],()=>{const current=this.checked(request.entity),before=this.snapshot(current.kind,current.entityId);if(before.items.length>5000)throw new Error('每次字段锁最多涉及 5000 个文件');
   const values=(before.itemOverride??{}) as Record<string,string|null>,overrides={title:values.title??null,artist:values.artist??null,album:values.album??null};let changed=false;
   for(const lock of locks){const existing=current.fields.find(f=>f.field===lock.field)!;if(existing.locked===lock.locked)continue;changed=true;const row=before.provenance.rows.find(r=>r.field===lock.field),o=row?.observation_id?sqlStatement(this.db,'SELECT source FROM metadata_observation WHERE id=?').get(row.observation_id) as {source:string}|undefined:undefined;
    let observationId=row?.observation_id??observe(this.db,current.kind,current.entityId,lock.field,existing.value,'legacy','锁定时的现有曲库值'),value=existing.value;
    const restoresFile=current.kind==='playable_item'&&!lock.locked&&o&&['file-tag','cue','filename','missing','local-scan'].includes(o.source)&&!['observation','clear'].includes(selectionMode(this.db,current.kind,current.entityId,lock.field)??'');
    if(restoresFile){const automatic=sqlStatement(this.db,'SELECT o.id,o.value_json FROM metadata_auto_source a JOIN metadata_observation o ON o.id=a.observation_id WHERE a.entity_kind=? AND a.entity_id=? AND a.field=?').get(current.kind,current.entityId,lock.field) as {id:string;value_json:string}|undefined;if(automatic){observationId=automatic.id;value=JSON.parse(automatic.value_json);}}
    decide(this.db,current.kind,current.entityId,lock.field,observationId,value,lock.locked);
    if(current.kind==='playable_item'){const name=lock.field as 'title'|'artist'|'album';if(lock.locked)overrides[name]=existing.value as string;else if(o&&['file-tag','cue','filename','missing','local-scan'].includes(o.source)&&!['observation','clear'].includes(selectionMode(this.db,current.kind,current.entityId,name)??''))overrides[name]=null;}
   }
   if(!changed)throw new Error('字段锁没有变化');if(current.kind==='playable_item')this.itemOverride(current.entityId,overrides);this.refresh(current.kind,current.entityId);return this.save('metadata-lock',before);
  });
 }

 private observation(observationId:string):ObservationRow{
  if(typeof observationId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(observationId))throw new Error('无效来源记录 ID');
  const row=sqlStatement(this.db,'SELECT o.*,r.policy_json FROM metadata_observation o JOIN provider_rights r ON r.id=o.rights_id WHERE o.id=?').get(observationId) as ObservationRow|undefined;
  if(!row)throw new Error('来源记录不存在');return row;
 }
 private readable(row:ObservationRow):boolean{
  const policy=JSON.parse(row.policy_json) as {display?:boolean;persist?:boolean;expires?:string|null};
  return policy.display===true&&policy.persist===true&&(policy.expires==null||Number.isFinite(Date.parse(policy.expires))&&Date.parse(policy.expires)>Date.now());
 }
 private describe(row:ObservationRow,selectedId:string|null):MetadataObservation{
  const readable=this.readable(row),value=readable?JSON.parse(row.value_json) as MetadataScalar:null;let usable=readable;
  if(usable)try{validateValue(row.entity_kind,row.field,value);}catch{usable=false;}
  return {id:row.id,value,source:sourceLabels[row.source]??'来源未记录',recordedAt:row.recorded_at,rights:String(JSON.parse(row.policy_json).label??'来源权限未记录'),sourceUrl:readable?sourceUrl(row):null,selected:row.id===selectedId,usable};
 }
 history(kind:MetadataEntityKind,id:string,name:string,cursor?:string):MetadataObservationPage{
  entity(kind,id);field(kind,name);const current=this.get(kind,id),selectedId=provenanceSnapshot(this.db,kind,id).rows.find(row=>row.field===name)?.observation_id??null;
  const parameters:Array<string|number>=[kind,id,name];let after='';
  if(cursor!==undefined){
   if(typeof cursor!=='string'||cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error('无效来源历史分页');
   let token:{kind:string;id:string;field:string;at:string;observationId:string};
   try{token=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{throw new Error('无效来源历史分页');}
   if(!token||token.kind!==kind||token.id!==id||token.field!==name||typeof token.at!=='string'||token.at.length>64||!Number.isFinite(Date.parse(token.at))||typeof token.observationId!=='string'||!/^[0-9a-f-]{36}$/i.test(token.observationId))throw new Error('来源历史分页不属于当前字段');
   after=' AND (o.recorded_at<? OR (o.recorded_at=? AND o.id<?))';parameters.push(token.at,token.at,token.observationId);
  }
  const rows=sqlStatement(this.db,`SELECT o.*,r.policy_json FROM metadata_observation o JOIN provider_rights r ON r.id=o.rights_id WHERE o.entity_kind=? AND o.entity_id=? AND o.field=?${after} ORDER BY o.recorded_at DESC,o.id DESC LIMIT 51`).all(...parameters) as unknown as ObservationRow[];
  const visible=rows.slice(0,50),last=visible.at(-1),nextCursor=rows.length>50&&last?Buffer.from(JSON.stringify({kind,id,field:name,at:last.recorded_at,observationId:last.id})).toString('base64url'):null;
  const total=Number((sqlStatement(this.db,'SELECT COUNT(*) n FROM metadata_observation WHERE entity_kind=? AND entity_id=? AND field=?').get(kind,id,name) as {n:number}).n);
  const automatic=sqlStatement(this.db,'SELECT observation_id FROM metadata_auto_source WHERE entity_kind=? AND entity_id=? AND field=?').get(kind,id,name) as {observation_id:string}|undefined;
  const mode=selectionMode(this.db,kind,id,name);
  return {entity:current,field:name,items:visible.map(row=>this.describe(row,selectedId)),total,nextCursor,mode:mode??'automatic',explicit:mode!==null,automatic:automatic?this.describe(this.observation(automatic.observation_id),selectedId):null,canClear:canClear(kind,name)};
 }
 private selectionSnapshot(kind:MetadataEntityKind,id:string):SelectionSnapshot{return {...this.snapshot(kind,id),values:scalarValues(this.db,kind,id)};}
 private applyValues(kind:MetadataEntityKind,id:string,values:Record<string,MetadataScalar>,restore=false):void{
  if(kind==='playable_item')return;
  for(const [name,value] of Object.entries(values)){field(kind,name);if(!restore)validateValue(kind,name,value);}
  if(kind==='artist'){
   const artist=sqlStatement(this.db,'SELECT archived FROM artist WHERE id=?').get(id) as {archived:number}|undefined;
   if(!artist||artist.archived)throw new Error('艺人已归档，不能修改字段来源');
  }
  const columns=Object.entries(values).map(([name])=>`${metadataFields[kind][name].column}=?`),parameters=Object.values(values);
  if(kind==='artist'&&Object.hasOwn(values,'name')){columns.push('normalized_name=?');parameters.push(String(values.name).normalize('NFKC').toLowerCase().trim());}
  if(kind==='release')columns.push('revision=revision+1');
  sqlStatement(this.db,`UPDATE ${kind} SET ${columns.join(',')} WHERE id=?`).run(...parameters,id);
  if(kind==='recording')sqlStatement(this.db,`INSERT INTO recording_profile_state(recording_id,revision,confirmed) VALUES(?,1,0) ON CONFLICT(recording_id) DO UPDATE SET revision=revision+1`).run(id);
  if(kind==='artist'){
   const aliases=sqlStatement(this.db,'SELECT source_artist_id id FROM artist_identity_binding WHERE identity_artist_id=?').all(id) as unknown as Array<{id:string}>;
   if(aliases.length>5000)throw new Error('每次来源选择最多涉及 5000 个艺人候选');
   for(const artistId of [id,...aliases.map(alias=>alias.id)])sqlStatement(this.db,'INSERT INTO artist_identity_state(artist_id,revision) VALUES(?,1) ON CONFLICT(artist_id) DO UPDATE SET revision=revision+1').run(artistId);
  }
  if(kind==='release_group')sqlStatement(this.db,'UPDATE release SET revision=revision+1 WHERE group_id=?').run(id);
 }
 private saveSelection(action:string,before:SelectionSnapshot):CatalogChangeResult{
  const after=this.selectionSnapshot(before.entity.kind,before.entity.entityId),changeId=randomUUID();
  sqlStatement(this.db,'INSERT INTO metadata_selection_change(id,action,title,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)').run(changeId,action,before.entity.title,JSON.stringify(before),JSON.stringify(after),Date.now());return {changeId,items:after.items};
 }
 select(request:MetadataSelectionRequest):CatalogChangeResult{
  if(!request?.entity||!Array.isArray(request.changes)||!request.changes.length||request.changes.length>8)throw new Error('请选择有效的字段来源');entity(request.entity.kind,request.entity.entityId);
  const seen=new Set<string>(),changes=request.changes.map(change=>{
   if(!change||!['automatic','observation','clear'].includes(change.mode))throw new Error('无效字段来源选择');field(request.entity.kind,change.field);
   if(seen.has(change.field))throw new Error('字段来源选择重复');seen.add(change.field);
   if(change.mode==='observation'&&(typeof change.observationId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(change.observationId)))throw new Error('请选择有效来源记录');
   return change.mode==='observation'?{field:change.field,mode:change.mode,observationId:change.observationId}:{field:change.field,mode:change.mode};
  }).sort((a,b)=>a.field.localeCompare(b.field)) as MetadataSelectionChange[];
  return this.command(request.commandId,['select',request.entity,changes],()=>{
   const current=this.checked(request.entity),before=this.selectionSnapshot(current.kind,current.entityId);if(before.items.length>5000)throw new Error('每次来源选择最多影响 5000 个文件');
   const updated:Record<string,MetadataScalar>={},prior=before.itemOverride??{},overrides={title:(prior.title??null) as string|null,artist:(prior.artist??null) as string|null,album:(prior.album??null) as string|null};let changed=false;
   for(const change of changes){
    const currentField=current.fields.find(value=>value.field===change.field)!,decision=before.provenance.rows.find(row=>row.field===change.field),existingMode=selectionMode(this.db,current.kind,current.entityId,change.field);
    let observationId:string,value:MetadataScalar;
    if(change.mode==='clear'){
     if(!canClear(current.kind,change.field))throw new Error('名称字段不能清空，请选择其他来源');value=clearValue(current.kind,change.field);observationId=observe(this.db,current.kind,current.entityId,change.field,value,'manual','用户要求清空');
    }else{
     if(change.mode==='automatic'){
      if(currentField.locked)throw new Error('请先解除字段锁，再恢复自动来源');
      const automatic=sqlStatement(this.db,'SELECT observation_id FROM metadata_auto_source WHERE entity_kind=? AND entity_id=? AND field=?').get(current.kind,current.entityId,change.field) as {observation_id:string}|undefined;
      if(!automatic)throw new Error('没有可确认的自动来源，请先重新扫描音乐目录');observationId=automatic.observation_id;
     }else observationId=change.observationId;
     const observation=this.observation(observationId);
     if(observation.entity_kind!==current.kind||observation.entity_id!==current.entityId||observation.field!==change.field)throw new Error('所选来源不属于当前实体与字段');
     if(!this.readable(observation))throw new Error('所选来源已过期或不允许保存与展示');value=JSON.parse(observation.value_json) as MetadataScalar;
    }
    validateValue(current.kind,change.field,value);
    if(existingMode===change.mode&&decision?.observation_id===observationId&&JSON.stringify(currentField.value)===JSON.stringify(value))continue;
    changed=true;updated[change.field]=value;decide(this.db,current.kind,current.entityId,change.field,observationId,value,currentField.locked);
    sqlStatement(this.db,'INSERT INTO metadata_selection(entity_kind,entity_id,field,mode) VALUES(?,?,?,?) ON CONFLICT(entity_kind,entity_id,field) DO UPDATE SET mode=excluded.mode').run(current.kind,current.entityId,change.field,change.mode);
    if(current.kind==='playable_item')overrides[change.field as 'title'|'artist'|'album']=change.mode==='automatic'?null:value as string;
   }
   if(!changed)throw new Error('字段来源没有变化');
   if(current.kind==='playable_item')this.itemOverride(current.entityId,overrides);else this.applyValues(current.kind,current.entityId,updated);
   this.refresh(current.kind,current.entityId);return this.saveSelection('metadata-select',before);
  });
 }
 private undoSelection(changeId:string,commandId:string):CatalogChangeResult{
  return this.command(commandId,['undo-selection',changeId],()=>{
   const row=sqlStatement(this.db,'SELECT * FROM metadata_selection_change WHERE id=?').get(changeId) as {action:string;before_json:string;after_json:string;undone_at:number|null}|undefined;
   if(!row||row.action==='undo'||row.undone_at!==null)throw new Error('来源选择修订不存在或已撤销');const before=JSON.parse(row.before_json) as SelectionSnapshot,after=JSON.parse(row.after_json) as SelectionSnapshot;
   const current=this.checked(after.entity),snapshot=this.selectionSnapshot(current.kind,current.entityId);restoreProvenance(this.db,current.kind,current.entityId,before.provenance);
   if(current.kind==='playable_item'){const values=before.itemOverride??{};this.itemOverride(current.entityId,{title:(values.title??null) as string|null,artist:(values.artist??null) as string|null,album:(values.album??null) as string|null});}
   else this.applyValues(current.kind,current.entityId,before.values,true);
   this.refresh(current.kind,current.entityId);sqlStatement(this.db,'UPDATE metadata_selection_change SET undone_at=? WHERE id=?').run(Date.now(),changeId);return this.saveSelection('undo',snapshot);
  });
 }
 owns(changeId:string):boolean{return Boolean(sqlStatement(this.db,'SELECT 1 FROM metadata_policy_change WHERE id=? UNION ALL SELECT 1 FROM metadata_selection_change WHERE id=? LIMIT 1').get(changeId,changeId));}

 undo(changeId:string,commandId:string):CatalogChangeResult{if(sqlStatement(this.db,'SELECT 1 FROM metadata_selection_change WHERE id=?').get(changeId))return this.undoSelection(changeId,commandId);return this.command(commandId,['undo',changeId],()=>{const row=sqlStatement(this.db,'SELECT * FROM metadata_policy_change WHERE id=?').get(changeId) as {action:string;before_json:string;after_json:string;undone_at:number|null}|undefined;if(!row||row.action==='undo'||row.undone_at!==null)throw new Error('字段锁修订不存在或已撤销');const before=JSON.parse(row.before_json) as PolicySnapshot,after=JSON.parse(row.after_json) as PolicySnapshot,current=this.checked(after.entity),snapshot=this.snapshot(current.kind,current.entityId);restoreProvenance(this.db,current.kind,current.entityId,before.provenance);if(current.kind==='playable_item'){const values=before.itemOverride??{};this.itemOverride(current.entityId,{title:(values.title??null) as string|null,artist:(values.artist??null) as string|null,album:(values.album??null) as string|null});}this.refresh(current.kind,current.entityId);sqlStatement(this.db,'UPDATE metadata_policy_change SET undone_at=? WHERE id=?').run(Date.now(),changeId);return this.save('undo',snapshot);});}
}
