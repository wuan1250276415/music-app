import {normalizedCreditName,insertCreditMember} from './artist-credit.js';
import {recordCollectionManual} from './metadata-collections.js';
import {provenanceSnapshot,recordManual,checkProvenanceUndo,restoreProvenance,type ProvenanceSnapshot} from './metadata-provenance.js';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {CatalogChangeResult,ReleaseProfileFields,ReleaseProfileRequest,ReleaseRef} from '../shared/contracts.js';
import {CatalogRepository} from './catalog.js';
import {ReleaseCurationRepository} from './release-curation.js';

export const releaseProfileSchema=`
 CREATE TABLE release_profile_state(release_id TEXT PRIMARY KEY REFERENCES release(id) ON DELETE RESTRICT);
 CREATE TABLE release_profile_change(id TEXT PRIMARY KEY,action TEXT NOT NULL CHECK(action IN('release-profile','undo')),
  title TEXT NOT NULL,before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),created_at INTEGER NOT NULL,undone_at INTEGER);
 CREATE INDEX idx_release_profile_change_time ON release_profile_change(created_at DESC,id);
 CREATE TRIGGER release_credit_active_update BEFORE UPDATE OF artist_credit_id ON release
 WHEN EXISTS(SELECT 1 FROM artist_credit_member c LEFT JOIN artist_identity_binding b ON b.source_artist_id=c.artist_id
  JOIN artist a ON a.id=COALESCE(b.identity_artist_id,c.artist_id) WHERE c.credit_id=NEW.artist_credit_id AND a.archived=1)
 BEGIN SELECT RAISE(ABORT,'发行署名艺人已归档'); END;
 CREATE TRIGGER release_credit_active_insert BEFORE INSERT ON release
 WHEN EXISTS(SELECT 1 FROM artist_credit_member c LEFT JOIN artist_identity_binding b ON b.source_artist_id=c.artist_id
  JOIN artist a ON a.id=COALESCE(b.identity_artist_id,c.artist_id) WHERE c.credit_id=NEW.artist_credit_id AND a.archived=1)
 BEGIN SELECT RAISE(ABORT,'发行署名艺人已归档'); END;`;

function text(value:unknown,required=false):string{
 if(typeof value!=='string'||value.trim().length>240||/[\u0000-\u001f]/.test(value)||required&&!value.trim())throw new Error('发行字段需为有效的 1–240 个字符');return value.trim();
}
export function normalizedReleaseFields(fields:ReleaseProfileFields):ReleaseProfileFields{
 if(!fields||!Array.isArray(fields.albumArtists)||fields.albumArtists.length>64)throw new Error('专辑署名最多 64 位艺人');
 const date=text(fields.date);
 if(date){
  const match=/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date);
  if(!match||Number(match[1])<1)throw new Error('发行日期需为 YYYY、YYYY-MM 或 YYYY-MM-DD');
  const year=Number(match[1]),month=match[2]?Number(match[2]):null,day=match[3]?Number(match[3]):null;
  const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(month!==null&&(month<1||month>12)||day!==null&&(day<1||day>days[month!-1]))throw new Error('发行日期不存在');
 }
 const seen=new Set<string>(),albumArtists=fields.albumArtists.map(member=>{
  if(!member||typeof member.artistId!=='string'||!member.artistId||member.artistId.length>128||!Number.isSafeInteger(member.artistRevision)||member.artistRevision<0||typeof member.joinPhrase!=='string'||member.joinPhrase.length>80||/[\u0000-\u001f]/.test(member.joinPhrase))throw new Error('专辑署名或艺人修订无效');
  if(seen.has(member.artistId))throw new Error('专辑艺人重复');seen.add(member.artistId);
  return {artistId:member.artistId,artistRevision:member.artistRevision,joinPhrase:member.joinPhrase,...(normalizedCreditName(member.creditedName)?{creditedName:normalizedCreditName(member.creditedName)!}:{})};
 });
 return {title:text(fields.title,true),date,country:text(fields.country),label:text(fields.label),catalogNumber:text(fields.catalogNumber),barcode:text(fields.barcode),edition:text(fields.edition),albumArtists};
}
type FieldsRow={title:string;date:string|null;country:string|null;label:string|null;catalog_no:string|null;barcode:string|null;edition:string|null;artist_credit_id:string|null};
type Snapshot={release:ReleaseRef;fields:FieldsRow;profile:boolean;items:Array<{itemId:string;revision:number}>;provenance?:ProvenanceSnapshot};

