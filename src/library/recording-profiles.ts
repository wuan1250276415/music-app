import {normalizedCreditName,insertCreditMember} from './artist-credit.js';
import {recordCollectionManual} from './metadata-collections.js';
import {provenanceSnapshot,recordManual,checkProvenanceUndo,restoreProvenance,type ProvenanceSnapshot} from './metadata-provenance.js';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {CatalogChangeResult,RecordingProfile,RecordingProfileRef,RecordingProfileFields,RecordingProfileRequest} from '../shared/contracts.js';
import {CatalogRepository} from './catalog.js';
import {readCredit} from './artist-credit.js';

export const recordingProfileSchema=`
 CREATE TABLE recording_profile_state(recording_id TEXT PRIMARY KEY REFERENCES recording(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>=0),confirmed INTEGER NOT NULL CHECK(confirmed IN(0,1)));
 CREATE TABLE recording_profile_change(id TEXT PRIMARY KEY,action TEXT NOT NULL CHECK(action IN('recording-profile','undo')),title TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),created_at INTEGER NOT NULL,undone_at INTEGER);
 CREATE INDEX idx_recording_profile_change_time ON recording_profile_change(created_at DESC,id);
 CREATE TRIGGER recording_credit_active_update BEFORE UPDATE OF artist_credit_id ON recording WHEN EXISTS(
  SELECT 1 FROM artist_credit_member c LEFT JOIN artist_identity_binding b ON b.source_artist_id=c.artist_id
  JOIN artist a ON a.id=COALESCE(b.identity_artist_id,c.artist_id) WHERE c.credit_id=NEW.artist_credit_id AND a.archived=1)
 BEGIN SELECT RAISE(ABORT,'录音署名艺人已归档'); END;
 CREATE TRIGGER recording_credit_active_insert BEFORE INSERT ON recording WHEN EXISTS(
  SELECT 1 FROM artist_credit_member c LEFT JOIN artist_identity_binding b ON b.source_artist_id=c.artist_id
  JOIN artist a ON a.id=COALESCE(b.identity_artist_id,c.artist_id) WHERE c.credit_id=NEW.artist_credit_id AND a.archived=1)
 BEGIN SELECT RAISE(ABORT,'录音署名艺人已归档'); END;
 CREATE TRIGGER artist_archive_recording BEFORE UPDATE OF archived ON artist WHEN NEW.archived=1 AND EXISTS(
  SELECT 1 FROM recording r JOIN recording_profile_state s ON s.recording_id=r.id AND s.confirmed=1
  JOIN artist_credit_member c ON c.credit_id=r.artist_credit_id LEFT JOIN artist_identity_binding b ON b.source_artist_id=c.artist_id
  WHERE COALESCE(b.identity_artist_id,c.artist_id)=NEW.id)
 BEGIN SELECT RAISE(ABORT,'艺人仍有已确认录音署名，不能归档'); END;`;

type Fields={title:string;version_label:string|null;duration_us:number|null;artist_credit_id:string|null};
type Snapshot={recording:RecordingProfile;fields:Fields;items:Array<{itemId:string;revision:number}>;provenance?:ProvenanceSnapshot};
const roles=['performer','composer','conductor','orchestra'] as const;
function text(value:unknown,required=false):string{
 if(typeof value!=='string'||value.trim().length>240||/[\u0000-\u001f]/.test(value)||required&&!value.trim())throw new Error('录音字段需为有效的 1–240 个字符');return value.trim();
}
function normalized(fields:RecordingProfileFields):RecordingProfileFields{
 if(!fields||!Array.isArray(fields.artists)||fields.artists.length>64)throw new Error('录音署名最多 64 位艺人');
 if(fields.durationUs!==null&&(!Number.isSafeInteger(fields.durationUs)||fields.durationUs<0))throw new Error('参考时长需为非负整数微秒或留空');
 const seen=new Set<string>(),artists=fields.artists.map(member=>{
  if(!member||typeof member.artistId!=='string'||!member.artistId||member.artistId.length>128||!Number.isSafeInteger(member.artistRevision)||member.artistRevision<0||!roles.includes(member.role)||typeof member.joinPhrase!=='string'||member.joinPhrase.length>80||/[\u0000-\u001f]/.test(member.joinPhrase))throw new Error('录音署名、角色或艺人修订无效');
  const key=JSON.stringify([member.artistId,member.role]);if(seen.has(key))throw new Error('同一艺人的同一录音角色重复');seen.add(key);
  return {artistId:member.artistId,artistRevision:member.artistRevision,role:member.role,joinPhrase:member.joinPhrase,...(normalizedCreditName(member.creditedName)?{creditedName:normalizedCreditName(member.creditedName)!}:{})};
 });
 return {title:text(fields.title,true),versionLabel:text(fields.versionLabel),durationUs:fields.durationUs,artists};
}

