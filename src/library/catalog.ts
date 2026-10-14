import {sqlStatement} from './sql-statements.js';
import {creditCollection,recordCollectionAutomatic,protectCollections} from './metadata-collections.js';
import {ensureGenre} from './genres.js';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ArtistRole, ArtistCreditMember, CatalogItem, CatalogFacet } from '../shared/contracts.js';
import {readCredit} from './artist-credit.js';
import {recordCandidate,recordItemFile} from './metadata-provenance.js';

export interface CatalogTags {
  artists?:string[]; albumArtists?:string[]; albumArtist?:string; composers?:string[];
  conductors?:string[]; orchestras?:string[]; genres?:string[]; isrcs?:string[];
  date?:string; country?:string; edition?:string; label?:string; catalogNumber?:string; barcode?:string;
  fieldOrigins?:Partial<Record<'title'|'artist'|'album','file-tag'|'cue'|'filename'|'missing'>>;
}
const norm=(value:string)=>value.normalize('NFKC').toLowerCase().trim();
export const artistRoles:ArtistRole[]=['performer','album_artist','composer','conductor','orchestra'];
const names=(values:string[]|undefined):string[]=>[...new Set((values??[]).filter(value=>typeof value==='string').map(value=>value.trim().slice(0,4096)).filter(Boolean))].slice(0,64);
const text=(value:unknown):string|null=>typeof value==='string'&&value.trim()?value.trim().slice(0,4096):null;

export const catalogSchema=`
  CREATE TABLE artist(id TEXT PRIMARY KEY,name TEXT NOT NULL,sort_name TEXT,normalized_name TEXT NOT NULL,
    disambiguation TEXT NOT NULL DEFAULT 'local-tag-candidate',local_key TEXT UNIQUE);
  CREATE INDEX idx_artist_name ON artist(normalized_name,id);
  CREATE TABLE artist_credit(id TEXT PRIMARY KEY,owner_key TEXT NOT NULL UNIQUE,display_text TEXT NOT NULL);
  CREATE TABLE artist_credit_member(credit_id TEXT NOT NULL REFERENCES artist_credit(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),artist_id TEXT NOT NULL REFERENCES artist(id),
    role TEXT NOT NULL CHECK(role IN ('performer','album_artist','composer','conductor','orchestra')),join_phrase TEXT,
    PRIMARY KEY(credit_id,ordinal));
  CREATE INDEX idx_credit_artist ON artist_credit_member(artist_id,role,credit_id);
  CREATE TABLE release_group(id TEXT PRIMARY KEY,title TEXT NOT NULL,type TEXT);
  CREATE TABLE release(id TEXT PRIMARY KEY,group_id TEXT REFERENCES release_group(id),
    artist_credit_id TEXT REFERENCES artist_credit(id),title TEXT NOT NULL,date TEXT,country TEXT,label TEXT,
    catalog_no TEXT,barcode TEXT,edition TEXT,root_id TEXT NOT NULL REFERENCES library_root(id),
    local_context TEXT NOT NULL,local_key TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0));
  CREATE TABLE medium(id TEXT PRIMARY KEY,release_id TEXT NOT NULL REFERENCES release(id),
    disc_no INTEGER NOT NULL CHECK(disc_no>0),title TEXT,format TEXT,UNIQUE(release_id,disc_no));
  CREATE TABLE recording(id TEXT PRIMARY KEY,title TEXT NOT NULL,artist_credit_id TEXT REFERENCES artist_credit(id),
    duration_us INTEGER CHECK(duration_us IS NULL OR duration_us>=0),version_label TEXT,local_key TEXT UNIQUE);
  CREATE TABLE release_track(id TEXT PRIMARY KEY,medium_id TEXT NOT NULL REFERENCES medium(id),
    position INTEGER NOT NULL CHECK(position>0),printed_number TEXT,recording_id TEXT REFERENCES recording(id),
    artist_credit_id TEXT REFERENCES artist_credit(id),title TEXT NOT NULL,local_key TEXT NOT NULL UNIQUE,
    UNIQUE(medium_id,position));
  CREATE TABLE genre(id TEXT PRIMARY KEY,name TEXT NOT NULL,normalized_name TEXT NOT NULL UNIQUE,parent_id TEXT REFERENCES genre(id));
  CREATE TABLE item_genre(item_id TEXT NOT NULL REFERENCES playable_item(id) ON DELETE RESTRICT,
    genre_id TEXT NOT NULL REFERENCES genre(id),source TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
    PRIMARY KEY(item_id,genre_id,source));
  CREATE INDEX idx_genre_item ON item_genre(genre_id,item_id);
  CREATE TABLE release_genre(release_id TEXT NOT NULL REFERENCES release(id),genre_id TEXT NOT NULL REFERENCES genre(id),
    source TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),PRIMARY KEY(release_id,genre_id,source));
  CREATE TABLE item_catalog_source(item_id TEXT PRIMARY KEY REFERENCES playable_item(id) ON DELETE RESTRICT,json TEXT NOT NULL CHECK(json_valid(json)));
  ALTER TABLE playable_item ADD COLUMN recording_id TEXT REFERENCES recording(id);
  ALTER TABLE playable_item ADD COLUMN release_track_id TEXT REFERENCES release_track(id);
  ALTER TABLE playable_item ADD COLUMN artist_credit_id TEXT REFERENCES artist_credit(id);
  CREATE INDEX idx_item_release_track ON playable_item(release_track_id,id);
`;

