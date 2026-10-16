import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {LibraryItem} from '../shared/contracts.js';
import type {TagWriteContext} from '../shared/tag-write-ui.js';
import {TAG_WRITE_FIELDS,readTagFieldChanges,tagWriteUuid,type TagWriteField} from '../shared/tag-write.js';
import {retentionState} from './provider-retention.js';
import {collectionValues} from './metadata-collections.js';

type Fields=TagWriteContext['fields'];
type Witness={observation_rowid:number;id:string;source:string;source_ref:string;rights_id:string;policy_json:string;value_json?:string;values_json?:string;override_json?:string|null};
type Member={id:string;name:string;role?:string;joinPhrase?:string|null;creditedName?:string|null;sourceArtistId?:string};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=(member:Member)=>member.creditedName??member.name;
const memberKey=(member:Member)=>JSON.stringify([member.sourceArtistId??member.id,text(member)]);
const safeArray=(value:unknown):string[]=>{if(!Array.isArray(value)||value.length>256||value.some(id=>!tagWriteUuid(id))||new Set(value).size!==value.length)throw new Error('集合来源身份无效');return value;};

// Version 1 is retained verbatim for previously frozen plans. It never grants
// the new structured-field permissions to an old review or in-flight operation.
export function legacyTagLibraryFields(db:DatabaseSync,item:LibraryItem,observationRowid?:number,activationId?:string):Fields {
 const scalar:Partial<Record<TagWriteField,string>>={title:item.title,artists:item.artist,album:item.album,genres:item.genre,date:item.catalog?.releaseDate??'',trackNumber:item.trackNumber===null?'':String(item.trackNumber),discNumber:item.discNumber===null?'':String(item.discNumber)};
 const retention=retentionState(db,'musicbrainz');
 return (Object.keys(TAG_WRITE_FIELDS) as TagWriteField[]).map(field=>{
  const sourceField=field==='artists'?'artist':field==='title'||field==='album'?field:null,current=scalar[field]??'';
  const witness=sourceField?db.prepare(`SELECT o.rowid observation_rowid,d.observation_id,d.override_json,d.locked,d.revision,o.value_json,o.source,o.source_ref,o.rights_id,o.fingerprint,r.policy_json
   FROM field_decision d JOIN metadata_observation o ON o.id=d.observation_id JOIN provider_rights r ON r.id=o.rights_id
   WHERE d.entity_kind='playable_item' AND d.entity_id=? AND d.field=? AND o.entity_kind=d.entity_kind AND o.entity_id=d.entity_id AND o.field=d.field`).get(item.id,sourceField) as {observation_rowid:number;value_json:string;source:string;policy_json:string;override_json:string|null}|undefined:undefined;
  let allowed=false;
  if(witness)try{const policy=JSON.parse(witness.policy_json) as {persist?:boolean;writeback?:boolean;expires?:unknown};const expires=policy.expires===null||typeof policy.expires==='string'&&Number.isFinite(Date.parse(policy.expires))&&Date.parse(policy.expires)>Date.now();allowed=policy.persist===true&&policy.writeback===true&&expires&&JSON.parse(witness.value_json)===current&&(witness.override_json===null||JSON.parse(witness.override_json)===current)&&(witness.source!=='musicbrainz'||retention.mode==='reviewed');if(observationRowid!==undefined&&witness.observation_rowid<=observationRowid)allowed=false;if(allowed)readTagFieldChanges([{field,values:[current]}]);}catch{allowed=false;}
  return {field,values:current?[current]:[],libraryAllowed:allowed,reason:allowed?'此字段当前来源允许保存并写回':sourceField?'此字段当前来源未允许文件写回，可使用明确确认的手工输入':'完整集合来源和角色映射尚待接通，可使用手工输入',rightsFingerprint:digest([field,current,witness??null,retention,activationId??null])};
 });
}

