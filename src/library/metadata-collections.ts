import {readMetadataAlbumCreditsApply,type MetadataAlbumCreditsApplyRequest,type MetadataAlbumCreditsResult,type MetadataAlbumCreditUndoPreview} from '../shared/metadata-album-credits.js';
import {sqlStatement} from './sql-statements.js';
import {createHash,randomUUID} from 'node:crypto';
import {requireOnlineRetention} from './provider-retention.js';
import {ensureGenre} from './genres.js';
import {hasCreditNames} from './artist-credit.js';
import {providerArtistIdentity,importProviderArtist} from './online-credits.js';
import {fieldLocked} from './metadata-provenance.js';
import type {DatabaseSync} from 'node:sqlite';
import type {CatalogRepository} from './catalog.js';
import type {CatalogChangeResult,MetadataCollectionKind,MetadataCollectionField,MetadataCollectionMember,MetadataCollectionRef,MetadataCollectionView,MetadataCollectionRequest,MetadataCollectionObservation} from '../shared/contracts.js';
import type {MetadataCandidate,MetadataCreditApplyRequest} from '../shared/contracts.js';

const definitions={playable_item:{artists:'曲目有序署名',genres:'曲目风格集合'},recording:{artists:'录音有序署名'},release:{albumArtists:'专辑有序署名',genres:'发行风格集合'}} as const;
const roles=['performer','composer','conductor','orchestra','album_artist'];
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceLabels:Record<string,string>={'file-tag':'文件标签',cue:'CUE 信息','local-candidate':'本地候选派生值',manual:'人工编辑',legacy:'现有曲库值（来源未记录）',musicbrainz:'MusicBrainz 主署名'};
export const metadataCollectionsSchema=`
 CREATE TABLE metadata_collection_observation(id TEXT PRIMARY KEY,entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,field TEXT NOT NULL,
 values_json TEXT NOT NULL CHECK(json_valid(values_json) AND json_type(values_json)='array'),source TEXT NOT NULL,source_ref TEXT NOT NULL,rights_id TEXT NOT NULL REFERENCES provider_rights(id),recorded_at TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE);
 CREATE INDEX idx_collection_observation ON metadata_collection_observation(entity_kind,entity_id,field,recorded_at DESC,id DESC);
 CREATE TRIGGER collection_observation_immutable BEFORE UPDATE ON metadata_collection_observation BEGIN SELECT RAISE(ABORT,'集合来源不可改写'); END;
 CREATE TRIGGER collection_observation_no_delete BEFORE DELETE ON metadata_collection_observation BEGIN SELECT RAISE(ABORT,'集合来源不可直接删除'); END;
 CREATE TABLE metadata_collection_state(entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,field TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN(0,1)),
 mode TEXT CHECK(mode IS NULL OR mode IN('manual','observation','merge','clear','automatic')),automatic_id TEXT REFERENCES metadata_collection_observation(id),
 selected_json TEXT CHECK(selected_json IS NULL OR json_valid(selected_json) AND json_type(selected_json)='array'),sources_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sources_json)),PRIMARY KEY(entity_kind,entity_id,field));
 ${['metadata_collection_observation','metadata_collection_state'].flatMap(table=>['INSERT','UPDATE'].map(operation=>`CREATE TRIGGER ${table}_owner_${operation.toLowerCase()} BEFORE ${operation} ON ${table} WHEN NOT (${Object.entries(definitions).map(([kind,fields])=>`(NEW.entity_kind='${kind}' AND NEW.field IN(${Object.keys(fields).map(f=>`'${f}'`).join(',')}) AND EXISTS(SELECT 1 FROM ${kind} WHERE id=NEW.entity_id))`).join(' OR ')}) BEGIN SELECT RAISE(ABORT,'集合实体或字段不存在'); END;`)).join('\n')}
 ${['INSERT','UPDATE'].map(operation=>`CREATE TRIGGER collection_auto_owner_${operation.toLowerCase()} BEFORE ${operation} ON metadata_collection_state WHEN NEW.automatic_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM metadata_collection_observation WHERE id=NEW.automatic_id AND entity_kind=NEW.entity_kind AND entity_id=NEW.entity_id AND field=NEW.field) BEGIN SELECT RAISE(ABORT,'集合自动来源不属于当前字段'); END;`).join('\n')}
 ${Object.keys(definitions).map(kind=>`CREATE TRIGGER ${kind}_collection_restrict BEFORE DELETE ON ${kind} WHEN EXISTS(SELECT 1 FROM metadata_collection_observation WHERE entity_kind='${kind}' AND entity_id=OLD.id) OR EXISTS(SELECT 1 FROM metadata_collection_state WHERE entity_kind='${kind}' AND entity_id=OLD.id) BEGIN SELECT RAISE(ABORT,'实体仍有集合来源，请保留或归档'); END;`).join('\n')}
 CREATE TABLE metadata_collection_change(id TEXT PRIMARY KEY,action TEXT NOT NULL CHECK(action IN('metadata-collection','undo')),title TEXT NOT NULL,before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),created_at INTEGER NOT NULL,undone_at INTEGER);
 CREATE TRIGGER artist_archive_collection BEFORE UPDATE OF archived ON artist WHEN NEW.archived=1 AND EXISTS(
 SELECT 1 FROM recording r JOIN metadata_collection_state s ON s.entity_kind='recording' AND s.entity_id=r.id AND s.field='artists' JOIN artist_credit_member c ON c.credit_id=r.artist_credit_id LEFT JOIN artist_identity_binding b ON b.source_artist_id=c.artist_id
 WHERE (s.mode IS NOT NULL OR s.locked=1) AND COALESCE(b.identity_artist_id,c.artist_id)=NEW.id) BEGIN SELECT RAISE(ABORT,'艺人仍有用户选择的录音署名，不能归档'); END;`;