export const catalogAssociationSchema=`
  CREATE UNIQUE INDEX idx_track_recording ON release_track(id,recording_id);
  CREATE TABLE item_catalog_binding(item_id TEXT PRIMARY KEY REFERENCES playable_item(id) ON DELETE RESTRICT,
    recording_id TEXT NOT NULL REFERENCES recording(id),release_track_id TEXT NOT NULL REFERENCES release_track(id),
    FOREIGN KEY(release_track_id,recording_id) REFERENCES release_track(id,recording_id));
  CREATE TABLE item_catalog_state(item_id TEXT PRIMARY KEY REFERENCES playable_item(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(revision>=0),fingerprint TEXT NOT NULL);
  CREATE TABLE catalog_change(id TEXT PRIMARY KEY,action TEXT NOT NULL CHECK(action IN ('recording','version','reset','group','undo')),
    before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),
    created_at INTEGER NOT NULL,undone_at INTEGER);
  CREATE INDEX idx_item_recording ON playable_item(recording_id,id);
`;

// This repository is called inside the owning LibraryDatabase transaction.
// Tag candidates have local identities; equal names/titles do not prove global identity.
export class CatalogRepository {
  private associationsReady=false;
  private artistsReady=false;
  private releasesReady=false;
  private profilesReady=false;
  private releaseProfilesReady=false;
  private recordingProfilesReady=false;
  private metadataReady=false;
  private genresReady=false;
  private creditNamesReady=false;
  constructor(private readonly db:DatabaseSync){}
  enableAssociations():void {this.associationsReady=true;}
  enableArtists():void {this.artistsReady=true;}
  enableReleases():void {this.releasesReady=true;}
  enableProfiles():void {this.profilesReady=true;}
  enableReleaseProfiles():void {this.releaseProfilesReady=true;}
  enableRecordingProfiles():void {this.recordingProfilesReady=true;}
  enableMetadataProvenance():void {this.metadataReady=true;}
  enableGenreHierarchy():void {this.genresReady=true;}
  enableCreditNames():void {this.creditNamesReady=true;}
  get metadataProvenanceEnabled():boolean{return this.metadataReady;}
  get recordingProfilesEnabled():boolean {return this.recordingProfilesReady;}
  recordingArtistCreditIdSql():string {return this.recordingProfilesReady?`(SELECT rec.artist_credit_id FROM recording rec LEFT JOIN recording_profile_state rp ON rp.recording_id=rec.id WHERE rec.id=p.recording_id AND (rp.confirmed=1${this.metadataReady?" OR EXISTS(SELECT 1 FROM metadata_collection_state cs WHERE cs.entity_kind='recording' AND cs.entity_id=rec.id AND cs.field='artists' AND (cs.mode IS NOT NULL OR cs.locked=1))":''}))`:'NULL';}
  recordingArtistSelectionIdsSql():string {return this.recordingProfilesReady?`SELECT recording_id FROM recording_profile_state WHERE confirmed=1${this.metadataReady?" UNION SELECT entity_id recording_id FROM metadata_collection_state NOT INDEXED WHERE entity_kind='recording' AND field='artists' AND (mode IS NOT NULL OR locked=1)":''}`:'SELECT NULL recording_id WHERE 0';}
  recordingCreditCondition():string {return this.recordingProfilesReady?` OR c.credit_id=${this.recordingArtistCreditIdSql()}`:'';}