export class RecordingProfileRepository{
 constructor(private readonly db:DatabaseSync,private readonly catalog:CatalogRepository,private readonly refreshSearch:(id:string)=>void){}
 private row(recordingId:string):Fields{
  if(typeof recordingId!=='string'||!recordingId||recordingId.length>128)throw new Error('无效录音 ID');
  const row=this.db.prepare('SELECT title,version_label,duration_us,artist_credit_id FROM recording WHERE id=?').get(recordingId) as Fields|undefined;
  if(!row)throw new Error('录音不存在');return {...row};
 }
 private members(recordingId:string):Array<Record<string,unknown>>{
  return (this.db.prepare(`SELECT p.id itemId,p.release_track_id,p.artist_credit_id,m.release_id,p.visible,
   COALESCE(s.revision,0) revision,s.fingerprint,p.start_cue_frame,p.end_cue_frame,b.recording_id bound_recording,b.release_track_id bound_track,
   p.kind span_kind,sp.stream_id span_stream_id,sp.start_tick span_start,sp.end_tick span_end,sp.time_base_num span_num,sp.time_base_den span_den
   FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id
   LEFT JOIN item_catalog_state s ON s.item_id=p.id LEFT JOIN item_catalog_binding b ON b.item_id=p.id
   LEFT JOIN playable_span sp ON sp.item_id=p.id AND sp.ordinal=0
   WHERE p.recording_id=? ORDER BY p.id`).all(recordingId) as Array<Record<string,unknown>>).map(row=>{const {span_kind,span_stream_id,span_start,span_end,span_num,span_den,...legacy}=row;return {...legacy,...(span_kind==='cue'&&span_den!==null&&Number(span_den)!==75?{sampleSpan:{stream_id:span_stream_id,start_tick:span_start,end_tick:span_end,time_base_num:span_num,time_base_den:span_den}}:{})};});
 }
 get(recordingId:string):RecordingProfile{
  const fields=this.row(recordingId),members=this.members(recordingId),artists=readCredit(this.db,fields.artist_credit_id);
  const state=this.db.prepare('SELECT revision,confirmed FROM recording_profile_state WHERE recording_id=?').get(recordingId) as {revision:number;confirmed:number}|undefined;
  const references=this.db.prepare("SELECT provider,external_id,url FROM external_ref WHERE entity_kind='recording' AND entity_id=? ORDER BY provider,external_id").all(recordingId);
  const refState=this.db.prepare("SELECT revision FROM entity_reference_state WHERE entity_kind='recording' AND entity_id=?").get(recordingId);
  return {recordingId,revision:state?.revision??0,confirmed:state?.confirmed===1,title:fields.title,versionLabel:fields.version_label??'',durationUs:fields.duration_us,artists,
   itemCount:members.length,releaseCount:new Set(members.map(m=>m.release_id)).size,
   fingerprint:createHash('sha256').update(JSON.stringify([fields,members,artists,state??null,references,refState??null])).digest('hex')};
 }
 private checked(ref:RecordingProfileRef):RecordingProfile{
  if(!ref||!Number.isSafeInteger(ref.revision)||ref.revision<0||typeof ref.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(ref.fingerprint))throw new Error('无效录音修订');
  const current=this.get(ref.recordingId);if(current.revision!==ref.revision||current.fingerprint!==ref.fingerprint)throw new Error('录音资料、成员、署名或引用已变化，请刷新后重新确认');return current;
 }
 private snapshot(id:string):Snapshot{return {recording:this.get(id),fields:this.row(id),items:this.members(id).map(row=>({itemId:String(row.itemId),revision:Number(row.revision)})),...(this.catalog.metadataProvenanceEnabled?{provenance:provenanceSnapshot(this.db,'recording',id)}:{})};}
 private apply(id:string,fields:Fields,confirmed:boolean):void{
  this.db.prepare('UPDATE recording SET title=?,version_label=?,duration_us=?,artist_credit_id=? WHERE id=?').run(fields.title,fields.version_label,fields.duration_us,fields.artist_credit_id,id);
  this.db.prepare(`INSERT INTO recording_profile_state(recording_id,revision,confirmed) VALUES(?,1,?)
   ON CONFLICT(recording_id) DO UPDATE SET revision=revision+1,confirmed=excluded.confirmed`).run(id,confirmed?1:0);
  for(const member of this.members(id)){this.catalog.refreshRevision(String(member.itemId));this.refreshSearch(String(member.itemId));}
 }
 private save(action:string,title:string,before:Snapshot):CatalogChangeResult{
  const after=this.snapshot(before.recording.recordingId),changeId=randomUUID();
  this.db.prepare('INSERT INTO recording_profile_change(id,action,title,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)').run(changeId,action,title,JSON.stringify(before),JSON.stringify(after),Date.now());return {changeId,items:after.items};
 }
 private command(commandId:string,identity:unknown,action:()=>CatalogChangeResult):CatalogChangeResult{
  if(typeof commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(commandId))throw new Error('无效录音资料命令 ID');
  const fingerprint=createHash('sha256').update(JSON.stringify(['recording-profile',identity])).digest('hex');this.db.exec('BEGIN IMMEDIATE');
  try{const prior=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as {fingerprint:string;result_json:string}|undefined;
   if(prior){if(prior.fingerprint!==fingerprint)throw new Error('命令 ID 已用于不同操作');this.db.exec('COMMIT');return JSON.parse(prior.result_json);}
   const result=action();this.db.prepare('INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)').run(commandId,fingerprint,JSON.stringify(result),new Date().toISOString());this.db.exec('COMMIT');return result;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 edit(request:RecordingProfileRequest):CatalogChangeResult{
  if(!request?.recording)throw new Error('无效录音资料请求');const fields=normalized(request.fields);
  return this.command(request.commandId,[request.recording,fields],()=>{
   const current=this.checked(request.recording);if(current.itemCount>5000)throw new Error('每次录音编辑最多影响 5000 个文件');
   if(current.confirmed&&JSON.stringify([current.title,current.versionLabel,current.durationUs,current.artists.map(m=>({artistId:m.sourceArtistId??m.id,artistRevision:m.artistRevision??0,role:m.role,joinPhrase:m.joinPhrase??'',...(m.creditedName?{creditedName:m.creditedName}:{})}))])===JSON.stringify([fields.title,fields.versionLabel,fields.durationUs,fields.artists]))throw new Error('录音资料没有变化');
   const before=this.snapshot(current.recordingId),resolved=new Set<string>();
   const members=fields.artists.map(member=>{
    const artist=this.db.prepare(`SELECT COALESCE(i.id,a.id) id,COALESCE(i.name,a.name) name,a.archived,COALESCE(i.archived,0) identity_archived,COALESCE(s.revision,0) revision
     FROM artist a LEFT JOIN artist_identity_binding b ON b.source_artist_id=a.id LEFT JOIN artist i ON i.id=b.identity_artist_id
     LEFT JOIN artist_identity_state s ON s.artist_id=a.id WHERE a.id=?`).get(member.artistId) as {id:string;name:string;archived:number;identity_archived:number;revision:number}|undefined;
    if(!artist||artist.archived||artist.identity_archived)throw new Error('录音艺人不存在或已归档');if(artist.revision!==member.artistRevision)throw new Error('录音艺人已变化，请刷新后重新选择');
    const key=JSON.stringify([artist.id,member.role]);if(resolved.has(key))throw new Error('同一录音身份的同一角色重复');resolved.add(key);return {...member,name:artist.name};
   });
   const creditId=randomUUID(),display=members.filter(m=>m.role==='performer').map(m=>(m.creditedName??m.name)+m.joinPhrase).join('');
   this.db.prepare('INSERT INTO artist_credit(id,owner_key,display_text) VALUES(?,?,?)').run(creditId,`manual-recording-credit:${creditId}`,display);
   members.forEach((member,ordinal)=>insertCreditMember(this.db,creditId,ordinal,member));
   this.apply(current.recordingId,{title:fields.title,version_label:fields.versionLabel||null,duration_us:fields.durationUs,artist_credit_id:creditId},true);
   if(this.catalog.metadataProvenanceEnabled)recordManual(this.db,'recording',current.recordingId,before.fields,this.row(current.recordingId),!before.recording.confirmed);
   if(this.catalog.metadataProvenanceEnabled)recordCollectionManual(this.db,'recording',current.recordingId,'artists');
   return this.save('recording-profile',fields.title,before);
  });
 }
 owns(changeId:string):boolean{return Boolean(this.db.prepare('SELECT 1 FROM recording_profile_change WHERE id=?').get(changeId));}
 undo(changeId:string,commandId:string):CatalogChangeResult{
  return this.command(commandId,['undo',changeId],()=>{
   const row=this.db.prepare('SELECT * FROM recording_profile_change WHERE id=?').get(changeId) as {action:string;title:string;before_json:string;after_json:string;undone_at:number|null}|undefined;
   if(!row||row.action==='undo'||row.undone_at!==null)throw new Error('录音修订不存在或已撤销');const before=JSON.parse(row.before_json) as Snapshot,after=JSON.parse(row.after_json) as Snapshot;
   const current=this.checked(after.recording),snapshot=this.snapshot(current.recordingId);
   if(this.catalog.metadataProvenanceEnabled)checkProvenanceUndo(this.db,'recording',current.recordingId,after.provenance);
   this.apply(current.recordingId,before.fields,before.recording.confirmed);
   if(this.catalog.metadataProvenanceEnabled)restoreProvenance(this.db,'recording',current.recordingId,before.provenance);
   this.db.prepare('UPDATE recording_profile_change SET undone_at=? WHERE id=?').run(Date.now(),changeId);return this.save('undo',row.title,snapshot);
  });
 }
}