type State={field:MetadataCollectionField;revision:number;locked:number;mode:string|null;automatic_id:string|null;selected_json:string|null;sources_json:string};
export type CollectionSnapshot={rows:State[]};
function supported(kind:string,field:string):void{if(!Object.hasOwn(definitions,kind)||!Object.hasOwn(definitions[kind as MetadataCollectionKind],field))throw new Error('此实体不支持该集合字段');}
function rows(db:DatabaseSync,kind:string,id:string):State[]{return (sqlStatement(db,'SELECT field,revision,locked,mode,automatic_id,selected_json,sources_json FROM metadata_collection_state WHERE entity_kind=? AND entity_id=? ORDER BY field').all(kind,id) as unknown as State[]).map(row=>({...row}));}
export function collectionSnapshot(db:DatabaseSync,kind:string,id:string):CollectionSnapshot|undefined{const values=rows(db,kind,id);return values.length?{rows:values}:undefined;}
export function checkCollectionUndo(db:DatabaseSync,kind:string,id:string,expected:CollectionSnapshot|undefined):void{if(JSON.stringify(collectionSnapshot(db,kind,id))!==JSON.stringify(expected))throw new Error('集合来源或锁定已变化，不能直接撤销');}
function setState(db:DatabaseSync,kind:MetadataCollectionKind,id:string,field:MetadataCollectionField,locked:boolean,mode:string|null,values:MetadataCollectionMember[]|null,sources:string[],automaticId?:string|null):void{
 supported(kind,field);sqlStatement(db,`INSERT INTO metadata_collection_state(entity_kind,entity_id,field,revision,locked,mode,selected_json,sources_json,automatic_id) VALUES(?,?,?,1,?,?,?,?,?)
 ON CONFLICT(entity_kind,entity_id,field) DO UPDATE SET revision=revision+1,locked=excluded.locked,mode=excluded.mode,selected_json=excluded.selected_json,sources_json=excluded.sources_json,automatic_id=COALESCE(excluded.automatic_id,metadata_collection_state.automatic_id)`)
 .run(kind,id,field,locked?1:0,mode,values===null?null:JSON.stringify(values),JSON.stringify(sources),automaticId??null);
}
export function restoreCollections(db:DatabaseSync,kind:string,id:string,snapshot:CollectionSnapshot|undefined):void{
 for(const state of rows(db,kind,id)){const prior=snapshot?.rows.find(row=>row.field===state.field);setState(db,kind as MetadataCollectionKind,id,state.field,prior?.locked===1,prior?.mode??null,prior?.selected_json?JSON.parse(prior.selected_json):null,prior?JSON.parse(prior.sources_json):[]);}
 for(const prior of snapshot?.rows??[])if(!rows(db,kind,id).some(row=>row.field===prior.field))setState(db,kind as MetadataCollectionKind,id,prior.field,prior.locked===1,prior.mode,prior.selected_json?JSON.parse(prior.selected_json):null,JSON.parse(prior.sources_json),prior.automatic_id);
}
export function creditCollection(db:DatabaseSync,creditId:string|null):MetadataCollectionMember[]{
 const values=creditId?(sqlStatement(db,`SELECT a.id,a.name,c.role,c.join_phrase joinPhrase,${hasCreditNames(db)?'c.credited_name':'NULL'} creditedName FROM artist_credit_member c JOIN artist a ON a.id=c.artist_id WHERE c.credit_id=? ORDER BY c.ordinal`).all(creditId) as unknown as MetadataCollectionMember[]):[];return values.map(({creditedName,...row},index)=>({...row,...(creditedName!=null?{creditedName}:{}),joinPhrase:row.joinPhrase??(values.slice(index+1).some(value=>value.role===row.role)?'、':'')}));
}
export function collectionValues(db:DatabaseSync,kind:MetadataCollectionKind,id:string,field:MetadataCollectionField):MetadataCollectionMember[]{
 supported(kind,field);if(typeof id!=='string'||!id||id.length>128)throw new Error('无效集合实体');
 const row=sqlStatement(db,`SELECT ${field==='genres'?'id':'artist_credit_id'} FROM ${kind} WHERE id=?`).get(id) as {artist_credit_id?:string|null}|undefined;if(!row)throw new Error('集合实体不存在');
 if(field!=='genres')return creditCollection(db,row.artist_credit_id??null);
 const table=kind==='release'?'release_genre':'item_genre',owner=kind==='release'?'release_id':'item_id';
 return (sqlStatement(db,`SELECT g.id,g.name,j.source FROM ${table} j JOIN genre g ON g.id=j.genre_id WHERE j.${owner}=? ORDER BY g.normalized_name,g.id,j.source`).all(id) as unknown as MetadataCollectionMember[]).map(row=>({...row}));
}
function sourceReference(db:DatabaseSync,kind:MetadataCollectionKind,id:string,source:string):string{
 if(source==='manual'||source==='legacy')return JSON.stringify({note:source==='manual'?'用户主动编辑':'现有集合，原来源未记录'});
 const local=kind==='recording'?(sqlStatement(db,'SELECT local_key FROM recording WHERE id=?').get(id) as {local_key:string|null}|undefined)?.local_key:null,itemId=kind==='playable_item'?id:local?.startsWith('item:')?local.slice(5):null;
 if(itemId){const item=sqlStatement(db,'SELECT p.file_id fileId,p.cue_key cueKey,f.root_id rootId,f.relative_path file FROM playable_item p JOIN media_file f ON f.id=p.file_id WHERE p.id=?').get(itemId);if(item)return JSON.stringify(item);}
 if(kind==='release'){const release=sqlStatement(db,'SELECT root_id rootId,local_context directory FROM release WHERE id=?').get(id);if(release)return JSON.stringify(release);}
 return JSON.stringify({note:'本地候选派生值'});
}
function observe(db:DatabaseSync,kind:MetadataCollectionKind,id:string,field:MetadataCollectionField,values:MetadataCollectionMember[],source:string,at=new Date().toISOString(),sourceRef=sourceReference(db,kind,id,source)):string{
 supported(kind,field);if(!Object.hasOwn(sourceLabels,source)||values.length>256||JSON.stringify(values).length>262144)throw new Error('无效集合观察值');
 const rights=source==='musicbrainz'?'musicbrainz-core-cc0-2026-09-30':'local-private-v1';
 if(!Number.isFinite(Date.parse(at))||sourceRef.length>4096)throw new Error('无效集合来源时间或引用');
 const fingerprint=digest([kind,id,field,values,source,sourceRef,rights]),old=sqlStatement(db,'SELECT id FROM metadata_collection_observation WHERE fingerprint=?').get(fingerprint) as {id:string}|undefined;if(old)return old.id;
 const observationId=randomUUID();sqlStatement(db,'INSERT INTO metadata_collection_observation(id,entity_kind,entity_id,field,values_json,source,source_ref,rights_id,recorded_at,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?)').run(observationId,kind,id,field,JSON.stringify(values),source,sourceRef,rights,at,fingerprint);return observationId;
}
export function recordCollectionAutomatic(db:DatabaseSync,kind:MetadataCollectionKind,id:string,field:MetadataCollectionField,values:MetadataCollectionMember[],source='local-candidate'):void{
 const observationId=observe(db,kind,id,field,values,source),state=rows(db,kind,id).find(row=>row.field===field);if(state?.automatic_id===observationId)return;
 const automatic=state?.mode==='automatic'&&state.locked!==1,defaultValue=state?.mode==null&&state?.locked!==1;
 setState(db,kind,id,field,state?.locked===1,state?.mode??null,automatic||defaultValue?null:state?.selected_json?JSON.parse(state.selected_json):null,automatic?[observationId]:defaultValue?[]:state?JSON.parse(state.sources_json):[],observationId);
}
export function recordCollectionManual(db:DatabaseSync,kind:MetadataCollectionKind,id:string,field:MetadataCollectionField):void{
 const values=collectionValues(db,kind,id,field),observationId=observe(db,kind,id,field,values,'manual'),state=rows(db,kind,id).find(row=>row.field===field);
 setState(db,kind,id,field,state?.locked===1,'manual',values,[observationId]);
}
export function copyCollections(db:DatabaseSync,kind:string,sourceId:string,targetId:string):void{
 if(!Object.hasOwn(definitions,kind))return;
 for(const prior of rows(db,kind,sourceId)){
  const originalSources=JSON.parse(prior.sources_json) as string[],copiedSources=originalSources.map((sourceId:string)=>{const observation=sqlStatement(db,'SELECT values_json,source,source_ref,recorded_at FROM metadata_collection_observation WHERE id=?').get(sourceId) as {values_json:string;source:string;source_ref:string;recorded_at:string}|undefined;if(!observation)throw new Error('集合来源记录不存在');return observe(db,kind as MetadataCollectionKind,targetId,prior.field,JSON.parse(observation.values_json),observation.source,observation.recorded_at,observation.source_ref);});
  let automatic:string|null=null;if(prior.automatic_id){const original=sqlStatement(db,'SELECT values_json,source,source_ref,recorded_at FROM metadata_collection_observation WHERE id=?').get(prior.automatic_id) as {values_json:string;source:string;source_ref:string;recorded_at:string};automatic=observe(db,kind as MetadataCollectionKind,targetId,prior.field,JSON.parse(original.values_json),original.source,original.recorded_at,original.source_ref);}
  const selected=prior.selected_json?(JSON.parse(prior.selected_json) as MetadataCollectionMember[]).map(value=>({...value,...(value.source?.startsWith('collection:')?{source:'collection:'+value.source.slice(11).split(',').map(source=>{const index=originalSources.indexOf(source);return index>=0?copiedSources[index]:source;}).join(',')}: {})})):null;
  setState(db,kind as MetadataCollectionKind,targetId,prior.field,prior.locked===1,prior.mode,selected,copiedSources,automatic);if(prior.field==='genres'&&selected)apply(db,kind as MetadataCollectionKind,targetId,prior.field,selected,copiedSources);
 }
}
function resolved(db:DatabaseSync,values:MetadataCollectionMember[],field:MetadataCollectionField,validate=false):MetadataCollectionMember[]{
 const seen=new Set<string>();if(values.length>(field==='genres'?256:64))throw new Error('集合成员数量超出限制');
 const result=values.map(value=>{
  if(field==='genres'){const genre=sqlStatement(db,'SELECT id,name FROM genre WHERE id=?').get(value.id) as {id:string;name:string}|undefined;if(!genre)throw new Error('风格已不存在');return {...value,name:genre.name};}
  const artist=sqlStatement(db,`SELECT a.id,COALESCE(i.name,a.name) name,COALESCE(i.id,a.id) identityId,a.archived,COALESCE(i.archived,0) identityArchived,COALESCE(s.revision,0) revision FROM artist a LEFT JOIN artist_identity_binding b ON b.source_artist_id=a.id LEFT JOIN artist i ON i.id=b.identity_artist_id LEFT JOIN artist_identity_state s ON s.artist_id=a.id WHERE a.id=?`).get(value.id) as {id:string;name:string;identityId:string;archived:number;identityArchived:number;revision:number}|undefined;
  if(!artist||validate&&(artist.archived||artist.identityArchived))throw new Error('署名艺人已不存在或归档');
  if(!value.role||!roles.includes(value.role)||(field==='albumArtists')!==(value.role==='album_artist')||typeof value.joinPhrase!=='string'||value.joinPhrase.length>80||/[\u0000-\u001f]/.test(value.joinPhrase))throw new Error('署名角色或连接词无效');
  if(value.creditedName!=null&&(typeof value.creditedName!=='string'||!value.creditedName.trim()||value.creditedName.length>240||/[\u0000-\u001f\u007f]/.test(value.creditedName)))throw new Error('当次署名名称无效');
  const key=JSON.stringify([artist.identityId,value.role]);if(validate&&seen.has(key))throw new Error('同一艺人身份与角色重复，请明确保留一个成员');seen.add(key);
  return {...value,name:artist.name};
 });
 return result;
}
function apply(db:DatabaseSync,kind:MetadataCollectionKind,id:string,field:MetadataCollectionField,values:MetadataCollectionMember[],sources:string[]):void{
 if(field==='genres'){
  const table=kind==='release'?'release_genre':'item_genre',owner=kind==='release'?'release_id':'item_id';sqlStatement(db,`DELETE FROM ${table} WHERE ${owner}=?`).run(id);
  const source=sources.length?`collection:${sources.join(',')}`:'collection:clear';for(const value of values)sqlStatement(db,`INSERT OR IGNORE INTO ${table}(${owner},genre_id,source) VALUES(?,?,?)`).run(id,value.id,value.source??source);
 }else{
  const currentCredit=sqlStatement(db,`SELECT c.id,c.owner_key FROM ${kind} e JOIN artist_credit c ON c.id=e.artist_credit_id WHERE e.id=?`).get(id) as {id:string;owner_key:string}|undefined;
  if(currentCredit&&(currentCredit.owner_key.startsWith('manual')||currentCredit.owner_key.startsWith('collection-credit:'))&&JSON.stringify(creditCollection(db,currentCredit.id))===JSON.stringify(values))return;
  const owner=`collection-credit:${digest([kind,id,field,values])}`,existing=sqlStatement(db,'SELECT id FROM artist_credit WHERE owner_key=?').get(owner) as {id:string}|undefined;
  const creditId=existing?.id??randomUUID();if(!existing){const current=resolved(db,values,field),display=current.filter(m=>m.role===(field==='albumArtists'?'album_artist':'performer')).map(m=>(m.creditedName??m.name)+m.joinPhrase).join('');
   sqlStatement(db,'INSERT INTO artist_credit(id,owner_key,display_text) VALUES(?,?,?)').run(creditId,owner,display);values.forEach((member,index)=>{const named=hasCreditNames(db);sqlStatement(db,`INSERT INTO artist_credit_member(credit_id,ordinal,artist_id,role,join_phrase${named?',credited_name':''}) VALUES(?,?,?,?,?${named?',?':''})`).run(creditId,index,member.id,member.role!,member.joinPhrase!,...(named?[member.creditedName??null]:[]));});}
  if(kind==='playable_item')sqlStatement(db,'INSERT INTO item_credit_binding(item_id,credit_id) VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET credit_id=excluded.credit_id').run(id,creditId);
  sqlStatement(db,`UPDATE ${kind} SET artist_credit_id=? WHERE id=?`).run(creditId,id);
 }
}
export function protectCollections(db:DatabaseSync,kind:MetadataCollectionKind,id:string):void{
 for(const state of rows(db,kind,id))if(state.selected_json!==null&&(state.locked===1||state.mode!==null&&state.mode!=='automatic'))apply(db,kind,id,state.field,JSON.parse(state.selected_json),JSON.parse(state.sources_json));
}
type Snapshot={ref:MetadataCollectionRef;state:CollectionSnapshot|undefined;values:MetadataCollectionMember[];items:Array<{itemId:string;revision:number}>;binding?:string|null;creditId?:string|null;online?:{provider:string;recordingId:string;releaseId:string|null;createdArtists:string[];observations:string[];fetchedAt:string;expiresAt:string|null;sourceUrl:string}};
export interface ReviewedAlbumCreditTarget {key:string;itemId:string;ref:MetadataCollectionRef;candidate:MetadataCandidate;members:import('../shared/contracts.js').MetadataCreditMember[];trackIds:string[];scope:'track'|'recording'|'release'}
export class MetadataCollectionRepository{
 constructor(private readonly db:DatabaseSync,private readonly catalog:CatalogRepository,private readonly refreshSearch:(id:string)=>void){}
 private members(kind:MetadataCollectionKind,id:string):Array<{itemId:string;revision:number}>{
  const where=kind==='playable_item'?'p.id=?':kind==='recording'?'p.recording_id=?':'m.release_id=?';return (sqlStatement(this.db,`SELECT p.id itemId,COALESCE(s.revision,0) revision FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id LEFT JOIN item_catalog_state s ON s.item_id=p.id WHERE ${where} ORDER BY p.id`).all(id) as unknown as Snapshot['items']).map(row=>({...row}));
 }
 private observation(kind:MetadataCollectionKind,id:string,field:MetadataCollectionField,observationId:string):MetadataCollectionObservation{
  if(typeof observationId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(observationId))throw new Error('无效集合来源 ID');
  const row=sqlStatement(this.db,'SELECT o.*,r.policy_json FROM metadata_collection_observation o JOIN provider_rights r ON r.id=o.rights_id WHERE o.id=? AND o.entity_kind=? AND o.entity_id=? AND o.field=?').get(observationId,kind,id,field) as {id:string;source:string;source_ref:string;values_json:string;recorded_at:string;policy_json:string}|undefined;
  if(!row)throw new Error('集合来源不属于当前实体与字段');const policy=JSON.parse(row.policy_json);if(policy.display!==true||policy.persist!==true||policy.expires!=null&&(!Number.isFinite(Date.parse(policy.expires))||Date.parse(policy.expires)<=Date.now()))throw new Error('集合来源不允许展示或保存');
  return {id:row.id,source:sourceLabels[row.source]??row.source,sourceRef:row.source_ref,recordedAt:row.recorded_at,rights:String(policy.label??'来源权限未记录'),values:(JSON.parse(row.values_json) as MetadataCollectionMember[]).map(value=>({...value,fingerprint:this.memberFingerprint(value,field)}))};
 }
 private memberFingerprint(value:MetadataCollectionMember,field:MetadataCollectionField):string{return digest(field==='genres'?sqlStatement(this.db,'SELECT * FROM genre WHERE id=?').get(value.id)??null:sqlStatement(this.db,`SELECT a.*,b.identity_artist_id,i.name identityName,i.archived identityArchived,s.revision FROM artist a LEFT JOIN artist_identity_binding b ON b.source_artist_id=a.id LEFT JOIN artist i ON i.id=b.identity_artist_id LEFT JOIN artist_identity_state s ON s.artist_id=a.id WHERE a.id=?`).get(value.id)??null);}
 get(kind:MetadataCollectionKind,id:string,field:MetadataCollectionField,cursor?:string):MetadataCollectionView{
  const values=collectionValues(this.db,kind,id,field),state=rows(this.db,kind,id).find(row=>row.field===field),members=this.members(kind,id);
  const dependencies=field==='genres'?values.map(value=>sqlStatement(this.db,'SELECT * FROM genre WHERE id=?').get(value.id)):values.map(value=>sqlStatement(this.db,`SELECT a.*,b.identity_artist_id,i.name identityName,i.archived identityArchived,s.revision FROM artist a LEFT JOIN artist_identity_binding b ON b.source_artist_id=a.id LEFT JOIN artist i ON i.id=b.identity_artist_id LEFT JOIN artist_identity_state s ON s.artist_id=a.id WHERE a.id=?`).get(value.id));
  const automatic=state?.automatic_id?this.observation(kind,id,field,state.automatic_id):null;const fingerprint=digest([kind,id,field,values,rows(this.db,kind,id),members,dependencies,automatic]),parameters:string[]=[kind,id,field];let after='';
  if(cursor!==undefined){let token:string[];try{if(typeof cursor!=='string'||cursor.length>2048||!/^[\w-]+$/.test(cursor))throw new Error();token=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{throw new Error('无效集合历史分页');}
   if(!Array.isArray(token)||token.length!==5||token.slice(0,3).join(':')!==[kind,id,field].join(':')||!Number.isFinite(Date.parse(token[3]))||!/^[0-9a-f-]{36}$/i.test(token[4]))throw new Error('集合历史分页不属于当前字段');after=' AND (recorded_at<? OR recorded_at=? AND id<?)';parameters.push(token[3],token[3],token[4]);}
  const history=sqlStatement(this.db,`SELECT id,recorded_at FROM metadata_collection_observation WHERE entity_kind=? AND entity_id=? AND field=?${after} ORDER BY recorded_at DESC,id DESC LIMIT 26`).all(...parameters) as unknown as Array<{id:string;recorded_at:string}>;
  const last=history[24],title=sqlStatement(this.db,`SELECT ${kind==='playable_item'?"COALESCE((SELECT title FROM metadata_override WHERE item_id=playable_item.id),title)":'title'} title FROM ${kind} WHERE id=?`).get(id) as {title:string};
  return {kind,entityId:id,field,revision:state?.revision??0,fingerprint,label:(definitions[kind] as Record<string,string>)[field],title:title.title,locked:state?.locked===1,mode:state?.mode??'default',values,
   automatic,observations:history.slice(0,25).map(row=>this.observation(kind,id,field,row.id)),nextCursor:history.length>25&&last?Buffer.from(JSON.stringify([kind,id,field,last.recorded_at,last.id])).toString('base64url'):null};
 }
 private snapshot(ref:MetadataCollectionRef):Snapshot{
  return {ref,state:collectionSnapshot(this.db,ref.kind,ref.entityId),values:collectionValues(this.db,ref.kind,ref.entityId,ref.field),items:this.members(ref.kind,ref.entityId),...(ref.field==='genres'?{}:{creditId:(sqlStatement(this.db,`SELECT artist_credit_id FROM ${ref.kind} WHERE id=?`).get(ref.entityId) as {artist_credit_id:string|null}).artist_credit_id}),...(ref.kind==='playable_item'&&ref.field==='artists'?{binding:(sqlStatement(this.db,'SELECT credit_id FROM item_credit_binding WHERE item_id=?').get(ref.entityId) as {credit_id:string}|undefined)?.credit_id??null}:{})};
 }
 private checked(ref:MetadataCollectionRef):MetadataCollectionView{if(!ref||!Number.isSafeInteger(ref.revision)||ref.revision<0||typeof ref.fingerprint!=='string'||!/^[0-9a-f]{64}$/.test(ref.fingerprint))throw new Error('无效集合修订');const current=this.get(ref.kind,ref.entityId,ref.field);if(current.revision!==ref.revision||current.fingerprint!==ref.fingerprint)throw new Error('集合、来源、艺人身份或关联成员已变化，请刷新后重新确认');return current;}
 private refresh(kind:MetadataCollectionKind,id:string):void{
  if(kind==='release')sqlStatement(this.db,'UPDATE release SET revision=revision+1 WHERE id=?').run(id);
  if(kind==='recording')sqlStatement(this.db,'INSERT INTO recording_profile_state(recording_id,revision,confirmed) VALUES(?,1,0) ON CONFLICT(recording_id) DO UPDATE SET revision=revision+1').run(id);
  for(const member of this.members(kind,id)){this.catalog.refreshRevision(member.itemId);this.refreshSearch(member.itemId);}
 }
 private command<T extends CatalogChangeResult>(commandId:string,identity:unknown,action:()=>T):T{
  if(typeof commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(commandId))throw new Error('无效集合命令 ID');const fingerprint=digest(['metadata-collection',identity]);this.db.exec('BEGIN IMMEDIATE');
  try{const prior=sqlStatement(this.db,'SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as {fingerprint:string;result_json:string}|undefined;if(prior){if(prior.fingerprint!==fingerprint)throw new Error('命令 ID 已用于不同操作');this.db.exec('COMMIT');return JSON.parse(prior.result_json);}
   const result=action();sqlStatement(this.db,'INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)').run(commandId,fingerprint,JSON.stringify(result),new Date().toISOString());this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 private save(action:string,title:string,before:Snapshot):CatalogChangeResult{const current=this.get(before.ref.kind,before.ref.entityId,before.ref.field),after={...this.snapshot(current),...(before.online?{online:before.online}:{})},changeId=randomUUID();sqlStatement(this.db,'INSERT INTO metadata_collection_change(id,action,title,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)').run(changeId,action,title,JSON.stringify(before),JSON.stringify(after),Date.now());return {changeId,items:after.items};}
 affectedCount(ref:MetadataCollectionRef):number{supported(ref.kind,ref.field);return this.members(ref.kind,ref.entityId).length;}
 albumCreditReceipt(raw:MetadataAlbumCreditsApplyRequest):MetadataAlbumCreditsResult|null {
  const request=readMetadataAlbumCreditsApply(raw),prior=sqlStatement(this.db,'SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(request.commandId) as {fingerprint:string;result_json:string}|undefined;
  if(!prior)return null;if(prior.fingerprint!==digest(['metadata-collection',['album-credits',request]]))throw new Error('命令ID已用于不同操作');return JSON.parse(prior.result_json);
 }
 private albumCreditStamp(ref:MetadataCollectionRef):string {
  const current=this.get(ref.kind,ref.entityId,ref.field),snapshot=this.snapshot(current);
  const where=ref.kind==='playable_item'?'p.id':ref.kind==='recording'?'p.recording_id':'m.release_id';
  const scope=sqlStatement(this.db,`SELECT p.id,p.recording_id,p.release_track_id,m.release_id FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id WHERE ${where}=? ORDER BY p.id`).all(ref.entityId);
  const scalar=ref.kind==='playable_item'?[
   sqlStatement(this.db,'SELECT p.artist,o.artist overrideArtist FROM playable_item p LEFT JOIN metadata_override o ON o.item_id=p.id WHERE p.id=?').get(ref.entityId),
   sqlStatement(this.db,"SELECT * FROM field_decision WHERE entity_kind='playable_item' AND entity_id=? AND field='artist'").get(ref.entityId)??null,
   sqlStatement(this.db,"SELECT * FROM metadata_selection WHERE entity_kind='playable_item' AND entity_id=? AND field='artist'").get(ref.entityId)??null,
  ]:null;
  return digest([ref.kind,ref.entityId,ref.field,current.revision,current.locked,current.mode,current.values,snapshot.state?.rows.filter(r=>r.field===ref.field),snapshot.binding??null,snapshot.creditId??null,scope,scalar]);
 }
 albumCredits(raw:MetadataAlbumCreditsApplyRequest,targets:ReviewedAlbumCreditTarget[],authorize:()=>void):MetadataAlbumCreditsResult {
  const request=readMetadataAlbumCreditsApply(raw);return this.command(request.commandId,['album-credits',request],()=>{
   authorize();requireOnlineRetention(this.db,'musicbrainz');if(targets.length!==request.targets.length)throw new Error('署名目标与审核范围不同');const affected=new Set<string>();
   for(const target of targets){const selected=request.targets.find(t=>t.key===target.key);if(!selected)throw new Error('目标不属于本次署名审核');const current=this.checked(target.ref);
    if(current.locked||target.ref.kind==='playable_item'&&fieldLocked(this.db,'playable_item',target.itemId,'artist'))throw new Error('所选署名或歌曲展示字段已锁定');
    if(target.ref.kind==='playable_item'&&!request.confirmedSongScope||target.ref.kind==='recording'&&!request.confirmedRecordingScope||target.ref.kind==='release'&&!request.confirmedReleaseScope)throw new Error('请分别确认歌曲、录音和发行署名范围');
    if(!selected.entries.some(e=>e.source==='candidate'))throw new Error('每个确认目标至少采用一位来源艺人');
    for(const entry of selected.entries){if(target.ref.kind==='release'&&entry.role!=='album_artist'||target.ref.kind!=='release'&&entry.role==='album_artist')throw new Error('署名角色与目标范围不同');if(entry.source==='current'){if(!current.values[entry.ordinal])throw new Error('原署名成员不存在');}else{const member=target.members[entry.ordinal];if(!member||member.archived||providerArtistIdentity(this.db,member.externalId).identityFingerprint!==member.identityFingerprint)throw new Error('来源艺人的本地身份已变化或归档，请重新审核');}}
    for(const member of this.members(target.ref.kind,target.ref.entityId))affected.add(member.itemId);
   }
   if(affected.size>5000)throw new Error('整专辑署名每次最多影响5000个可播放条目');
   const changes=targets.map(target=>{const selected=request.targets.find(t=>t.key===target.key)!,current=this.get(target.ref.kind,target.ref.entityId,target.ref.field);
    // All original refs/identities were fenced above under this write transaction.
    // Rebase only changes made by this same batch, including newly imported artists.
    const entries=selected.entries.map(e=>({...e,...(e.source==='candidate'?{identityFingerprint:providerArtistIdentity(this.db,target.members[e.ordinal].externalId).identityFingerprint}:{})}));
    const result=this.writeOnlineCredit({commandId:request.commandId,itemId:target.itemId,token:'album-credit-owned',ref:current,entries},target.candidate);
    return {changeId:result.changeId,kind:target.ref.kind,entityId:target.ref.entityId,field:target.ref.field,title:current.title,target};
   });
   for(const change of changes){const row=sqlStatement(this.db,'SELECT after_json FROM metadata_collection_change WHERE id=?').get(change.changeId) as {after_json:string};const after=JSON.parse(row.after_json);after.albumCredit={version:1,provider:'musicbrainz',commandId:request.commandId,scope:change.target.scope,releaseId:change.target.candidate.releaseId,trackIds:change.target.trackIds,stamp:this.albumCreditStamp(change.target.ref)};after.ref=this.get(change.kind,change.entityId,change.field);sqlStatement(this.db,'UPDATE metadata_collection_change SET after_json=? WHERE id=?').run(JSON.stringify(after),change.changeId);}
   return {changeId:changes[0].changeId,items:[...affected].map(itemId=>({itemId,revision:this.catalog.project([itemId]).get(itemId)!.revision})),changes:changes.map(({target,...row})=>row)};
  });
 }
 albumCreditUndoPreview(id:string):MetadataAlbumCreditUndoPreview {
  const row=sqlStatement(this.db,'SELECT title,before_json,after_json,undone_at FROM metadata_collection_change WHERE id=? AND action=\'metadata-collection\'').get(id) as {title:string;before_json:string;after_json:string;undone_at:number|null}|undefined;if(!row)throw new Error('署名修订不存在');const before=JSON.parse(row.before_json) as Snapshot,after=JSON.parse(row.after_json) as Snapshot&{albumCredit?:{stamp:string}};if(!after.albumCredit)throw new Error('不属于整专辑署名修订');const current=this.get(after.ref.kind,after.ref.entityId,after.ref.field),status=row.undone_at!==null?'undone':this.albumCreditStamp(after.ref)===after.albumCredit.stamp?'ready':'conflict';return {changeId:id,kind:after.ref.kind,title:row.title,affectedItems:this.affectedCount(after.ref),before:before.values,current:current.values,status,reason:status==='conflict'?'所选署名、角色、艺人身份、字段锁或成员已变化，保留当前值':status==='undone'?'已撤销此署名确认':''};
 }
 onlineReceipt(request:MetadataCreditApplyRequest):CatalogChangeResult|null{
  if(!request||typeof request.commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(request.commandId))throw new Error('无效在线署名命令 ID');
  const prior=sqlStatement(this.db,'SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(request.commandId) as {fingerprint:string;result_json:string}|undefined;if(!prior)return null;if(prior.fingerprint!==digest(['metadata-collection',['online-credit',request]]))throw new Error('命令 ID 已用于不同操作');return JSON.parse(prior.result_json);
 }
 onlineCredit(request:MetadataCreditApplyRequest,candidate:MetadataCandidate):CatalogChangeResult{return this.command(request.commandId,['online-credit',request],()=>this.writeOnlineCredit(request,candidate));}
 private writeOnlineCredit(request:MetadataCreditApplyRequest,candidate:MetadataCandidate):CatalogChangeResult{
   requireOnlineRetention(this.db,candidate.provider);
   if(!Array.isArray(request.entries)||!request.entries.length||request.entries.length>64||!request.entries.some(value=>value.source==='candidate'))throw new Error('请选择 1–64 个署名成员，至少采用一位候选艺人');
   const item=this.catalog.project([request.itemId]).get(request.itemId),ref=request.ref;
   if(!item||!ref||!(ref.kind==='playable_item'&&ref.entityId===request.itemId&&ref.field==='artists'||ref.kind==='recording'&&ref.entityId===item.recordingId&&ref.field==='artists'||ref.kind==='release'&&ref.entityId===item.releaseId&&ref.field==='albumArtists'))throw new Error('所选署名范围不属于当前曲目，请重新预览');
   const current=this.checked(ref);if(current.locked||ref.kind==='playable_item'&&fieldLocked(this.db,'playable_item',request.itemId,'artist'))throw new Error('署名集合或歌手展示字段已锁定，请先解除锁定');
   const before=this.snapshot(current);if(before.items.length>5000)throw new Error('每次在线署名确认最多影响 5000 个文件');
   const incoming=ref.kind==='release'?candidate.releaseCredits:candidate.recordingCredits,recordedAt=ref.kind==='release'?candidate.releaseCreditAt:candidate.recordingCreditAt;
   if(!incoming?.length||!recordedAt)throw new Error('候选尚未读取完整署名，请重新预览');
   const positions=new Set<string>();for(const entry of request.entries){if(!entry||!['current','candidate'].includes(entry.source)||!Number.isSafeInteger(entry.ordinal)||entry.ordinal<0||!roles.includes(entry.role)||typeof entry.joinPhrase!=='string'||entry.joinPhrase.length>80||/[\u0000-\u001f\u007f]/.test(entry.joinPhrase))throw new Error('署名选择、角色或连接词无效');const key=JSON.stringify([entry.source,entry.ordinal]);if(positions.has(key))throw new Error('同一署名成员重复选择');positions.add(key);
    if(entry.source==='current'){if(!current.values[entry.ordinal])throw new Error('本地署名成员已不存在');}else{const member=incoming[entry.ordinal];if(!member||providerArtistIdentity(this.db,member.externalId).identityFingerprint!==entry.identityFingerprint)throw new Error('候选艺人的本地身份或引用已变化，请刷新预览');}
   }
   const imported=new Map<string,{artistId:string;created:boolean}>(),createdArtists:string[]=[];
   for(const entry of request.entries)if(entry.source==='candidate'){const member=incoming[entry.ordinal];if(!imported.has(member.externalId)){const value=importProviderArtist(this.db,member,recordedAt);imported.set(member.externalId,value);if(value.created)createdArtists.push(value.artistId);}}
   const values=request.entries.map(entry=>{const member=entry.source==='current'?current.values[entry.ordinal]:{id:imported.get(incoming[entry.ordinal].externalId)!.artistId,name:incoming[entry.ordinal].name,creditedName:incoming[entry.ordinal].creditedName};return {...member,role:entry.role,joinPhrase:entry.joinPhrase};});
   resolved(this.db,values,ref.field,true);
   const originals=request.entries.filter(entry=>entry.source==='candidate').sort((a,b)=>a.ordinal-b.ordinal).map(entry=>{const member=incoming[entry.ordinal];return {id:imported.get(member.externalId)!.artistId,name:member.name,creditedName:member.creditedName,joinPhrase:member.joinPhrase};});
   const sourceUrl=ref.kind==='release'?`https://musicbrainz.org/release/${candidate.releaseId}`:candidate.sourceUrl;
   const providerObservation=observe(this.db,ref.kind,ref.entityId,ref.field,originals,'musicbrainz',recordedAt,JSON.stringify({url:sourceUrl,note:'API 主署名原文；未提供本地角色',ordinals:request.entries.filter(entry=>entry.source==='candidate').map(entry=>entry.ordinal)}));
   const selected=observe(this.db,ref.kind,ref.entityId,ref.field,values,'manual',undefined,JSON.stringify({url:sourceUrl,note:'用户审核在线署名并明确角色、顺序与连接词；保留选中的本地成员',providerObservation}));
   setState(this.db,ref.kind,ref.entityId,ref.field,false,'merge',values,[providerObservation,selected]);apply(this.db,ref.kind,ref.entityId,ref.field,values,[providerObservation,selected]);this.refresh(ref.kind,ref.entityId);
   before.online={provider:candidate.provider,recordingId:candidate.recordingId,releaseId:candidate.releaseId,createdArtists,observations:[providerObservation,selected],fetchedAt:recordedAt,expiresAt:candidate.expiresAt??null,sourceUrl};return this.save('metadata-collection',`在线署名 · ${current.title}`,before);
 }
 edit(request:MetadataCollectionRequest):CatalogChangeResult{
  if(!request||!['lock','automatic','clear','select','genres'].includes(request.action))throw new Error('无效集合操作');return this.command(request.commandId,request,()=>{
   const current=this.checked(request.ref),{kind,entityId:id,field}=current,before=this.snapshot(current);if(before.items.length>5000)throw new Error('每次集合编辑最多影响 5000 个文件');let values=current.values,sources:string[]=[],locked=current.locked,mode=current.mode==='default'?null:current.mode;
   if(request.action==='lock'){
    if(typeof request.locked!=='boolean'||request.locked===locked)throw new Error('集合锁没有变化');locked=request.locked;const state=rows(this.db,kind,id).find(row=>row.field===field);sources=state?JSON.parse(state.sources_json):[];
    if(locked&&mode===null&&(kind==='playable_item'&&field==='artists'&&Boolean(before.binding)||kind==='recording'&&Boolean(sqlStatement(this.db,'SELECT 1 FROM recording_profile_state WHERE recording_id=? AND confirmed=1').get(id))||kind==='release'&&field==='albumArtists'&&Boolean(sqlStatement(this.db,'SELECT 1 FROM release_profile_state WHERE release_id=?').get(id))))mode='manual';
    if(locked&&mode===null&&field==='genres'&&values.some(value=>value.source&&!['file-tag','cue'].includes(value.source)))mode='manual';
    if(locked&&!sources.length){const automatic=current.automatic?.values.map(({fingerprint,...value})=>value);sources=[automatic&&JSON.stringify(automatic)===JSON.stringify(values)?current.automatic!.id:observe(this.db,kind,id,field,values,'legacy')];}
    if(!locked&&(mode===null||mode==='automatic')){setState(this.db,kind,id,field,false,mode,null,sources);if(field==='artists'&&kind==='playable_item'){sqlStatement(this.db,'DELETE FROM item_credit_binding WHERE item_id=?').run(id);this.catalog.sync(id);}else if(current.automatic){values=current.automatic.values.map(({fingerprint,...value})=>value);apply(this.db,kind,id,field,values,[current.automatic.id]);}this.refresh(kind,id);return this.save('metadata-collection',current.title,before);}
   }else if(request.action==='automatic'){
    if(locked)throw new Error('请先解除集合锁');if(!current.automatic)throw new Error(kind==='release'&&field==='genres'?'发行风格尚无自动基线，请编辑风格或选择已记录来源':'没有明确的自动集合来源，请先重新扫描');values=current.automatic.values.map(({fingerprint,...value})=>value);mode='automatic';sources=[current.automatic.id];resolved(this.db,values,field,true);
    if(kind==='playable_item'&&field==='artists'){sqlStatement(this.db,'DELETE FROM item_credit_binding WHERE item_id=?').run(id);setState(this.db,kind,id,field,false,mode,null,sources);this.catalog.sync(id);this.refresh(kind,id);return this.save('metadata-collection',current.title,before);}
   }else if(request.action==='clear'){values=[];mode='clear';sources=[observe(this.db,kind,id,field,values,'manual')];}
   else if(request.action==='genres'){
    if(field!=='genres'||!Array.isArray(request.names)||request.names.length>256)throw new Error('风格编辑最多 256 项');const seen=new Set<string>();values=request.names.map(name=>{if(typeof name!=='string'||!name.trim()||name.trim().length>240||/[\u0000-\u001f]/.test(name))throw new Error('风格需为有效的 1–240 个字符');name=name.trim();const genre=ensureGenre(this.db,name,true);if(seen.has(genre.id))throw new Error('名称或旧标签指向同一风格，请只保留一项');seen.add(genre.id);return {...genre,source:'manual'};});mode='manual';sources=[observe(this.db,kind,id,field,values,'manual')];
   }else{
    if(!Array.isArray(request.entries)||!request.entries.length||request.entries.length>(field==='genres'?256:64))throw new Error('请选择有效的集合成员');const positions=new Set<string>(),identities=new Set<string>();sources=[];values=request.entries.map(entry=>{if(!entry||!Number.isSafeInteger(entry.ordinal)||entry.ordinal<0)throw new Error('无效集合成员位置');const identity=JSON.stringify([entry.observationId,entry.ordinal]);if(positions.has(identity))throw new Error('来源成员重复');positions.add(identity);const observation=this.observation(kind,id,field,entry.observationId),value=observation.values[entry.ordinal];if(!value)throw new Error('来源成员不存在');if(typeof entry.fingerprint!=='string'||entry.fingerprint!==value.fingerprint)throw new Error('所选来源成员身份已变化，请刷新后重新选择');if(!sources.includes(observation.id))sources.push(observation.id);if(field==='genres'){if(identities.has(value.id))throw new Error('同一风格重复，请保留一个来源成员');identities.add(value.id);}const {fingerprint:memberRef,...rawValue}=value;return {...rawValue,...(field==='genres'?{source:`collection:${observation.id}`}:{})};});mode=sources.length>1?'merge':'observation';resolved(this.db,values,field,true);
   }
   setState(this.db,kind,id,field,locked,mode,values,sources);apply(this.db,kind,id,field,values,sources);this.refresh(kind,id);return this.save('metadata-collection',current.title,before);
  });
 }
 owns(changeId:string):boolean{return Boolean(sqlStatement(this.db,'SELECT 1 FROM metadata_collection_change WHERE id=?').get(changeId));}
 undo(changeId:string,commandId:string):CatalogChangeResult{return this.command(commandId,['undo',changeId],()=>{
  const row=sqlStatement(this.db,'SELECT * FROM metadata_collection_change WHERE id=?').get(changeId) as {before_json:string;after_json:string;action:string;undone_at:number|null;title:string}|undefined;if(!row||row.action==='undo'||row.undone_at!==null)throw new Error('集合修订不存在或已撤销');const before=JSON.parse(row.before_json) as Snapshot,after=JSON.parse(row.after_json) as Snapshot&{albumCredit?:{stamp:string}},current=after.albumCredit?this.get(after.ref.kind,after.ref.entityId,after.ref.field):this.checked(after.ref),snapshot=this.snapshot(current),{kind,entityId:id,field}=current;
  if(after.albumCredit){if(this.albumCreditStamp(after.ref)!==after.albumCredit.stamp)throw new Error('署名、艺人身份、锁或成员已变化，保留当前值');const prior=before.state?.rows.find(r=>r.field===field);setState(this.db,kind,id,field,prior?.locked===1,prior?.mode??null,prior?.selected_json?JSON.parse(prior.selected_json):null,prior?JSON.parse(prior.sources_json):[],prior?.automatic_id);}else restoreCollections(this.db,kind,id,before.state);
  if(field==='genres')apply(this.db,kind,id,field,before.values,[]);else{if(kind==='playable_item'){if(before.binding)sqlStatement(this.db,'INSERT INTO item_credit_binding(item_id,credit_id) VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET credit_id=excluded.credit_id').run(id,before.binding);else sqlStatement(this.db,'DELETE FROM item_credit_binding WHERE item_id=?').run(id);}sqlStatement(this.db,`UPDATE ${kind} SET artist_credit_id=? WHERE id=?`).run(before.creditId??null,id);}
  this.refresh(kind,id);sqlStatement(this.db,'UPDATE metadata_collection_change SET undone_at=? WHERE id=?').run(Date.now(),changeId);return this.save('undo',row.title,snapshot);
 });}
}
