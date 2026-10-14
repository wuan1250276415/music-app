import {provenanceSnapshot,recordManual,checkProvenanceUndo,restoreProvenance,type ProvenanceSnapshot} from './metadata-provenance.js';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {ArtistProfile,ArtistProfileFields,ArtistProfileRef,ArtistProfileRequest,CatalogChangeResult,ExternalReference} from '../shared/contracts.js';
import {CatalogRepository} from './catalog.js';
import {normalizedReferences,referenceOrder,safeReferenceUrl as safeUrl} from './external-references.js';

export const artistProfileSchema=`
  ALTER TABLE artist ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1) AND (archived=0 OR local_key IS NULL));
  CREATE INDEX idx_artist_active ON artist(archived,normalized_name,id);
  CREATE TABLE external_ref(entity_kind TEXT NOT NULL CHECK(entity_kind IN('artist','recording','release','release_group')),
    entity_id TEXT NOT NULL,provider TEXT NOT NULL,external_id TEXT NOT NULL,url TEXT,
    PRIMARY KEY(entity_kind,entity_id,provider,external_id),UNIQUE(entity_kind,provider,external_id));
  CREATE INDEX idx_external_entity ON external_ref(entity_kind,entity_id);
  CREATE TRIGGER external_ref_insert BEFORE INSERT ON external_ref BEGIN
    SELECT CASE WHEN NOT((NEW.entity_kind='artist' AND EXISTS(SELECT 1 FROM artist WHERE id=NEW.entity_id AND local_key IS NULL AND archived=0))
      OR (NEW.entity_kind='recording' AND EXISTS(SELECT 1 FROM recording WHERE id=NEW.entity_id))
      OR (NEW.entity_kind='release' AND EXISTS(SELECT 1 FROM release WHERE id=NEW.entity_id))
      OR (NEW.entity_kind='release_group' AND EXISTS(SELECT 1 FROM release_group WHERE id=NEW.entity_id))) THEN RAISE(ABORT,'invalid external entity') END;
  END;
  CREATE TRIGGER external_ref_update BEFORE UPDATE ON external_ref BEGIN
    SELECT RAISE(ABORT,'replace external references through an owned command');
  END;
  CREATE TRIGGER artist_identity_active_insert BEFORE INSERT ON artist_identity_binding BEGIN
    SELECT CASE WHEN (SELECT archived FROM artist WHERE id=NEW.identity_artist_id)=1 THEN RAISE(ABORT,'艺人已归档，请先恢复') END;
  END;
  CREATE TRIGGER artist_identity_active_update BEFORE UPDATE ON artist_identity_binding BEGIN
    SELECT CASE WHEN (SELECT archived FROM artist WHERE id=NEW.identity_artist_id)=1 THEN RAISE(ABORT,'艺人已归档，请先恢复') END;
  END;
  CREATE TRIGGER artist_credit_active_insert BEFORE INSERT ON artist_credit_member BEGIN
    SELECT CASE WHEN (SELECT archived FROM artist WHERE id=NEW.artist_id)=1 THEN RAISE(ABORT,'艺人已归档，请先恢复') END;
  END;
  CREATE TRIGGER artist_credit_active_update BEFORE UPDATE ON artist_credit_member BEGIN
    SELECT CASE WHEN (SELECT archived FROM artist WHERE id=NEW.artist_id)=1 THEN RAISE(ABORT,'艺人已归档，请先恢复') END;
  END;
  CREATE TRIGGER playable_credit_active_update BEFORE UPDATE OF artist_credit_id ON playable_item BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM artist_credit_member c JOIN artist a ON a.id=c.artist_id
      WHERE c.credit_id=NEW.artist_credit_id AND a.archived=1) THEN RAISE(ABORT,'署名包含已归档艺人，请先恢复') END;
  END;
  CREATE TRIGGER playable_credit_active_insert BEFORE INSERT ON playable_item BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM artist_credit_member c JOIN artist a ON a.id=c.artist_id
      WHERE c.credit_id=NEW.artist_credit_id AND a.archived=1) THEN RAISE(ABORT,'署名包含已归档艺人，请先恢复') END;
  END;
  CREATE TRIGGER playable_release_active_update BEFORE UPDATE OF release_track_id ON playable_item BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM release_track t JOIN medium m ON m.id=t.medium_id JOIN release r ON r.id=m.release_id
      JOIN artist_credit_member c ON c.credit_id=r.artist_credit_id JOIN artist a ON a.id=c.artist_id
      WHERE t.id=NEW.release_track_id AND a.archived=1) THEN RAISE(ABORT,'发行包含已归档艺人，请先恢复') END;
  END;
  CREATE TRIGGER playable_release_active_insert BEFORE INSERT ON playable_item BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM release_track t JOIN medium m ON m.id=t.medium_id JOIN release r ON r.id=m.release_id
      JOIN artist_credit_member c ON c.credit_id=r.artist_credit_id JOIN artist a ON a.id=c.artist_id
      WHERE t.id=NEW.release_track_id AND a.archived=1) THEN RAISE(ABORT,'发行包含已归档艺人，请先恢复') END;
  END;
  CREATE TRIGGER artist_archive_current BEFORE UPDATE OF archived ON artist WHEN NEW.archived=1 BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM artist_identity_binding WHERE identity_artist_id=NEW.id)
      OR EXISTS(SELECT 1 FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id
        JOIN release r ON r.id=m.release_id JOIN artist_credit_member c ON c.credit_id=p.artist_credit_id OR c.credit_id=r.artist_credit_id
        WHERE c.artist_id=NEW.id) THEN RAISE(ABORT,'艺人仍有关联，不能归档') END;
  END;
  CREATE TABLE artist_profile_change(id TEXT PRIMARY KEY,artist_id TEXT NOT NULL REFERENCES artist(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK(action IN('artist-create','artist-profile','artist-archive','undo')),title TEXT NOT NULL,
    before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),created_at INTEGER NOT NULL,undone_at INTEGER);
  CREATE INDEX idx_artist_profile_change_time ON artist_profile_change(created_at DESC,id);
`;
type Alias={artistId:string;name:string;revision:number;context:string};
type Item={itemId:string;revision:number};
type Snapshot={artist:ArtistProfile|null;items:Item[];provenance?:ProvenanceSnapshot};
const norm=(s:string)=>s.normalize('NFKC').toLowerCase().trim();
function id(value:unknown):asserts value is string{if(typeof value!=='string'||!value.length||value.length>128)throw new Error('无效艺人 ID');}
function page(limit:number,offset:number):void{if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw new Error('无效艺人分页');}
function text(value:unknown,required=false):string{if(typeof value!=='string'||value.trim().length>240||/[\u0000-\u001f]/.test(value)||required&&!value.trim())throw new Error('艺人字段需为有效的 1–240 个字符');return value.trim();}
export function normalizedArtistFields(fields:ArtistProfileFields):ArtistProfileFields{
  if(!fields||!Array.isArray(fields.references)||fields.references.length>32)throw new Error('最多保存 32 条外部引用');
  const references=normalizedReferences('artist',fields.references);
  return {name:text(fields.name,true),sortName:text(fields.sortName),disambiguation:text(fields.disambiguation),references};
}