export class ReleaseProfileRepository{
 constructor(private readonly db:DatabaseSync,private readonly catalog:CatalogRepository,private readonly releases:ReleaseCurationRepository,private readonly refreshSearch:(id:string)=>void){}
 private checked(ref:ReleaseRef):void{
  if(!ref||!Number.isSafeInteger(ref.revision)||ref.revision<0||typeof ref.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(ref.fingerprint))throw new Error('无效发行修订');
  const r=this.releases.summary(ref.releaseId);if(r.revision!==ref.revision||r.fingerprint!==ref.fingerprint)throw new Error('发行资料或成员已变化，请刷新后重新确认');
 }
 private snapshot(releaseId:string):Snapshot{
  const r=this.releases.summary(releaseId),fields=this.db.prepare('SELECT title,date,country,label,catalog_no,barcode,edition,artist_credit_id FROM release WHERE id=?').get(releaseId) as FieldsRow;
  const items=this.db.prepare(`SELECT p.id itemId,COALESCE(s.revision,0) revision FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id
   LEFT JOIN item_catalog_state s ON s.item_id=p.id WHERE m.release_id=? ORDER BY p.id`).all(releaseId) as unknown as Snapshot['items'];
  return {release:{releaseId,revision:r.revision,fingerprint:r.fingerprint},fields:{...fields},profile:r.profileConfirmed,items:items.map(item=>({...item})),...(this.catalog.metadataProvenanceEnabled?{provenance:provenanceSnapshot(this.db,'release',releaseId)}:{})};
 }
 private apply(releaseId:string,fields:FieldsRow,profile:boolean):void{
  this.db.prepare('UPDATE release SET title=?,date=?,country=?,label=?,catalog_no=?,barcode=?,edition=?,artist_credit_id=?,revision=revision+1 WHERE id=?')
   .run(fields.title,fields.date,fields.country,fields.label,fields.catalog_no,fields.barcode,fields.edition,fields.artist_credit_id,releaseId);
  if(profile)this.db.prepare('INSERT OR IGNORE INTO release_profile_state(release_id) VALUES(?)').run(releaseId);
  else this.db.prepare('DELETE FROM release_profile_state WHERE release_id=?').run(releaseId);
  // Do not rescan tags or change Recording/ReleaseTrack/PlayableItem identities.
  for(const item of this.snapshot(releaseId).items){this.catalog.refreshRevision(item.itemId);this.refreshSearch(item.itemId);}
 }
 private save(action:string,title:string,before:Snapshot):CatalogChangeResult{
  const after=this.snapshot(before.release.releaseId),changeId=randomUUID();
  this.db.prepare('INSERT INTO release_profile_change(id,action,title,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)').run(changeId,action,title,JSON.stringify(before),JSON.stringify(after),Date.now());
  return {changeId,items:after.items};
 }
 private command(commandId:string,identity:unknown,action:()=>CatalogChangeResult):CatalogChangeResult{
  if(typeof commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(commandId))throw new Error('无效发行资料命令 ID');
  const fingerprint=createHash('sha256').update(JSON.stringify(['release-profile',identity])).digest('hex');this.db.exec('BEGIN IMMEDIATE');
  try{
   const receipt=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as {fingerprint:string;result_json:string}|undefined;
   if(receipt){if(receipt.fingerprint!==fingerprint)throw new Error('命令 ID 已用于不同操作');this.db.exec('COMMIT');return JSON.parse(receipt.result_json);}
   const result=action();this.db.prepare('INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)').run(commandId,fingerprint,JSON.stringify(result),new Date().toISOString());this.db.exec('COMMIT');return result;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 edit(request:ReleaseProfileRequest):CatalogChangeResult{
  if(!request)throw new Error('无效发行资料请求');const fields=normalizedReleaseFields(request.fields);
  return this.command(request.commandId,[request.release?.releaseId,request.release?.revision,request.release?.fingerprint,fields],()=>{
   this.checked(request.release);const before=this.snapshot(request.release.releaseId);
   if(before.items.length>5000)throw new Error('每次发行编辑最多影响 5000 个文件');
   const identities=new Set<string>(),names=fields.albumArtists.map(member=>{
    const artist=this.db.prepare(`SELECT COALESCE(i.id,a.id) id,COALESCE(i.name,a.name) name,a.archived,COALESCE(i.archived,0) identityArchived,COALESCE(s.revision,0) revision
      FROM artist a LEFT JOIN artist_identity_state s ON s.artist_id=a.id LEFT JOIN artist_identity_binding b ON b.source_artist_id=a.id LEFT JOIN artist i ON i.id=b.identity_artist_id WHERE a.id=?`).get(member.artistId) as {id:string;name:string;archived:number;identityArchived:number;revision:number}|undefined;
    if(!artist||artist.archived||artist.identityArchived)throw new Error('专辑艺人不存在或已归档');
    if(artist.revision!==member.artistRevision)throw new Error('专辑艺人已变化，请刷新后重新选择');
    if(identities.has(artist.id))throw new Error('同一专辑艺人身份重复');identities.add(artist.id);return (member.creditedName??artist.name)+member.joinPhrase;
   });
   const creditId=randomUUID();this.db.prepare('INSERT INTO artist_credit(id,owner_key,display_text) VALUES(?,?,?)').run(creditId,`manual-release-credit:${creditId}`,names.join(''));
   fields.albumArtists.forEach((member,ordinal)=>insertCreditMember(this.db,creditId,ordinal,{...member,role:'album_artist'}));
   this.apply(request.release.releaseId,{title:fields.title,date:fields.date||null,country:fields.country||null,label:fields.label||null,catalog_no:fields.catalogNumber||null,barcode:fields.barcode||null,edition:fields.edition||null,artist_credit_id:creditId},true);
   if(this.catalog.metadataProvenanceEnabled)recordManual(this.db,'release',request.release.releaseId,before.fields,this.snapshot(request.release.releaseId).fields,!before.profile);
   if(this.catalog.metadataProvenanceEnabled)recordCollectionManual(this.db,'release',request.release.releaseId,'albumArtists');
   return this.save('release-profile',fields.title,before);
  });
 }
 owns(changeId:string):boolean{return Boolean(this.db.prepare('SELECT 1 FROM release_profile_change WHERE id=?').get(changeId));}
 undo(changeId:string,commandId:string):CatalogChangeResult{
  return this.command(commandId,['undo',changeId],()=>{
   const change=this.db.prepare('SELECT * FROM release_profile_change WHERE id=?').get(changeId) as {action:string;title:string;before_json:string;after_json:string;undone_at:number|null}|undefined;
   if(!change||change.action==='undo'||change.undone_at!==null)throw new Error('发行资料修订不存在或已撤销');
   const before=JSON.parse(change.before_json) as Snapshot,after=JSON.parse(change.after_json) as Snapshot;this.checked(after.release);
   const current=this.snapshot(after.release.releaseId);if(JSON.stringify(current.items)!==JSON.stringify(after.items))throw new Error('发行成员已变化，不能直接撤销');
   if(this.catalog.metadataProvenanceEnabled)checkProvenanceUndo(this.db,'release',after.release.releaseId,after.provenance);
   this.apply(before.release.releaseId,before.fields,before.profile);
   if(this.catalog.metadataProvenanceEnabled)restoreProvenance(this.db,'release',before.release.releaseId,before.provenance);this.db.prepare('UPDATE release_profile_change SET undone_at=? WHERE id=?').run(Date.now(),changeId);
   return this.save('undo',change.title,current);
  });
 }
}