  private credit(owner:string,rootId:string,display:string,members:Array<{name:string;role:ArtistRole}>):string {
    const old=sqlStatement(this.db,'SELECT id FROM artist_credit WHERE owner_key=?').get(owner) as {id:string}|undefined;
    const id=old?.id??randomUUID();
    sqlStatement(this.db,`INSERT INTO artist_credit(id,owner_key,display_text) VALUES(?,?,?)
      ON CONFLICT(owner_key) DO UPDATE SET display_text=excluded.display_text`).run(id,owner,display);
    sqlStatement(this.db,'DELETE FROM artist_credit_member WHERE credit_id=?').run(id);
    members.forEach((member,ordinal)=>{
      // Scope unverified name identities to the authorized root, preserving case and spelling.
      const key=JSON.stringify([rootId,member.name]);
      const artist=sqlStatement(this.db,'SELECT id FROM artist WHERE local_key=?').get(key) as {id:string}|undefined;
      const artistId=artist?.id??randomUUID();
      if(!artist)sqlStatement(this.db,'INSERT INTO artist(id,name,normalized_name,local_key) VALUES(?,?,?,?)').run(artistId,member.name,norm(member.name),key);
      if(!artist&&this.metadataReady)recordCandidate(this.db,'artist',artistId);
      sqlStatement(this.db,'INSERT INTO artist_credit_member(credit_id,ordinal,artist_id,role,join_phrase) VALUES(?,?,?,?,NULL)').run(id,ordinal,artistId,member.role);
    });
    return id;
  }

