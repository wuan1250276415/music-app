import {normalizedCreditName,insertCreditMember} from './artist-credit.js';
import {collectionSnapshot,checkCollectionUndo,restoreCollections,recordCollectionManual,type CollectionSnapshot} from './metadata-collections.js';
import {copySourceDecisions} from './metadata-provenance.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ArtistCandidate, ArtistEditRequest, CatalogChangeResult } from '../shared/contracts.js';
import { CatalogRepository, artistRoles } from './catalog.js';

export const artistCurationSchema=`
  CREATE TABLE artist_identity_binding(source_artist_id TEXT PRIMARY KEY REFERENCES artist(id) ON DELETE RESTRICT,
    identity_artist_id TEXT NOT NULL REFERENCES artist(id) ON DELETE RESTRICT,CHECK(source_artist_id<>identity_artist_id));
  CREATE INDEX idx_artist_identity ON artist_identity_binding(identity_artist_id,source_artist_id);
  CREATE TRIGGER artist_identity_insert BEFORE INSERT ON artist_identity_binding BEGIN
    SELECT CASE WHEN (SELECT local_key FROM artist WHERE id=NEW.source_artist_id) IS NULL
      OR (SELECT local_key FROM artist WHERE id=NEW.identity_artist_id) IS NOT NULL THEN RAISE(ABORT,'invalid artist identity') END;
  END;
  CREATE TRIGGER artist_identity_update BEFORE UPDATE ON artist_identity_binding BEGIN
    SELECT CASE WHEN (SELECT local_key FROM artist WHERE id=NEW.source_artist_id) IS NULL
      OR (SELECT local_key FROM artist WHERE id=NEW.identity_artist_id) IS NOT NULL THEN RAISE(ABORT,'invalid artist identity') END;
  END;
  CREATE TABLE artist_identity_state(artist_id TEXT PRIMARY KEY REFERENCES artist(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(revision>=0));
  CREATE TABLE item_credit_binding(item_id TEXT PRIMARY KEY REFERENCES playable_item(id) ON DELETE RESTRICT,
    credit_id TEXT NOT NULL REFERENCES artist_credit(id) ON DELETE RESTRICT);
  CREATE TABLE artist_change(id TEXT PRIMARY KEY,action TEXT NOT NULL CHECK(action IN ('artist-link','artist-reset','artist-credit','credit-reset','undo')),
    title TEXT NOT NULL,before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),
    created_at INTEGER NOT NULL,undone_at INTEGER);
`;
type Source={artistId:string;identityId:string|null;revision:number};
type Item={itemId:string;creditId:string|null;revision:number;title:string;collections?:CollectionSnapshot};
type Snapshot={sources:Source[];items:Item[]};
function id(value:unknown):asserts value is string{if(typeof value!=='string'||!value.length||value.length>128)throw new Error('无效艺人或曲目 ID');}
function revision(value:unknown):asserts value is number{if(!Number.isSafeInteger(value)||Number(value)<0)throw new Error('无效艺人修订');}

export class ArtistCurationRepository {
  constructor(private readonly db:DatabaseSync,private readonly catalog:CatalogRepository,private readonly refreshSearch:(id:string)=>void){}

