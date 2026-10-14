import {hasCreditNames} from './artist-credit.js';
import {copySourceDecisions} from './metadata-provenance.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogChangeResult, ReleaseEditRequest, ReleaseRef, ReleaseSummary } from '../shared/contracts.js';
import { CatalogRepository } from './catalog.js';
import {readCredit} from './artist-credit.js';

export const releaseCurationSchema=`CREATE TABLE release_change(
  id TEXT PRIMARY KEY,action TEXT NOT NULL CHECK(action IN ('release-merge','release-split','undo')),
  title TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at INTEGER NOT NULL,undone_at INTEGER);
  CREATE INDEX idx_release_change_time ON release_change(created_at DESC,id);`;
type Binding={recordingId:string;trackId:string};
type ItemSnapshot={itemId:string;revision:number;binding:Binding|null};
type Snapshot={items:ItemSnapshot[];releases:ReleaseRef[]};
type Member={itemId:string;trackId:string;recordingId:string;disc:number;position:number;revision:number};
const maxItems=5000;
function validId(value:unknown):asserts value is string {if(typeof value!=='string'||!value.length||value.length>128)throw new Error('无效发行 ID');}
function page(limit:number,offset:number):void {if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw new Error('无效发行分页');}
function text(value:unknown,required=false):string {if(typeof value!=='string'||value.trim().length>240||/[\u0000-\u001f]/.test(value)||(required&&!value.trim()))throw new Error('发行字段需为有效的 1–240 个字符');return value.trim();}
function disc(value:unknown):asserts value is number {if(!Number.isSafeInteger(value)||Number(value)<1||Number(value)>9999)throw new Error('碟号需为 1–9999 的整数');}
const memberFrom=`FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id`;

// Commands own their transaction. Physical files, playable IDs and user references never move.
export class ReleaseCurationRepository {
  constructor(private readonly db:DatabaseSync,private readonly catalog:CatalogRepository,private readonly refreshSearch:(id:string)=>void){}

  private members(releaseId:string):Member[]{
    return this.db.prepare(`SELECT p.id itemId,t.id trackId,p.recording_id recordingId,m.disc_no disc,t.position,
      m.title mediumTitle,m.format mediumFormat,t.title trackTitle,t.printed_number printedNumber,t.artist_credit_id creditId,
      COALESCE(s.revision,0) revision ${memberFrom} LEFT JOIN item_catalog_state s ON s.item_id=p.id
      WHERE m.release_id=? ORDER BY m.disc_no,CASE WHEN (SELECT local_key FROM release WHERE id=m.release_id) LIKE 'manual-release:%' THEN t.position ELSE COALESCE(p.track_number,t.position) END,t.id,p.id`).all(releaseId) as unknown as Member[];
  }

  summary(releaseId:string):ReleaseSummary{
    validId(releaseId);
    const row=this.db.prepare(`SELECT r.*,c.display_text albumArtist,lr.path rootPath FROM release r JOIN library_root lr ON lr.id=r.root_id LEFT JOIN artist_credit c ON c.id=r.artist_credit_id WHERE r.id=?`).get(releaseId) as Record<string,unknown>|undefined;
    if(!row)throw new Error('发行版不存在');
    const members=this.members(releaseId),tracks=new Set(members.map(member=>member.trackId)),media=new Map<number,Set<string>>();
    for(const member of members){if(!media.has(member.disc))media.set(member.disc,new Set());media.get(member.disc)!.add(member.trackId);}
    // Includes hidden/offline members and their revisions: new scans and later bindings invalidate a preview too.
    const albumArtists=readCredit(this.db,row.artist_credit_id as string|null);
    const profileConfirmed=Boolean(this.db.prepare('SELECT 1 FROM release_profile_state WHERE release_id=?').get(releaseId));
    // Keep unedited v9/v10 fingerprints identical so existing audit undo remains valid.
    const fingerprint=createHash('sha256').update(JSON.stringify(profileConfirmed?[row,members,albumArtists,'release-profile']:[row,members])).digest('hex');
    return {releaseId,revision:Number(row.revision),fingerprint,title:String(row.title),albumArtist:albumArtists.map((member,index)=>(member.creditedName??member.name)+(member.joinPhrase??(index<albumArtists.length-1?'、':''))).join(''),
      date:row.date as string|null,country:row.country as string|null,edition:row.edition as string|null,groupId:row.group_id as string|null,
      label:row.label as string|null,catalogNumber:row.catalog_no as string|null,barcode:row.barcode as string|null,albumArtists,profileConfirmed,
      context:path.join(String(row.rootPath),String(row.local_context)),fileCount:members.length,trackCount:tracks.size,
      media:[...media].map(([discNumber,ids])=>({discNumber,trackCount:ids.size}))};
  }