  sync(itemId:string,tags?:CatalogTags):void {
    if(tags)sqlStatement(this.db,`INSERT INTO item_catalog_source(item_id,json) VALUES(?,?)
      ON CONFLICT(item_id) DO UPDATE SET json=excluded.json`).run(itemId,JSON.stringify(tags));
    const row=sqlStatement(this.db,`SELECT p.*,f.root_id,f.relative_path,f.duration_seconds,
      COALESCE(o.title,p.title) effective_title,COALESCE(o.artist,p.artist) effective_artist,
      COALESCE(o.album,p.album) effective_album,o.artist override_artist,s.json
      FROM playable_item p JOIN media_file f ON f.id=p.file_id
      LEFT JOIN metadata_override o ON o.item_id=p.id LEFT JOIN item_catalog_source s ON s.item_id=p.id WHERE p.id=?`).get(itemId) as
      {root_id:string;relative_path:string;title:string;artist:string;album:string;genre:string;kind:string;cue_key:string|null;
        effective_title:string;effective_artist:string;effective_album:string;override_artist:string|null;
        disc_number:number|null;track_number:number|null;duration_seconds:number|null;start_seconds:number;end_seconds:number|null;
        recording_id:string|null;json:string|null}|undefined;
    if(!row)throw new Error('曲目不存在');
    const source:CatalogTags=row.json?JSON.parse(row.json):{};
    const performers=row.override_artist!==null?[row.effective_artist].filter(value=>value.trim()):names(source.artists).length?names(source.artists):[row.artist];
    const roles:Array<{name:string;role:ArtistRole}>=[...performers.map(name=>({name,role:'performer' as const})),
      ...names(source.composers).map(name=>({name,role:'composer' as const})),
      ...names(source.conductors).map(name=>({name,role:'conductor' as const})),
      ...names(source.orchestras).map(name=>({name,role:'orchestra' as const}))];
    const credit=this.credit(`item:${itemId}`,row.root_id,row.effective_artist,roles);
    const albumNames=names(source.albumArtists).length?names(source.albumArtists):text(source.albumArtist)?[source.albumArtist!.trim()]:[];
    let context=path.dirname(row.relative_path);
    const disc=Math.max(1,Math.trunc(row.disc_number??1));
    const discFolder=/^(?:cd|disc|disk|碟)[ _-]*(\d+)$/i.exec(path.basename(context));
    if(discFolder&&row.disc_number!==null&&Number(discFolder[1])===disc)context=path.dirname(context);
    // Unknown albums are independent candidates. A CUE document supplies its own album context.
    const unknown=row.effective_album==='未知专辑'||!row.effective_album.trim();
    const key=JSON.stringify([row.root_id,context,row.effective_album,albumNames,
      text(source.date),text(source.country),text(source.edition),text(source.label),text(source.catalogNumber),text(source.barcode),
      unknown?(row.kind==='cue'?row.cue_key?.split(':')[0]:itemId):null]);
    const oldRelease=sqlStatement(this.db,'SELECT id FROM release WHERE local_key=?').get(key) as {id:string}|undefined;
    const releaseId=oldRelease?.id??randomUUID();
    if(!oldRelease){
      const albumCredit=this.credit(`release:${releaseId}`,row.root_id,text(source.albumArtist)??albumNames.join('、'),albumNames.map(name=>({name,role:'album_artist'})));
      sqlStatement(this.db,`INSERT INTO release(id,artist_credit_id,title,date,country,label,catalog_no,barcode,edition,root_id,local_context,local_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(releaseId,albumCredit,row.effective_album.trim()?row.effective_album:'未知专辑',text(source.date),text(source.country),text(source.label),
          text(source.catalogNumber),text(source.barcode),text(source.edition),row.root_id,context,key);
      if(this.metadataReady){recordCandidate(this.db,'release',releaseId);recordCollectionAutomatic(this.db,'release',releaseId,'albumArtists',creditCollection(this.db,albumCredit));}
    }
    const oldMedium=sqlStatement(this.db,'SELECT id FROM medium WHERE release_id=? AND disc_no=?').get(releaseId,disc) as {id:string}|undefined;
    const mediumId=oldMedium?.id??randomUUID();
    if(!oldMedium)sqlStatement(this.db,'INSERT INTO medium(id,release_id,disc_no) VALUES(?,?,?)').run(mediumId,releaseId,disc);
    const localRecording=sqlStatement(this.db,'SELECT id FROM recording WHERE local_key=?').get(`item:${itemId}`) as {id:string}|undefined;
    const recordingId=localRecording?.id??row.recording_id??randomUUID();
    const duration=row.end_seconds??row.duration_seconds;
    const measured=duration===null?null:Math.max(0,Math.round((duration-row.start_seconds)*1e6));
    const durationUs=measured!==null&&Number.isSafeInteger(measured)?measured:null;
    const confirmed=this.recordingProfilesReady?'EXISTS(SELECT 1 FROM recording_profile_state rp WHERE rp.recording_id=recording.id AND rp.confirmed=1)':'0';
    const pinned=(field:string)=>this.metadataReady?`EXISTS(SELECT 1 FROM field_decision WHERE entity_kind='recording' AND entity_id=recording.id AND field='${field}' AND locked=1) OR EXISTS(SELECT 1 FROM metadata_selection WHERE entity_kind='recording' AND entity_id=recording.id AND field='${field}' AND mode IN('observation','clear'))`:'0';
    const automatic=(field:string)=>this.metadataReady?`EXISTS(SELECT 1 FROM metadata_selection WHERE entity_kind='recording' AND entity_id=recording.id AND field='${field}' AND mode='automatic')`:'0';
    sqlStatement(this.db,`INSERT INTO recording(id,title,artist_credit_id,duration_us,local_key) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
      title=CASE WHEN (${pinned('title')}) OR (${confirmed} AND NOT ${automatic('title')}) THEN recording.title ELSE excluded.title END,
      duration_us=CASE WHEN (${pinned('durationUs')}) OR (${confirmed} AND NOT ${automatic('durationUs')}) THEN recording.duration_us ELSE excluded.duration_us END,
      version_label=CASE WHEN ${automatic('versionLabel')} AND NOT (${pinned('versionLabel')}) THEN NULL ELSE recording.version_label END,
      artist_credit_id=CASE WHEN (${confirmed} AND NOT (${this.metadataReady?"EXISTS(SELECT 1 FROM metadata_collection_state ca WHERE ca.entity_kind='recording' AND ca.entity_id=recording.id AND ca.field='artists' AND ca.mode='automatic')":'0'}))${this.metadataReady?" OR EXISTS(SELECT 1 FROM metadata_collection_state cs WHERE cs.entity_kind='recording' AND cs.entity_id=recording.id AND cs.field='artists' AND (cs.locked=1 OR cs.mode IS NOT NULL AND cs.mode!='automatic'))":''} THEN recording.artist_credit_id ELSE excluded.artist_credit_id END`)
      .run(recordingId,row.effective_title,credit,durationUs,`item:${itemId}`);
    if(this.metadataReady){recordCandidate(this.db,'recording',recordingId,{title:row.effective_title,durationUs,versionLabel:null});recordCollectionAutomatic(this.db,'recording',recordingId,'artists',creditCollection(this.db,credit));protectCollections(this.db,'recording',recordingId);}
    const oldTrack=sqlStatement(this.db,'SELECT id,medium_id,position FROM release_track WHERE local_key=?').get(itemId) as {id:string;medium_id:string;position:number}|undefined;
    const trackId=oldTrack?.id??randomUUID();
    const position=oldTrack?.medium_id===mediumId?oldTrack.position:
      Number((sqlStatement(this.db,'SELECT COALESCE(MAX(position),0)+1 position FROM release_track WHERE medium_id=?').get(mediumId) as {position:number}).position);
    const ownedTrack=this.associationsReady?sqlStatement(this.db,'SELECT release_track_id FROM item_catalog_binding WHERE item_id=?').get(itemId) as {release_track_id:string}|undefined:undefined;
    // A reviewed association can pin the original candidate without changing
    // its UUID. Do not move that same track to a newly derived tag release.
    if(!oldTrack||ownedTrack?.release_track_id!==oldTrack.id)sqlStatement(this.db,`INSERT INTO release_track(id,medium_id,position,printed_number,recording_id,artist_credit_id,title,local_key) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(local_key) DO UPDATE SET medium_id=excluded.medium_id,position=excluded.position,printed_number=excluded.printed_number,
      recording_id=excluded.recording_id,artist_credit_id=excluded.artist_credit_id,title=excluded.title`)
      .run(trackId,mediumId,position,row.track_number===null?null:String(row.track_number),recordingId,credit,row.effective_title,itemId);
    sqlStatement(this.db,'UPDATE playable_item SET recording_id=?,release_track_id=?,artist_credit_id=? WHERE id=?').run(recordingId,trackId,credit,itemId);
    sqlStatement(this.db,"DELETE FROM item_genre WHERE item_id=? AND source='file-tag'").run(itemId);
    const observedGenres:Array<{id:string;name:string;source:string}>=[];
    for(const name of names(source.genres??(row.genre?[row.genre]:[]))){
      const genreId=ensureGenre(this.db,name,this.genresReady).id;
      sqlStatement(this.db,"INSERT OR IGNORE INTO item_genre(item_id,genre_id,source) VALUES(?,?,'file-tag')").run(itemId,genreId);
      if(!observedGenres.some(value=>value.id===genreId))observedGenres.push({id:genreId,name,source:'file-tag'});
    }
    if(this.metadataReady){recordItemFile(this.db,itemId,source.fieldOrigins);recordCollectionAutomatic(this.db,'playable_item',itemId,'artists',creditCollection(this.db,credit),row.kind==='cue'&&row.override_artist===null?'cue':'local-candidate');
      recordCollectionAutomatic(this.db,'playable_item',itemId,'genres',observedGenres,row.kind==='cue'?'cue':'file-tag');protectCollections(this.db,'playable_item',itemId);}
    if(this.associationsReady){
      const binding=sqlStatement(this.db,'SELECT recording_id,release_track_id FROM item_catalog_binding WHERE item_id=?').get(itemId) as {recording_id:string;release_track_id:string}|undefined;
      if(binding)sqlStatement(this.db,'UPDATE playable_item SET recording_id=?,release_track_id=? WHERE id=?').run(binding.recording_id,binding.release_track_id,itemId);
      if(this.artistsReady){
        const manual=sqlStatement(this.db,'SELECT credit_id FROM item_credit_binding WHERE item_id=?').get(itemId) as {credit_id:string}|undefined;
        if(manual)sqlStatement(this.db,'UPDATE playable_item SET artist_credit_id=? WHERE id=?').run(manual.credit_id,itemId);
      }
      this.refreshRevision(itemId);
    }
  }

  refreshRevision(itemId:string,preserveRevision=false):number {
    const item=this.project([itemId]).get(itemId);
    if(!item)throw new Error('曲库关联不存在');
    const row=sqlStatement(this.db,`SELECT COALESCE(o.title,p.title) title,COALESCE(o.artist,p.artist) artist,
      COALESCE(o.album,p.album) album,p.disc_number,p.track_number,p.start_cue_frame,p.end_cue_frame,p.visible
      FROM playable_item p LEFT JOIN metadata_override o ON o.item_id=p.id WHERE p.id=?`).get(itemId);
    const {revision,...identity}=item;
    const sampleSpan=sqlStatement(this.db,'SELECT s.stream_id,s.start_tick,s.end_tick,s.time_base_num,s.time_base_den FROM playable_span s JOIN playable_item p ON p.id=s.item_id WHERE s.item_id=? AND s.ordinal=0 AND p.kind=\'cue\' AND s.time_base_den<>75').get(itemId);
    const codeSource=sqlStatement(this.db,"SELECT json_extract(json,'$.isrcs') raw FROM item_catalog_source WHERE item_id=?").get(itemId) as {raw:string|null}|undefined;
    const payload:unknown[]=sampleSpan?[row,identity,{sampleSpan}]:[row,identity];if(codeSource?.raw&&codeSource.raw!=='[]')payload.push({isrcSource:createHash('sha256').update(codeSource.raw).digest('hex')});
    const fingerprint=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const old=sqlStatement(this.db,'SELECT revision,fingerprint FROM item_catalog_state WHERE item_id=?').get(itemId) as {revision:number;fingerprint:string}|undefined;
    const next=old?old.revision+(old.fingerprint===fingerprint||preserveRevision?0:1):0;
    sqlStatement(this.db,`INSERT INTO item_catalog_state(item_id,revision,fingerprint) VALUES(?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint`).run(itemId,next,fingerprint);
    return next;
  }

  backfill():void {
    const rows=sqlStatement(this.db,'SELECT id FROM playable_item ORDER BY id').all() as unknown as Array<{id:string}>;
    for(const row of rows)this.sync(row.id);
  }

  project(ids:string[]):Map<string,CatalogItem>{
    const result=new Map<string,CatalogItem>();
    if(!ids.length)return result;
    const placeholders=ids.map(()=>'?').join(',');
    const rows=sqlStatement(this.db,`SELECT p.id,p.recording_id,p.release_track_id,r.id release_id,r.date,r.edition,r.country,r.local_context,r.label,r.catalog_no,r.barcode,
      ${this.releaseProfilesReady?'EXISTS(SELECT 1 FROM release_profile_state ps WHERE ps.release_id=r.id)':'0'} profile_confirmed,
      rec.title recording_title,r.title release_title,t.title track_title,r.revision release_revision,r.group_id,g.title group_title,
      ${this.associationsReady?'COALESCE(s.revision,0) revision,b.item_id IS NOT NULL confirmed':'0 revision,0 confirmed'},
      c.display_text album_artist,m.disc_no,t.position,t.printed_number,r.local_key release_key FROM playable_item p JOIN release_track t ON t.id=p.release_track_id
      JOIN medium m ON m.id=t.medium_id JOIN release r ON r.id=m.release_id LEFT JOIN artist_credit c ON c.id=r.artist_credit_id
      JOIN recording rec ON rec.id=p.recording_id LEFT JOIN release_group g ON g.id=r.group_id
      ${this.associationsReady?'LEFT JOIN item_catalog_state s ON s.item_id=p.id LEFT JOIN item_catalog_binding b ON b.item_id=p.id':''}
      WHERE p.id IN (${placeholders})`).all(...ids) as unknown as Array<Record<string,unknown>>;
    for(const row of rows)result.set(String(row.id),{recordingId:String(row.recording_id),releaseTrackId:String(row.release_track_id),releaseId:String(row.release_id),
      albumArtist:String(row.album_artist??''),releaseDate:row.date as string|null,edition:row.edition as string|null,country:row.country as string|null,
      releaseContext:String(row.local_context),artists:[],albumArtists:[],genres:[],revision:Number(row.revision),releaseRevision:Number(row.release_revision),
      confirmed:Number(row.confirmed)===1,recordingTitle:String(row.recording_title),releaseTitle:String(row.release_title),releaseTrackTitle:String(row.track_title),
      groupId:row.group_id as string|null,groupTitle:row.group_title as string|null,
      ...(this.releasesReady?{mediumDiscNumber:Number(row.disc_no),trackPosition:Number(row.position),printedNumber:row.printed_number as string|null,releaseConfirmed:String(row.release_key).startsWith('manual-release:')}:{ }),
      ...(this.releaseProfilesReady?{releaseLabel:row.label as string|null,catalogNumber:row.catalog_no as string|null,barcode:row.barcode as string|null,releaseProfileConfirmed:Number(row.profile_confirmed)===1}:{})});
    if(this.recordingProfilesReady){
      const recordingIds=[...new Set([...result.values()].map(item=>item.recordingId))];
      const profiles=sqlStatement(this.db,`SELECT rec.id,rec.version_label,rec.duration_us,rec.artist_credit_id FROM recording rec
        JOIN recording_profile_state rp ON rp.recording_id=rec.id AND rp.confirmed=1 WHERE rec.id IN(${recordingIds.map(()=>'?').join(',')})`)
        .all(...recordingIds) as unknown as Array<{id:string;version_label:string|null;duration_us:number|null;artist_credit_id:string|null}>;
      const byRecording=new Map(profiles.map(profile=>[profile.id,{recordingVersionLabel:profile.version_label,recordingDurationUs:profile.duration_us,recordingArtists:readCredit(this.db,profile.artist_credit_id),recordingProfileConfirmed:true}]));
      for(const item of result.values()){const profile=byRecording.get(item.recordingId);if(profile)Object.assign(item,profile);}
      if(this.metadataReady){
        const credits=sqlStatement(this.db,`SELECT rec.id,rec.artist_credit_id FROM recording rec JOIN metadata_collection_state cs ON cs.entity_kind='recording' AND cs.entity_id=rec.id AND cs.field='artists' WHERE rec.id IN(${recordingIds.map(()=>'?').join(',')}) AND (cs.mode IS NOT NULL OR cs.locked=1)`).all(...recordingIds) as unknown as Array<{id:string;artist_credit_id:string|null}>;
        for(const row of credits)for(const item of result.values())if(item.recordingId===row.id)Object.assign(item,{recordingArtists:readCredit(this.db,row.artist_credit_id)});
        const selected=sqlStatement(this.db,`SELECT rec.id,rec.version_label,rec.duration_us FROM recording rec WHERE rec.id IN(${recordingIds.map(()=>'?').join(',')})
          AND EXISTS(SELECT 1 FROM metadata_selection ms WHERE ms.entity_kind='recording' AND ms.entity_id=rec.id)`)
          .all(...recordingIds) as unknown as Array<{id:string;version_label:string|null;duration_us:number|null}>;
        for(const row of selected)for(const item of result.values())if(item.recordingId===row.id)Object.assign(item,{recordingVersionLabel:row.version_label,recordingDurationUs:row.duration_us,recordingSourceSelected:true});
      }
    }
    const artistJoin=this.artistsReady?'LEFT JOIN artist_identity_binding ai ON ai.source_artist_id=c.artist_id JOIN artist a ON a.id=COALESCE(ai.identity_artist_id,c.artist_id)':'JOIN artist a ON a.id=c.artist_id';
    const artistRevision=this.artistsReady?'COALESCE((SELECT revision FROM artist_identity_state WHERE artist_id=c.artist_id),0)':'0';
    const creditName=this.creditNamesReady?'c.credited_name':'NULL';
    const members=sqlStatement(this.db,`SELECT p.id item_id,'track' credit_type,a.id,a.name,c.artist_id source_id,c.role,c.ordinal,c.join_phrase,${artistRevision} artist_revision,a.disambiguation,a.sort_name,${creditName} credited_name
      FROM playable_item p JOIN artist_credit_member c ON c.credit_id=p.artist_credit_id ${artistJoin} WHERE p.id IN (${placeholders})
      UNION ALL SELECT p.id,'album',a.id,a.name,c.artist_id,c.role,c.ordinal,c.join_phrase,${artistRevision},a.disambiguation,a.sort_name,${creditName} FROM playable_item p
      JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id JOIN release r ON r.id=m.release_id
      JOIN artist_credit_member c ON c.credit_id=r.artist_credit_id ${artistJoin} WHERE p.id IN (${placeholders})
      ORDER BY ordinal`).all(...ids,...ids) as unknown as Array<{item_id:string;credit_type:string;id:string;name:string;source_id:string;role:ArtistRole;ordinal:number;join_phrase:string|null;artist_revision:number;disambiguation:string;sort_name:string|null;credited_name:string|null}>;
    for(const row of members){const item=result.get(row.item_id);if(item)(row.credit_type==='track'?item.artists:item.albumArtists).push({id:row.id,name:row.name,role:row.role,ordinal:row.ordinal,joinPhrase:row.join_phrase,...(this.creditNamesReady&&row.credited_name!==null?{creditedName:row.credited_name}:{}),...(this.artistsReady?{sourceArtistId:row.source_id,artistRevision:Number(row.artist_revision)}:{}),...(this.profilesReady?{disambiguation:row.disambiguation,sortName:row.sort_name}:{})});}
    if(this.artistsReady){
      const credits=sqlStatement(this.db,`SELECT p.id,c.display_text,b.item_id manual FROM playable_item p JOIN artist_credit c ON c.id=p.artist_credit_id
        LEFT JOIN item_credit_binding b ON b.item_id=p.id WHERE p.id IN (${placeholders})`).all(...ids) as unknown as Array<{id:string;display_text:string;manual:string|null}>;
      for(const row of credits){const item=result.get(row.id)!;
        const performers=item.artists.filter(member=>member.role==='performer');
        item.creditConfirmed=row.manual!==null;
        item.artistDisplay=row.manual!==null||performers.length===1&&performers.some(member=>member.id!==member.sourceArtistId)?
          performers.map((member,index)=>(member.creditedName??member.name)+(member.joinPhrase??(index<performers.length-1?'、':''))).join(''):row.display_text;
        item.albumArtist=item.albumArtists.map((member,index)=>(member.creditedName??member.name)+(member.joinPhrase??(index<item.albumArtists.length-1?'、':''))).join('');
      }
    }
    const genres=sqlStatement(this.db,`SELECT i.item_id,g.id,g.name,i.source FROM item_genre i JOIN genre g ON g.id=i.genre_id
      WHERE i.item_id IN (${placeholders})
      UNION ALL SELECT p.id,g.id,g.name,'release:'||rg.source FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id JOIN release_genre rg ON rg.release_id=m.release_id JOIN genre g ON g.id=rg.genre_id WHERE p.id IN (${placeholders}) ORDER BY name`).all(...ids,...ids) as unknown as Array<{item_id:string;id:string;name:string;source:string}>;
    for(const row of genres)result.get(row.item_id)?.genres.push({id:row.id,name:row.name,source:row.source});
    return result;
  }

  facets(view:'artists'|'albums'|'albumGroups'|'genres',role:ArtistRole='performer'):CatalogFacet[]{
    if(!artistRoles.includes(role))throw new Error('无效艺人角色');
    const visible="p.visible=1 AND p.library_state='active'";
    if(view==='artists')return sqlStatement(this.db,`SELECT a.id,a.name,COUNT(DISTINCT p.id) count,
      ${this.profilesReady?"CASE WHEN a.local_key IS NULL AND a.disambiguation NOT IN('','user-confirmed') THEN a.disambiguation||' · '||MAX(lr.path) ELSE MAX(lr.path) END":"MAX(lr.path)"} subtitle
      FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id JOIN release r ON r.id=m.release_id
      JOIN library_root lr ON lr.id=r.root_id
      JOIN artist_credit_member c ON (c.credit_id=${role==='album_artist'?'r.artist_credit_id':'p.artist_credit_id'}${role==='album_artist'?'':this.recordingCreditCondition()})
      ${this.artistsReady?'LEFT JOIN artist_identity_binding ai ON ai.source_artist_id=c.artist_id JOIN artist a ON a.id=COALESCE(ai.identity_artist_id,c.artist_id)':'JOIN artist a ON a.id=c.artist_id'}
      WHERE ${visible} AND c.role=? GROUP BY a.id ORDER BY count DESC,a.name,a.id LIMIT 200`)
      .all(role) as unknown as CatalogFacet[];
    if(view==='genres')return sqlStatement(this.db,`SELECT g.id,g.name,COUNT(DISTINCT p.id) count FROM playable_item p
      JOIN (SELECT item_id,genre_id FROM item_genre UNION SELECT p.id,rg.genre_id FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id JOIN release_genre rg ON rg.release_id=m.release_id) memberships ON memberships.item_id=p.id JOIN genre g ON g.id=memberships.genre_id WHERE ${visible} GROUP BY g.id ORDER BY count DESC,g.name LIMIT 200`).all() as unknown as CatalogFacet[];
    if(view==='albumGroups')return sqlStatement(this.db,`SELECT g.id,g.title name,COUNT(DISTINCT p.id) count,
      CAST(COUNT(DISTINCT r.id) AS TEXT)||' 个发行版' subtitle FROM playable_item p
      JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id JOIN release r ON r.id=m.release_id
      JOIN release_group g ON g.id=r.group_id WHERE ${visible} GROUP BY g.id ORDER BY count DESC,g.title,g.id LIMIT 200`).all() as unknown as CatalogFacet[];
    return sqlStatement(this.db,`SELECT r.id,r.title name,COUNT(DISTINCT p.id) count,
      TRIM(COALESCE(c.display_text,'')||' · '||COALESCE(r.date,'')||' · '||COALESCE(r.edition,'')||' · '||lr.path||' / '||r.local_context,' ·') subtitle
      FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id
      JOIN release r ON r.id=m.release_id JOIN library_root lr ON lr.id=r.root_id LEFT JOIN artist_credit c ON c.id=r.artist_credit_id WHERE ${visible}
      GROUP BY r.id ORDER BY count DESC,r.title,r.id LIMIT 200`).all() as unknown as CatalogFacet[];
  }
}