  candidates(query='',limit=50,offset=0):{items:ArtistCandidate[];total:number}{
    if(typeof query!=='string'||query.length>256||!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw new Error('无效艺人查询');
    const pattern=`%${query.normalize('NFKC').toLowerCase().trim().replace(/[\\%_]/g,'\\$&')}%`;
    const from=`FROM artist a LEFT JOIN artist_identity_binding b ON b.source_artist_id=a.id
      LEFT JOIN artist i ON i.id=b.identity_artist_id LEFT JOIN artist_identity_state s ON s.artist_id=a.id
      WHERE a.archived=0 AND (a.normalized_name LIKE ? ESCAPE '\\' OR i.normalized_name LIKE ? ESCAPE '\\'
        OR lower(COALESCE(i.disambiguation,a.disambiguation)) LIKE ? ESCAPE '\\')`;
    const total=(this.db.prepare(`SELECT COUNT(*) n ${from}`).get(pattern,pattern,pattern) as {n:number}).n;
    const rows=this.db.prepare(`SELECT a.id,a.name,COALESCE(i.disambiguation,a.disambiguation) disambiguation,COALESCE(i.id,a.id) identityId,COALESCE(i.name,a.name) identityName,
      COALESCE(s.revision,0) revision,a.local_key IS NULL confirmed,
      (SELECT COUNT(DISTINCT p.id) FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id
        JOIN release r ON r.id=m.release_id JOIN artist_credit_member c ON c.credit_id=p.artist_credit_id OR c.credit_id=r.artist_credit_id${this.catalog.recordingCreditCondition()}
        LEFT JOIN artist_identity_binding ib ON ib.source_artist_id=c.artist_id WHERE p.visible=1 AND
          ((a.local_key IS NULL AND COALESCE(ib.identity_artist_id,c.artist_id)=a.id) OR (a.local_key IS NOT NULL AND c.artist_id=a.id))) count,
      COALESCE((SELECT lr.path FROM library_root lr WHERE lr.id=json_extract(a.local_key,'$[0]')),'人工确认身份') context
      ${from} ORDER BY a.normalized_name,a.id LIMIT ? OFFSET ?`).all(pattern,pattern,pattern,limit,offset) as unknown as Array<Omit<ArtistCandidate,'confirmed'>&{confirmed:number}>;
    return {total,items:rows.map(row=>({...row,confirmed:Number(row.confirmed)===1}))};
  }

  private command(commandId:string,identity:unknown,action:()=>CatalogChangeResult):CatalogChangeResult{
    if(typeof commandId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(commandId))throw new Error('无效艺人命令 ID');
    const fingerprint=createHash('sha256').update(JSON.stringify(['artist',identity])).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const prior=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as {fingerprint:string;result_json:string}|undefined;
      if(prior){if(prior.fingerprint!==fingerprint)throw new Error('命令 ID 已用于不同操作');this.db.exec('COMMIT');return JSON.parse(prior.result_json);}
      const result=action();
      this.db.prepare('INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)').run(commandId,fingerprint,JSON.stringify(result),new Date().toISOString());
      this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  private source(artistId:string):Source{
    id(artistId);
    const row=this.db.prepare(`SELECT a.id artistId,b.identity_artist_id identityId,COALESCE(s.revision,0) revision FROM artist a
      LEFT JOIN artist_identity_binding b ON b.source_artist_id=a.id LEFT JOIN artist_identity_state s ON s.artist_id=a.id WHERE a.id=?`).get(artistId) as Source|undefined;
    if(!row)throw new Error('艺人不存在');return {...row};
  }
  private checkedSource(artistId:string,baseRevision:number):Source{
    revision(baseRevision);const source=this.source(artistId);
    if((this.db.prepare('SELECT archived FROM artist WHERE id=?').get(artistId) as {archived:number}).archived===1)throw new Error('艺人已归档，请先恢复');
    if(source.revision!==baseRevision)throw new Error('艺人身份已变化，请刷新后重新确认');return source;
  }
  private item(itemId:string):Item{
    id(itemId);const catalog=this.catalog.project([itemId]).get(itemId);if(!catalog)throw new Error('曲目不存在');
    const binding=this.db.prepare('SELECT credit_id FROM item_credit_binding WHERE item_id=?').get(itemId) as {credit_id:string}|undefined;
    const row=this.db.prepare('SELECT COALESCE(o.title,p.title) title FROM playable_item p LEFT JOIN metadata_override o ON o.item_id=p.id WHERE p.id=?').get(itemId) as {title:string};
    const collections=this.catalog.metadataProvenanceEnabled?collectionSnapshot(this.db,'playable_item',itemId):undefined;return {itemId,creditId:binding?.credit_id??null,revision:catalog.revision,title:row.title,...(collections?{collections}:{})};
  }
  private checkedItem(itemId:string,baseRevision:number):Item{
    revision(baseRevision);const item=this.item(itemId);if(item.revision!==baseRevision)throw new Error('曲目署名已变化，请刷新后重新确认');return item;
  }
  private affected(sourceIds:string[]):string[]{
    const slots=sourceIds.map(()=>'?').join(',');
    return (this.db.prepare(`SELECT DISTINCT p.id FROM playable_item p JOIN release_track t ON t.id=p.release_track_id
      JOIN medium m ON m.id=t.medium_id JOIN release r ON r.id=m.release_id JOIN artist_credit_member c
      ON c.credit_id=p.artist_credit_id OR c.credit_id=r.artist_credit_id${this.catalog.recordingCreditCondition()} WHERE c.artist_id IN(${slots}) ORDER BY p.id`).all(...sourceIds) as unknown as Array<{id:string}>).map(row=>row.id);
  }
  private bindSource(source:Source):void{
    const current=this.source(source.artistId);
    if(source.identityId)this.db.prepare(`INSERT INTO artist_identity_binding(source_artist_id,identity_artist_id) VALUES(?,?)
      ON CONFLICT(source_artist_id) DO UPDATE SET identity_artist_id=excluded.identity_artist_id`).run(source.artistId,source.identityId);
    else this.db.prepare('DELETE FROM artist_identity_binding WHERE source_artist_id=?').run(source.artistId);
    this.db.prepare(`INSERT INTO artist_identity_state(artist_id,revision) VALUES(?,?)
      ON CONFLICT(artist_id) DO UPDATE SET revision=excluded.revision`).run(source.artistId,current.revision+1);
  }
  private bindCredit(item:Item):void{
    if(item.creditId)this.db.prepare(`INSERT INTO item_credit_binding(item_id,credit_id) VALUES(?,?)
      ON CONFLICT(item_id) DO UPDATE SET credit_id=excluded.credit_id`).run(item.itemId,item.creditId);
    else this.db.prepare('DELETE FROM item_credit_binding WHERE item_id=?').run(item.itemId);
  }
  private refresh(items:Item[]):void{for(const item of items){this.catalog.sync(item.itemId);this.refreshSearch(item.itemId);}}
  private save(action:string,title:string,before:Snapshot):CatalogChangeResult{
    const after:Snapshot={sources:before.sources.map(source=>this.source(source.artistId)),items:before.items.map(item=>this.item(item.itemId))};
    const changeId=randomUUID();this.db.prepare('INSERT INTO artist_change(id,action,title,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(changeId,action,title,JSON.stringify(before),JSON.stringify(after),Date.now());
    return {changeId,items:after.items.map(item=>({itemId:item.itemId,revision:item.revision}))};
  }

  edit(request:ArtistEditRequest):CatalogChangeResult{
    if(!request||!['artist-link','artist-reset','artist-credit','credit-reset'].includes(request.action))throw new Error('无效艺人操作');
    const identity=request.action==='artist-link'?[request.action,request.sources?.map(source=>[source?.artistId,source?.revision]),request.target?.artistId,request.target?.revision]:
      request.action==='artist-reset'?[request.action,request.sources?.map(source=>[source?.artistId,source?.revision])]:
      [request.action,request.itemId,request.revision,request.action==='artist-credit'?request.members?.map(member=>[member?.artistId,member?.artistRevision,member?.role,member?.joinPhrase,...(member?.creditedName?[member.creditedName]:[])]):null];
    return this.command(request.commandId,identity,()=>{
      if(request.action==='artist-link'||request.action==='artist-reset'){
        if(!Array.isArray(request.sources)||!request.sources.length||request.sources.length>100)throw new Error('请选择 1–100 个候选艺人');
        const sources=request.sources.map(source=>{if(!source)throw new Error('无效艺人');return this.checkedSource(source.artistId,source.revision);});
        if(new Set(sources.map(source=>source.artistId)).size!==sources.length)throw new Error('艺人选择重复');
        for(const source of sources){const row=this.db.prepare('SELECT local_key FROM artist WHERE id=?').get(source.artistId) as {local_key:string|null};if(row.local_key===null)throw new Error('人工确认身份不能作为来源候选');}
        let identityId:string|null=null;let title='恢复艺人候选';
        if(request.action==='artist-link'){
          if(!request.target||sources.some(source=>source.artistId===request.target.artistId))throw new Error('请选择另一个艺人作为目标');
          const target=this.checkedSource(request.target.artistId,request.target.revision);
          const row=this.db.prepare('SELECT name,local_key,sort_name,normalized_name,disambiguation FROM artist WHERE id=?').get(target.artistId) as {name:string;local_key:string|null};
          identityId=target.identityId??(row.local_key===null?target.artistId:null);
          if(identityId&&sources.every(source=>source.identityId===identityId))throw new Error('所选艺人已经关联到此身份');
          if(!identityId){identityId=randomUUID();this.db.prepare(`INSERT INTO artist(id,name,sort_name,normalized_name,disambiguation,local_key)
            SELECT ?,name,sort_name,normalized_name,'user-confirmed',NULL FROM artist WHERE id=?`).run(identityId,target.artistId);
            if(this.catalog.metadataProvenanceEnabled)copySourceDecisions(this.db,'artist',target.artistId,identityId,['disambiguation']);}
          if(row.local_key!==null)sources.push(target);
          title=`确认艺人身份：${row.name}`;
        }else if(sources.every(source=>source.identityId===null))throw new Error('所选艺人没有人工关联');
        const before:Snapshot={sources,items:this.affected(sources.map(source=>source.artistId)).map(itemId=>this.item(itemId))};
        for(const source of sources)this.bindSource({...source,identityId});
        this.refresh(before.items);return this.save(request.action,title,before);
      }
      const item=this.checkedItem(request.itemId,request.revision),before:Snapshot={sources:[],items:[item]};
      if(request.action==='credit-reset'){
        if(item.creditId===null)throw new Error('曲目没有人工署名');if(this.catalog.metadataProvenanceEnabled&&collectionSnapshot(this.db,'playable_item',item.itemId)?.rows.some(row=>row.field==='artists'&&row.locked===1))throw new Error('请先解除署名集合锁，再恢复默认署名');this.bindCredit({...item,creditId:null});if(this.catalog.metadataProvenanceEnabled){const prior=collectionSnapshot(this.db,'playable_item',item.itemId);restoreCollections(this.db,'playable_item',item.itemId,prior?{rows:prior.rows.map(row=>row.field==='artists'?{...row,mode:'automatic',locked:0,selected_json:null,sources_json:'[]'}:row)}:undefined);}
      }else{
        if(!Array.isArray(request.members)||!request.members.length||request.members.length>64)throw new Error('署名需包含 1–64 位艺人');
        const unique=new Set<string>();
        for(const member of request.members){
          if(!member)throw new Error('无效署名');id(member.artistId);
          if(!artistRoles.includes(member.role)||member.role==='album_artist'||typeof member.joinPhrase!=='string'||member.joinPhrase.length>80||/[\u0000-\u001f]/.test(member.joinPhrase))throw new Error('无效角色或连接词');
          normalizedCreditName(member.creditedName);this.checkedSource(member.artistId,member.artistRevision);const key=JSON.stringify([member.artistId,member.role]);if(unique.has(key))throw new Error('同一艺人的角色重复');unique.add(key);
        }
        const performers=request.members.filter(member=>member.role==='performer');
        if(!performers.length)throw new Error('请保留至少一位曲目歌手');
        const display=performers.map(member=>{const artist=this.db.prepare(`SELECT COALESCE(i.name,a.name) name FROM artist a
          LEFT JOIN artist_identity_binding b ON b.source_artist_id=a.id LEFT JOIN artist i ON i.id=b.identity_artist_id WHERE a.id=?`).get(member.artistId) as {name:string};return (normalizedCreditName(member.creditedName)??artist.name)+member.joinPhrase;}).join('');
        const creditId=randomUUID();this.db.prepare('INSERT INTO artist_credit(id,owner_key,display_text) VALUES(?,?,?)').run(creditId,`manual:${creditId}`,display);
        request.members.forEach((member,ordinal)=>insertCreditMember(this.db,creditId,ordinal,{...member,creditedName:normalizedCreditName(member.creditedName)}));
        this.bindCredit({...item,creditId});if(this.catalog.metadataProvenanceEnabled){this.db.prepare('UPDATE playable_item SET artist_credit_id=? WHERE id=?').run(creditId,item.itemId);recordCollectionManual(this.db,'playable_item',item.itemId,'artists');}
      }
      this.refresh(before.items);return this.save(request.action,item.title,before);
    });
  }

  owns(changeId:string):boolean{return Boolean(this.db.prepare('SELECT id FROM artist_change WHERE id=?').get(changeId));}
  undo(changeId:string,commandId:string):CatalogChangeResult{
    id(changeId);return this.command(commandId,['undo',changeId],()=>{
      const row=this.db.prepare('SELECT action,title,before_json,after_json,undone_at FROM artist_change WHERE id=?').get(changeId) as {action:string;title:string;before_json:string;after_json:string;undone_at:number|null}|undefined;
      if(!row||row.action==='undo'||row.undone_at!==null)throw new Error('艺人修订不存在或已撤销');
      const before=JSON.parse(row.before_json) as Snapshot,after=JSON.parse(row.after_json) as Snapshot;
      for(const source of after.sources){const current=this.checkedSource(source.artistId,source.revision);if(current.identityId!==source.identityId)throw new Error('艺人身份已变化，不能直接撤销');}
      for(const item of after.items){const current=this.checkedItem(item.itemId,item.revision);if(current.creditId!==item.creditId)throw new Error('曲目署名已变化，不能直接撤销');if(this.catalog.metadataProvenanceEnabled)checkCollectionUndo(this.db,'playable_item',item.itemId,item.collections);}
      for(const source of before.sources)this.bindSource(source);
      for(const item of before.items){this.bindCredit(item);if(this.catalog.metadataProvenanceEnabled)restoreCollections(this.db,'playable_item',item.itemId,item.collections);}
      // A later scan may add items that use the same source identity; refresh them too.
      const affected=new Map(before.items.map(item=>[item.itemId,item]));
      if(before.sources.length)for(const itemId of this.affected(before.sources.map(source=>source.artistId)))affected.set(itemId,this.item(itemId));
      this.refresh([...affected.values()]);this.db.prepare('UPDATE artist_change SET undone_at=? WHERE id=?').run(Date.now(),changeId);
      return this.save('undo',row.title,{sources:after.sources,items:[...affected.values()].map(item=>after.items.find(old=>old.itemId===item.itemId)??item)});
    });
  }
}