  candidates(query='',limit=50,offset=0):{items:ReleaseSummary[];total:number}{
    page(limit,offset);if(typeof query!=='string'||query.length>500)throw new Error('无效发行检索');
    // SQL pagination bounds candidates before materializing membership and metadata previews.
    const pattern=`%${query.normalize('NFKC').trim().replace(/[\\%_]/g,'\\$&')}%`;
    const from=`FROM release r JOIN library_root lr ON lr.id=r.root_id LEFT JOIN artist_credit c ON c.id=r.artist_credit_id
      WHERE EXISTS(SELECT 1 ${memberFrom} WHERE m.release_id=r.id)
      AND (r.title LIKE ? ESCAPE '\\' OR COALESCE(c.display_text,'') LIKE ? ESCAPE '\\' OR r.local_context LIKE ? ESCAPE '\\' OR lr.path LIKE ? ESCAPE '\\')`;
    const params=[pattern,pattern,pattern,pattern],total=(this.db.prepare(`SELECT COUNT(*) n ${from}`).get(...params) as {n:number}).n;
    const rows=this.db.prepare(`SELECT r.id ${from} ORDER BY r.title,r.id LIMIT ? OFFSET ?`).all(...params,limit,offset) as unknown as Array<{id:string}>;
    return {total,items:rows.map(row=>this.summary(row.id))};
  }

  detail(releaseId:string,limit=50,offset=0):{release:ReleaseSummary;rows:Array<{id:string;versionCount:number}>;total:number}{
    page(limit,offset);const release=this.summary(releaseId);
    const rows=this.db.prepare(`SELECT MIN(p.id) id,COUNT(*) versionCount ${memberFrom} WHERE m.release_id=?
      GROUP BY t.id ORDER BY m.disc_no,CASE WHEN (SELECT local_key FROM release WHERE id=m.release_id) LIKE 'manual-release:%' THEN t.position ELSE COALESCE(MIN(p.track_number),t.position) END,t.id LIMIT ? OFFSET ?`).all(releaseId,limit,offset) as unknown as Array<{id:string;versionCount:number}>;
    return {release,rows,total:release.trackCount};
  }