// Manually curated identities are independent of scan candidates and provider IDs.
export class ArtistProfileRepository{
  constructor(private readonly db:DatabaseSync,private readonly catalog:CatalogRepository,private readonly refreshSearch:(id:string)=>void){}
  private aliases(artistId:string):Alias[]{return this.db.prepare(`SELECT a.id artistId,a.name,COALESCE(s.revision,0) revision,COALESCE(lr.path,'') context
    FROM artist_identity_binding b JOIN artist a ON a.id=b.source_artist_id LEFT JOIN artist_identity_state s ON s.artist_id=a.id
    LEFT JOIN library_root lr ON lr.id=json_extract(a.local_key,'$[0]') WHERE b.identity_artist_id=? ORDER BY a.id`).all(artistId) as unknown as Alias[];}
  private members(artistId:string):Array<Record<string,unknown>>{return this.db.prepare(`SELECT p.id itemId,COALESCE(s.revision,0) revision,
    p.recording_id,p.release_track_id,p.artist_credit_id,r.artist_credit_id album_credit,c.credit_id,c.ordinal,c.role,c.artist_id
    FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id JOIN release r ON r.id=m.release_id
    JOIN artist_credit_member c ON c.credit_id=p.artist_credit_id OR c.credit_id=r.artist_credit_id${this.catalog.recordingCreditCondition()}
    LEFT JOIN artist_identity_binding b ON b.source_artist_id=c.artist_id LEFT JOIN item_catalog_state s ON s.item_id=p.id
    WHERE COALESCE(b.identity_artist_id,c.artist_id)=? ORDER BY p.id,c.credit_id,c.ordinal`).all(artistId) as unknown as Array<Record<string,unknown>>;}
  profile(artistId:string):ArtistProfile{
    id(artistId);const row=this.db.prepare(`SELECT a.name,a.sort_name sortName,a.disambiguation,a.archived,a.local_key,COALESCE(s.revision,0) revision
      FROM artist a LEFT JOIN artist_identity_state s ON s.artist_id=a.id WHERE a.id=?`).get(artistId) as {name:string;sortName:string|null;disambiguation:string;archived:number;local_key:string|null;revision:number}|undefined;
    if(!row||row.local_key!==null)throw new Error('请选择人工艺人身份，本地候选请先关联');
    const references=(this.db.prepare(`SELECT provider,external_id externalId,url FROM external_ref WHERE entity_kind='artist' AND entity_id=?`).all(artistId) as unknown as ExternalReference[]).sort(referenceOrder);
    const members=this.members(artistId),aliases=this.aliases(artistId),artist={artistId,name:row.name,sortName:row.sortName??'',disambiguation:row.disambiguation,
      archived:Number(row.archived)===1,revision:Number(row.revision),references,itemCount:new Set(members.map(m=>m.itemId)).size,aliasCount:aliases.length};
    const recordings=this.catalog.recordingProfilesEnabled?this.db.prepare(`SELECT rec.id,rec.title,rec.version_label,rec.duration_us,rec.artist_credit_id,rp.revision,c.ordinal,c.role
      FROM recording rec JOIN recording_profile_state rp ON rp.recording_id=rec.id AND rp.confirmed=1
      JOIN artist_credit_member c ON c.credit_id=rec.artist_credit_id LEFT JOIN artist_identity_binding b ON b.source_artist_id=c.artist_id
      WHERE COALESCE(b.identity_artist_id,c.artist_id)=? ORDER BY rec.id,c.ordinal`).all(artistId):[];
    return {...artist,fingerprint:createHash('sha256').update(JSON.stringify([artist,aliases,members,...(recordings.length?[recordings]:[])])).digest('hex')};
  }
  list(query='',limit=50,offset=0):{items:ArtistProfile[];total:number}{
    page(limit,offset);if(typeof query!=='string'||query.length>500)throw new Error('无效艺人检索');
    const pattern=`%${norm(query).replace(/[\\%_]/g,'\\$&')}%`,from=`FROM artist a WHERE a.local_key IS NULL AND a.archived=0 AND
      (a.normalized_name LIKE ? ESCAPE '\\' OR lower(COALESCE(a.sort_name,'')) LIKE ? ESCAPE '\\' OR lower(a.disambiguation) LIKE ? ESCAPE '\\'
      OR EXISTS(SELECT 1 FROM external_ref x WHERE x.entity_kind='artist' AND x.entity_id=a.id AND (lower(x.provider) LIKE ? ESCAPE '\\' OR lower(x.external_id) LIKE ? ESCAPE '\\')))`;
    const params=Array(5).fill(pattern),total=(this.db.prepare(`SELECT COUNT(*) n ${from}`).get(...params) as {n:number}).n;
    const rows=this.db.prepare(`SELECT a.id ${from} ORDER BY COALESCE(NULLIF(a.sort_name,''),a.name) COLLATE NOCASE,a.id LIMIT ? OFFSET ?`).all(...params,limit,offset) as unknown as Array<{id:string}>;
    return {total,items:rows.map(row=>this.profile(row.id))};
  }
  detail(artistId:string,limit=50,offset=0):{artist:ArtistProfile;ids:string[];total:number;aliases:Alias[]}{
    page(limit,offset);const artist=this.profile(artistId),ids=[...new Set(this.members(artistId).map(member=>String(member.itemId)))];
    return {artist,ids:ids.slice(offset,offset+limit),total:ids.length,aliases:this.aliases(artistId).slice(0,50)};
  }
  private checked(ref:ArtistProfileRef,allowArchived=false):ArtistProfile{
    if(!ref||!Number.isSafeInteger(ref.revision)||ref.revision<0||typeof ref.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(ref.fingerprint))throw new Error('无效艺人修订');
    const artist=this.profile(ref.artistId);
    if(artist.revision!==ref.revision||artist.fingerprint!==ref.fingerprint)throw new Error('艺人信息或关联成员已变化，请刷新后重新确认');
    if(artist.archived&&!allowArchived)throw new Error('艺人已归档，请先在修订记录恢复');return artist;
  }
  referenceUrl(ref:ArtistProfileRef,provider:string,externalId:string):string{
    const artist=this.checked(ref),reference=artist.references.find(r=>r.provider===provider&&r.externalId===externalId);
    if(!reference?.url)throw new Error('引用没有可打开的来源链接');return safeUrl(reference.url)!;
  }
  private itemIds(artistId:string):string[]{return [...new Set(this.members(artistId).map(member=>String(member.itemId)))];}
  private snapshot(artistId:string):Snapshot{
    const artist=this.profile(artistId);return {artist,items:this.itemIds(artistId).map(itemId=>({itemId,revision:this.catalog.project([itemId]).get(itemId)!.revision})),...(this.catalog.metadataProvenanceEnabled?{provenance:provenanceSnapshot(this.db,'artist',artistId)}:{})};
  }
  private writeReferences(artistId:string,references:ExternalReference[]):void{
    for(const ref of references){const owner=this.db.prepare(`SELECT entity_id FROM external_ref WHERE entity_kind='artist' AND provider=? AND external_id=?`).get(ref.provider,ref.externalId) as {entity_id:string}|undefined;
      if(owner&&owner.entity_id!==artistId)throw new Error(`外部引用 ${ref.provider} / ${ref.externalId} 已属于其他艺人，请先核对身份`);}
    this.db.prepare(`DELETE FROM external_ref WHERE entity_kind='artist' AND entity_id=?`).run(artistId);
    for(const ref of references)this.db.prepare('INSERT INTO external_ref(entity_kind,entity_id,provider,external_id,url) VALUES(?,?,?,?,?)').run('artist',artistId,ref.provider,ref.externalId,ref.url);
  }
  private write(artistId:string,fields:ArtistProfileFields,archived=false):void{
    this.db.prepare('UPDATE artist SET name=?,sort_name=?,normalized_name=?,disambiguation=?,archived=0 WHERE id=?')
      .run(fields.name,fields.sortName||null,norm(fields.name),fields.disambiguation,artistId);
    this.writeReferences(artistId,archived?[]:fields.references);
    if(archived)this.db.prepare('UPDATE artist SET archived=1 WHERE id=?').run(artistId);
  }
  private bump(artistId:string,itemIds:string[]):void{
    const ids=[artistId,...this.aliases(artistId).map(alias=>alias.artistId)];
    for(const id of ids)this.db.prepare(`INSERT INTO artist_identity_state(artist_id,revision) VALUES(?,1)
      ON CONFLICT(artist_id) DO UPDATE SET revision=revision+1`).run(id);
    for(const id of itemIds){this.catalog.sync(id);this.refreshSearch(id);}
  }
  private save(action:string,artistId:string,title:string,before:Snapshot):CatalogChangeResult{
    const after=this.snapshot(artistId),changeId=randomUUID();this.db.prepare('INSERT INTO artist_profile_change(id,artist_id,action,title,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(changeId,artistId,action,title,JSON.stringify(before),JSON.stringify(after),Date.now());
    return {changeId,artistId,items:after.items};
  }
  private command(commandId:string,identity:unknown,action:()=>CatalogChangeResult):CatalogChangeResult{
    if(typeof commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(commandId))throw new Error('无效艺人资料命令 ID');
    const fingerprint=createHash('sha256').update(JSON.stringify(['artist-profile',identity])).digest('hex');this.db.exec('BEGIN IMMEDIATE');
    try{const prior=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as {fingerprint:string;result_json:string}|undefined;
      if(prior){if(prior.fingerprint!==fingerprint)throw new Error('命令 ID 已用于不同操作');this.db.exec('COMMIT');return JSON.parse(prior.result_json);}
      const result=action();this.db.prepare('INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)').run(commandId,fingerprint,JSON.stringify(result),new Date().toISOString());this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  edit(request:ArtistProfileRequest):CatalogChangeResult{
    if(!request||!['artist-create','artist-profile','artist-archive'].includes(request.action))throw new Error('无效艺人资料操作');
    const fields=request.action==='artist-archive'?null:normalizedArtistFields(request.fields),r=request.action==='artist-create'?null:request.artist;
    return this.command(request.commandId,[request.action,r?[r.artistId,r.revision,r.fingerprint]:null,fields],()=>{
      if(request.action==='artist-create'){
        const artistId=randomUUID();this.db.prepare('INSERT INTO artist(id,name,sort_name,normalized_name,disambiguation,local_key) VALUES(?,?,?,?,?,NULL)')
          .run(artistId,fields!.name,fields!.sortName||null,norm(fields!.name),fields!.disambiguation);
        this.writeReferences(artistId,fields!.references);
        if(this.catalog.metadataProvenanceEnabled)recordManual(this.db,'artist',artistId,null,{name:fields!.name,sort_name:fields!.sortName||null,disambiguation:fields!.disambiguation});
        return this.save(request.action,artistId,fields!.name,{artist:null,items:[]});
      }
      const artist=this.checked(request.artist),before=this.snapshot(artist.artistId);
      if(artist.itemCount>5000||artist.aliasCount>5000)throw new Error('每次编辑最多影响 5000 个文件或来源身份');
      if(request.action==='artist-archive'){
        if(artist.itemCount||artist.aliasCount)throw new Error('艺人仍有关联，请先解除署名和来源关联');
        this.write(artist.artistId,artist,true);
      }else{
        if(JSON.stringify([artist.name,artist.sortName,artist.disambiguation,artist.references])===JSON.stringify([fields!.name,fields!.sortName,fields!.disambiguation,fields!.references]))throw new Error('没有需要保存的修改');
        this.write(artist.artistId,fields!);
        if(this.catalog.metadataProvenanceEnabled)recordManual(this.db,'artist',artist.artistId,{name:artist.name,sort_name:artist.sortName||null,disambiguation:artist.disambiguation},{name:fields!.name,sort_name:fields!.sortName||null,disambiguation:fields!.disambiguation});
      }
      this.bump(artist.artistId,before.items.map(item=>item.itemId));return this.save(request.action,artist.artistId,fields?.name??artist.name,before);
    });
  }
  owns(changeId:string):boolean{id(changeId);return Boolean(this.db.prepare('SELECT 1 FROM artist_profile_change WHERE id=?').get(changeId));}
  undo(changeId:string,commandId:string):CatalogChangeResult{
    id(changeId);return this.command(commandId,['undo',changeId],()=>{
      const row=this.db.prepare('SELECT * FROM artist_profile_change WHERE id=?').get(changeId) as {artist_id:string;action:string;title:string;before_json:string;after_json:string;undone_at:number|null}|undefined;
      if(!row||row.action==='undo'||row.undone_at!==null)throw new Error('艺人资料修订不存在或已撤销');
      const before=JSON.parse(row.before_json) as Snapshot,after=JSON.parse(row.after_json) as Snapshot;
      const artist=this.checked(after.artist!,true),current=this.snapshot(artist.artistId);
      if(JSON.stringify(current.items)!==JSON.stringify(after.items))throw new Error('艺人关联已变化，不能直接撤销');
      if(this.catalog.metadataProvenanceEnabled)checkProvenanceUndo(this.db,'artist',artist.artistId,after.provenance);
      if(before.artist)this.write(artist.artistId,before.artist,before.artist.archived);
      else{if(artist.itemCount||artist.aliasCount)throw new Error('艺人已有使用，不能撤销创建');this.write(artist.artistId,artist,true);}
      if(this.catalog.metadataProvenanceEnabled)restoreProvenance(this.db,'artist',artist.artistId,before.provenance);
      this.bump(artist.artistId,current.items.map(item=>item.itemId));this.db.prepare('UPDATE artist_profile_change SET undone_at=? WHERE id=?').run(Date.now(),changeId);
      return this.save('undo',artist.artistId,row.title,current);
    });
  }
}