export function tagLibraryFields(db:DatabaseSync,item:LibraryItem,observationRowid?:number,activationId?:string,collectionRowid?:number):Fields {
 const retention=retentionState(db,'musicbrainz'),catalog=item.catalog;
 function permitted(row:Witness,collection=false):boolean {
  const policy=JSON.parse(row.policy_json) as Record<string,unknown>,cutoff=collection?collectionRowid:observationRowid;
  return policy.display===true&&policy.persist===true&&policy.writeback===true&&(policy.expires===null||typeof policy.expires==='string'&&Number.isFinite(Date.parse(policy.expires))&&Date.parse(policy.expires)>Date.now())&&(row.source!=='musicbrainz'||retention.mode==='reviewed')&&(cutoff===undefined||row.observation_rowid>cutoff);
 }
 function scalar(kind:'playable_item'|'release',id:string,field:string,value:string|null,proof:unknown[]):boolean {
  const row=db.prepare(`SELECT o.rowid observation_rowid,o.id,d.override_json,d.locked,d.revision,o.value_json,o.source,o.source_ref,o.rights_id,o.fingerprint,r.policy_json
   FROM field_decision d JOIN metadata_observation o ON o.id=d.observation_id JOIN provider_rights r ON r.id=o.rights_id
   WHERE d.entity_kind=? AND d.entity_id=? AND d.field=? AND o.entity_kind=d.entity_kind AND o.entity_id=d.entity_id AND o.field=d.field`).get(kind,id,field) as Witness|undefined;
  proof.push({kind,id,field,value,row:row??null});return Boolean(row&&permitted(row)&&JSON.parse(row.value_json!)===value&&(row.override_json===null||JSON.parse(row.override_json!)===value));
 }
 function collection(kind:'playable_item'|'release',id:string,field:'artists'|'albumArtists'|'genres',actual:Member[],proof:unknown[]):{keys:Set<string>;empty:boolean} {
  const state=db.prepare('SELECT revision,locked,mode,automatic_id,selected_json,sources_json FROM metadata_collection_state WHERE entity_kind=? AND entity_id=? AND field=?').get(kind,id,field) as {revision:number;locked:number;mode:string|null;automatic_id:string|null;selected_json:string|null;sources_json:string}|undefined;
  proof.push({kind,id,field,actual,state:state??null});if(!state)return {keys:new Set(),empty:false};
  const explicit=state.selected_json!==null,ids=safeArray(explicit?JSON.parse(state.sources_json):state.automatic_id?[state.automatic_id]:[]);
  if(!ids.length)return {keys:new Set(),empty:false};
  const observations=db.prepare(`SELECT o.rowid observation_rowid,o.id,o.values_json,o.source,o.source_ref,o.rights_id,o.fingerprint,r.policy_json FROM metadata_collection_observation o JOIN provider_rights r ON r.id=o.rights_id WHERE o.entity_kind=? AND o.entity_id=? AND o.field=? AND o.id IN(${ids.map(()=>'?').join(',')}) ORDER BY o.id`).all(kind,id,field,...ids) as unknown as Witness[];
  proof.push(observations);if(observations.length!==ids.length)return {keys:new Set(),empty:false};
  const selected=explicit?JSON.parse(state.selected_json!):JSON.parse(observations.find(row=>row.id===state.automatic_id)!.values_json!) as Member[];
  if(!Array.isArray(selected)||selected.length>256)throw new Error('集合当前依据无效');
  const projected=(values:Member[])=>field==='genres'?[...new Set(values.map(value=>memberKey(value)))].sort():values.map(value=>JSON.stringify([value.sourceArtistId??value.id,value.role,text(value),value.joinPhrase??'']));
  if(JSON.stringify(projected(actual))!==JSON.stringify(projected(selected)))return {keys:new Set(),empty:false};
  const parents:Witness[]=[];
  for(const row of observations)if(row.source==='manual'&&row.rights_id==='local-private-v1'&&(collectionRowid===undefined||row.observation_rowid>collectionRowid)){
   let reference:{providerObservation?:unknown;url?:unknown};try{reference=JSON.parse(row.source_ref);}catch{continue;}if(!tagWriteUuid(reference?.providerObservation)||typeof reference.url!=='string')continue;
   const parent=db.prepare(`SELECT o.rowid observation_rowid,o.id,o.values_json,o.source,o.source_ref,o.rights_id,o.fingerprint,r.policy_json FROM metadata_collection_observation o JOIN provider_rights r ON r.id=o.rights_id WHERE o.id=? AND o.entity_kind=? AND o.entity_id=? AND o.field=? AND o.source='musicbrainz'`).get(reference.providerObservation,kind,id,field) as Witness|undefined;
   if(parent){let original:{url?:unknown};try{original=JSON.parse(parent.source_ref);}catch{continue;}if(reference.url===original?.url)parents.push(parent);}
  }
  proof.push({parents});const approved=[...observations,...parents].filter(row=>permitted(row,true)),keys=new Set<string>();
  // Only approved original names are copied. A manual role/order wrapper does
  // not authorize its own added names, aliases, join phrases or other fields.
  for(const row of approved){const members=JSON.parse(row.values_json!);if(!Array.isArray(members)||members.length>256)throw new Error('集合原始来源无效');for(const member of members)keys.add(memberKey(member));}
  const relevant=field==='genres'?actual:actual.filter(member=>member.role===(field==='artists'?'performer':'album_artist'));
  return {keys,empty:relevant.length===0&&approved.length>0};
 }
 return (Object.keys(TAG_WRITE_FIELDS) as TagWriteField[]).map(field=>{
  const proof:unknown[]=[];let values:string[]=[],allowed=false,reason='此字段尚无可核对的曲库写回来源，可使用明确确认的手工输入';
  try{
   if(field==='title'||field==='album'){const value=field==='title'?item.title:item.album;values=value?[value]:[];allowed=scalar('playable_item',item.id,field,value,proof);if(field==='album'&&catalog&&value===catalog.releaseTitle)allowed=scalar('release',catalog.releaseId,'title',value,proof)||allowed;}
   else if(field==='date'&&catalog){values=catalog.releaseDate?[catalog.releaseDate]:[];allowed=scalar('release',catalog.releaseId,'date',catalog.releaseDate,proof);}
   else if((field==='artists'||field==='albumArtists')&&catalog){
    const members=field==='artists'?catalog.artists:catalog.albumArtists,role=field==='artists'?'performer':'album_artist',selected=members.filter(member=>member.role===role);values=selected.map(text);
    const source=collection(field==='artists'?'playable_item':'release',field==='artists'?item.id:catalog.releaseId,field,members,proof);allowed=selected.length?selected.every(member=>source.keys.has(memberKey(member))):source.empty;
    if(field==='artists'&&values.length===1&&values[0]===item.artist)allowed=scalar('playable_item',item.id,'artist',item.artist,proof)||allowed;
   }else if(field==='genres'&&catalog){
    const current=[...new Map(catalog.genres.map(value=>[value.id,value])).values()];values=current.map(value=>value.name);
    const own=collection('playable_item',item.id,'genres',collectionValues(db,'playable_item',item.id,'genres'),proof),release=collection('release',catalog.releaseId,'genres',collectionValues(db,'release',catalog.releaseId,'genres'),proof);
    allowed=current.length?current.every(value=>own.keys.has(memberKey(value))||release.keys.has(memberKey(value))):own.empty||release.empty;
   }else if(field==='trackNumber')values=item.trackNumber===null?[]:[String(item.trackNumber)];
   else if(field==='discNumber')values=item.discNumber===null?[]:[String(item.discNumber)];
   readTagFieldChanges([{field,values}]);
   if(['title','album','date','artists','albumArtists','genres'].includes(field))reason=allowed?'所写文本与当前结构化资料一致，且原始来源允许保存和写回':'当前值或原始来源尚不满足写回权限，请核对来源或使用明确确认的手工输入';
  }catch(error){allowed=false;reason=`此字段的来源或文本暂不可确认：${String(error instanceof Error?error.message:error).slice(0,200)}`;proof.push({error:reason});}
  return {field,values,libraryAllowed:allowed,reason,rightsFingerprint:digest(['tag-library-fields-v2',field,values,allowed,proof,retention,observationRowid??null,collectionRowid??null,activationId??null])};
 });
}