  owns(changeId:string):boolean {validId(changeId);return Boolean(this.db.prepare('SELECT 1 FROM release_change WHERE id=?').get(changeId));}
  private checked(ref:ReleaseRef):ReleaseSummary{
    if(!ref||!Number.isSafeInteger(ref.revision)||ref.revision<0||typeof ref.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(ref.fingerprint))throw new Error('无效发行修订');
    const current=this.summary(ref.releaseId);
    if(current.revision!==ref.revision||current.fingerprint!==ref.fingerprint)throw new Error('发行版或成员已变化，请刷新后重新确认');
    return current;
  }
  private ref(releaseId:string):ReleaseRef {const value=this.summary(releaseId);return {releaseId,revision:value.revision,fingerprint:value.fingerprint};}
  private snapshot(itemIds:string[],releaseIds:string[]):Snapshot{
    return {items:itemIds.map(itemId=>{
      const binding=this.db.prepare('SELECT recording_id,release_track_id FROM item_catalog_binding WHERE item_id=?').get(itemId) as {recording_id:string;release_track_id:string}|undefined;
      const item=this.catalog.project([itemId]).get(itemId);if(!item)throw new Error('发行成员已不存在');
      return {itemId,revision:item.revision,binding:binding?{recordingId:binding.recording_id,trackId:binding.release_track_id}:null};
    }),releases:releaseIds.map(releaseId=>this.ref(releaseId))};
  }
  private bind(itemId:string,binding:Binding|null):void{
    if(binding)this.db.prepare(`INSERT INTO item_catalog_binding(item_id,recording_id,release_track_id) VALUES(?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET recording_id=excluded.recording_id,release_track_id=excluded.release_track_id`).run(itemId,binding.recordingId,binding.trackId);
    else this.db.prepare('DELETE FROM item_catalog_binding WHERE item_id=?').run(itemId);
    this.catalog.sync(itemId);this.refreshSearch(itemId);
  }
  private copyCredit(creditId:string|null):string|null{
    if(!creditId)return null;const id=randomUUID();
    this.db.prepare('INSERT INTO artist_credit(id,owner_key,display_text) SELECT ?,?,display_text FROM artist_credit WHERE id=?').run(id,`confirmed:${id}`,creditId);
    const named=hasCreditNames(this.db);this.db.prepare(`INSERT INTO artist_credit_member(credit_id,ordinal,artist_id,role,join_phrase${named?',credited_name':''})
      SELECT ?,ordinal,artist_id,role,join_phrase${named?',credited_name':''} FROM artist_credit_member WHERE credit_id=?`).run(id,creditId);return id;
  }
  private newRelease(sourceId:string,fields?:{title:string;date:string;country:string;edition:string}):string{
    const id=randomUUID(),source=this.db.prepare('SELECT artist_credit_id FROM release WHERE id=?').get(sourceId) as {artist_credit_id:string|null};
    this.db.prepare(`INSERT INTO release(id,group_id,artist_credit_id,title,date,country,label,catalog_no,barcode,edition,root_id,local_context,local_key,revision)
      SELECT ?,group_id,?,title,date,country,label,catalog_no,barcode,edition,root_id,local_context,?,0 FROM release WHERE id=?`)
      .run(id,this.copyCredit(source.artist_credit_id),`manual-release:${id}`,sourceId);
    if(fields)this.db.prepare('UPDATE release SET title=?,date=?,country=?,edition=? WHERE id=?').run(fields.title,fields.date||null,fields.country||null,fields.edition||null,id);
    this.db.prepare('INSERT INTO release_genre(release_id,genre_id,source) SELECT ?,genre_id,source FROM release_genre WHERE release_id=?').run(id,sourceId);
    if(this.catalog.metadataProvenanceEnabled)copySourceDecisions(this.db,'release',sourceId,id,fields?['title','date','country','edition']:[]);
    return id;
  }
  private copyTracks(releaseId:string,members:Member[],mapping:(member:Member)=>number):void{
    const media=new Map<number,string>(),positions=new Map<number,number>(),tracks=new Map<string,string>();
    for(const member of members){
      let trackId=tracks.get(member.trackId);
      if(!trackId){
        const old=this.db.prepare('SELECT t.artist_credit_id,m.title,m.format FROM release_track t JOIN medium m ON m.id=t.medium_id WHERE t.id=?').get(member.trackId) as {artist_credit_id:string|null;title:string|null;format:string|null};
        const discNumber=mapping(member);let mediumId=media.get(discNumber);
        if(!mediumId){mediumId=randomUUID();this.db.prepare('INSERT INTO medium(id,release_id,disc_no,title,format) VALUES(?,?,?,?,?)').run(mediumId,releaseId,discNumber,old.title,old.format);media.set(discNumber,mediumId);}
        const position=(positions.get(discNumber)??0)+1;positions.set(discNumber,position);trackId=randomUUID();
        this.db.prepare(`INSERT INTO release_track(id,medium_id,position,printed_number,recording_id,artist_credit_id,title,local_key)
          SELECT ?,?,?,printed_number,recording_id,?,title,? FROM release_track WHERE id=?`)
          .run(trackId,mediumId,position,this.copyCredit(old.artist_credit_id),`confirmed:${trackId}`,member.trackId);
        tracks.set(member.trackId,trackId);
      }
      this.bind(member.itemId,{recordingId:member.recordingId,trackId});
    }
  }
  private changed(releaseIds:string[],itemIds:string[]):void{
    for(const id of releaseIds)this.db.prepare('UPDATE release SET revision=revision+1 WHERE id=?').run(id);
    for(const id of itemIds){this.catalog.refreshRevision(id);this.refreshSearch(id);}
  }
  private save(action:string,title:string,before:Snapshot,after:Snapshot):CatalogChangeResult{
    const changeId=randomUUID();this.db.prepare('INSERT INTO release_change(id,action,title,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(changeId,action,title,JSON.stringify(before),JSON.stringify(after),Date.now());
    return {changeId,items:after.items.map(item=>({itemId:item.itemId,revision:item.revision}))};
  }
  private command<T>(commandId:string,identity:unknown,action:()=>T):T{
    if(typeof commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(commandId))throw new Error('无效发行命令 ID');
    const fingerprint=createHash('sha256').update(JSON.stringify(['release',identity])).digest('hex');this.db.exec('BEGIN IMMEDIATE');
    try{
      const receipt=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as {fingerprint:string;result_json:string}|undefined;
      if(receipt){if(receipt.fingerprint!==fingerprint)throw new Error('命令 ID 已用于不同操作');const result=JSON.parse(receipt.result_json) as T;this.db.exec('COMMIT');return result;}
      const result=action();this.db.prepare('INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)')
        .run(commandId,fingerprint,JSON.stringify(result),new Date().toISOString());this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  edit(request:ReleaseEditRequest):CatalogChangeResult{
    if(!request||!['release-merge','release-split'].includes(request.action))throw new Error('无效发行操作');
    const tuple=(ref:ReleaseRef)=>[ref?.releaseId,ref?.revision,ref?.fingerprint];
    let fields:{title:string;date:string;country:string;edition:string}|undefined;
    if(request.action==='release-split'){
      if(!Array.isArray(request.trackIds)||!request.trackIds.length||request.trackIds.length>maxItems||new Set(request.trackIds).size!==request.trackIds.length)throw new Error('请选择不重复的发行曲目');
      request.trackIds.forEach(validId);if(!request.fields)throw new Error('请填写新发行信息');
      fields={title:text(request.fields.title,true),date:text(request.fields.date),country:text(request.fields.country),edition:text(request.fields.edition)};
    }else if(!Array.isArray(request.sources)||!request.sources.length||request.sources.length>99||!Array.isArray(request.discMap)||request.discMap.length>5000)throw new Error('请选择 2–100 个发行版');
    const identity=request.action==='release-merge'?[request.action,request.sources.map(tuple),tuple(request.target),request.discMap.map(m=>[m?.releaseId,m?.sourceDisc,m?.targetDisc])]:
      [request.action,tuple(request.source),request.trackIds,fields];
    return this.command(request.commandId,identity,()=>{
      const refs=request.action==='release-merge'?[request.target,...request.sources]:[request.source];
      const releases=refs.map(ref=>this.checked(ref)),releaseIds=releases.map(release=>release.releaseId);
      if(new Set(releaseIds).size!==releaseIds.length)throw new Error('发行版选择重复');
      if(releases.some(release=>!release.fileCount))throw new Error('发行版没有当前成员');
      if(releases.reduce((sum,release)=>sum+release.fileCount,0)>maxItems)throw new Error('每次整理最多 5000 个文件，请分批操作');
      const owners=new Map<string,string>();
      const all=releases.flatMap(release=>{const members=this.members(release.releaseId);for(const member of members)owners.set(member.trackId,release.releaseId);return members;});
      const itemIds=all.map(member=>member.itemId),before=this.snapshot(itemIds,releaseIds);
      let selected=all;const mappings=new Map<string,number>();
      if(request.action==='release-merge'){
        const expected=new Set(releases.flatMap(release=>release.media.map(m=>`${release.releaseId}:${m.discNumber}`)));
        for(const m of request.discMap){if(!m)throw new Error('无效碟映射');validId(m.releaseId);disc(m.sourceDisc);disc(m.targetDisc);const key=`${m.releaseId}:${m.sourceDisc}`;
          if(!expected.has(key)||mappings.has(key))throw new Error('碟映射重复或不属于所选发行版');mappings.set(key,m.targetDisc);}
        if(mappings.size!==expected.size)throw new Error('请确认每张来源碟的目标碟号');
      }else{
        const ids=new Set(request.trackIds),current=new Set(all.map(member=>member.trackId));
        if(ids.size>=current.size||[...ids].some(id=>!current.has(id)))throw new Error('拆分需选择原发行版中的部分曲目，至少保留一首');
        selected=all.filter(member=>ids.has(member.trackId));
      }
      const newId=this.newRelease(releaseIds[0],fields);
      this.copyTracks(newId,selected,member=>request.action==='release-merge'?mappings.get(`${owners.get(member.trackId)}:${member.disc}`)!:member.disc);
      this.changed(releaseIds,itemIds);
      return this.save(request.action,fields?.title??releases[0].title,before,this.snapshot(itemIds,[...releaseIds,newId]));
    });
  }
  undo(changeId:string,commandId:string):CatalogChangeResult{
    validId(changeId);return this.command(commandId,['undo',changeId],()=>{
      const change=this.db.prepare('SELECT * FROM release_change WHERE id=?').get(changeId) as {action:string;title:string;before_json:string;after_json:string;undone_at:number|null}|undefined;
      if(!change||change.action==='undo'||change.undone_at!==null)throw new Error('发行修订不存在或已撤销');
      const before=JSON.parse(change.before_json) as Snapshot,after=JSON.parse(change.after_json) as Snapshot;
      for(const ref of after.releases)this.checked(ref);
      const current=this.snapshot(after.items.map(item=>item.itemId),after.releases.map(ref=>ref.releaseId));
      if(JSON.stringify(current.items)!==JSON.stringify(after.items))throw new Error('发行成员的关联已变化，不能直接撤销');
      for(const item of before.items)this.bind(item.itemId,item.binding);
      const itemIds=before.items.map(item=>item.itemId),releaseIds=after.releases.map(ref=>ref.releaseId);
      this.changed(releaseIds,itemIds);
      this.db.prepare('UPDATE release_change SET undone_at=? WHERE id=?').run(Date.now(),changeId);
      return this.save('undo',change.title,current,this.snapshot(itemIds,releaseIds));
    });
  }
}
