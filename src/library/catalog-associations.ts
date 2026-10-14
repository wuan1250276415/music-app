import {copySourceDecisions,recordManual} from './metadata-provenance.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogChangeResult, CatalogItem, CatalogLinkRequest, CatalogChangeSummary } from '../shared/contracts.js';
import { CatalogRepository } from './catalog.js';
import {bumpGroupMembership} from './group-membership-revision.js';

type Binding={recordingId:string;trackId:string};
type ItemSnapshot={itemId:string;binding:Binding|null;revision:number;facts?:{title:string;artist:string;album:string;path:string;recordingId:string;trackId:string;releaseId:string}};
type ReleaseSnapshot={releaseId:string;groupId:string|null;revision:number};
type Snapshot={items:ItemSnapshot[];releases:ReleaseSnapshot[]};
function id(value:unknown):asserts value is string{if(typeof value!=='string'||!value.length||value.length>128)throw new Error('无效曲库 ID');}
function revision(value:unknown):asserts value is number{if(!Number.isSafeInteger(value)||Number(value)<0)throw new Error('无效曲库修订');}

export class CatalogAssociationRepository {
  constructor(private readonly db:DatabaseSync,private readonly catalog:CatalogRepository,private readonly refreshSearch:(id:string)=>void){}

  private command<T>(commandId:string,identity:unknown,action:()=>T):T{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(commandId))throw new Error('无效曲库命令 ID');
    const fingerprint=createHash('sha256').update(JSON.stringify(['catalog',identity])).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const receipt=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as {fingerprint:string;result_json:string}|undefined;
      if(receipt){
        if(receipt.fingerprint!==fingerprint)throw new Error('命令 ID 已用于不同操作');
        const result=JSON.parse(receipt.result_json) as T;this.db.exec('COMMIT');return result;
      }
      const result=action();
      this.db.prepare('INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)')
        .run(commandId,fingerprint,JSON.stringify(result),new Date().toISOString());
      this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  private checkedItem(itemId:string,baseRevision:number):CatalogItem{
    id(itemId);revision(baseRevision);
    const item=this.catalog.project([itemId]).get(itemId);
    if(!item)throw new Error('曲目不存在');
    if(item.revision!==baseRevision)throw new Error('曲库关联已变化，请刷新后重新确认');
    return item;
  }

  private itemSnapshot(itemId:string):ItemSnapshot{
    const row=this.db.prepare('SELECT recording_id,release_track_id FROM item_catalog_binding WHERE item_id=?').get(itemId) as {recording_id:string;release_track_id:string}|undefined;
    const catalog=this.catalog.project([itemId]).get(itemId)!;
    const facts=this.db.prepare(`SELECT COALESCE(o.title,p.title) title,COALESCE(o.artist,p.artist) artist,COALESCE(o.album,p.album) album,
      r.path root_path,f.relative_path FROM playable_item p JOIN media_file f ON f.id=p.file_id JOIN library_root r ON r.id=f.root_id
      LEFT JOIN metadata_override o ON o.item_id=p.id WHERE p.id=?`).get(itemId) as {title:string;artist:string;album:string;root_path:string;relative_path:string};
    return {itemId,binding:row?{recordingId:row.recording_id,trackId:row.release_track_id}:null,revision:catalog.revision,
      facts:{title:facts.title,artist:facts.artist,album:facts.album,path:facts.root_path+'/'+facts.relative_path,
        recordingId:catalog.recordingId,trackId:catalog.releaseTrackId,releaseId:catalog.releaseId}};
  }

  changes(limit=50,offset=0):{items:CatalogChangeSummary[];total:number}{
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw new Error('无效修订查询');
    const total=(this.db.prepare('SELECT COUNT(*) n FROM catalog_change').get() as {n:number}).n;
    const rows=this.db.prepare(`SELECT id,action,created_at createdAt,undone_at IS NOT NULL undone,
      json_array_length(after_json,'$.items') itemCount,COALESCE(json_extract(after_json,'$.onlineGroup.title'),json_extract(before_json,'$.items[0].facts.title'),'曲库关联') title
      FROM catalog_change ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(limit,offset) as unknown as Array<Omit<CatalogChangeSummary,'undone'>&{undone:number}>;
    return {total,items:rows.map(row=>({...row,undone:Number(row.undone)===1}))};
  }

  private bind(itemId:string,binding:Binding|null):void{
    if(binding){
      const track=this.db.prepare('SELECT recording_id FROM release_track WHERE id=?').get(binding.trackId) as {recording_id:string}|undefined;
      if(!track||track.recording_id!==binding.recordingId)throw new Error('发行曲目与录音关联不一致');
      this.db.prepare(`INSERT INTO item_catalog_binding(item_id,recording_id,release_track_id) VALUES(?,?,?)
        ON CONFLICT(item_id) DO UPDATE SET recording_id=excluded.recording_id,release_track_id=excluded.release_track_id`)
        .run(itemId,binding.recordingId,binding.trackId);
    }else this.db.prepare('DELETE FROM item_catalog_binding WHERE item_id=?').run(itemId);
    this.catalog.sync(itemId);this.refreshSearch(itemId);
  }

  private copyCredit(creditId:string|null):string|null{
    if(!creditId)return null;
    const newId=randomUUID();
    this.db.prepare(`INSERT INTO artist_credit(id,owner_key,display_text)
      SELECT ?,?,display_text FROM artist_credit WHERE id=?`).run(newId,`confirmed:${newId}`,creditId);
    this.db.prepare(`INSERT INTO artist_credit_member(credit_id,ordinal,artist_id,role,join_phrase)
      SELECT ?,ordinal,artist_id,role,join_phrase FROM artist_credit_member WHERE credit_id=?`).run(newId,creditId);
    return newId;
  }

  private confirmedRecording(recordingId:string):string{
    const row=this.db.prepare('SELECT local_key,artist_credit_id FROM recording WHERE id=?').get(recordingId) as {local_key:string|null;artist_credit_id:string|null};
    if(row.local_key===null||this.catalog.recordingProfilesEnabled&&this.db.prepare('SELECT 1 FROM recording_profile_state WHERE recording_id=? AND confirmed=1').get(recordingId))return recordingId;
    const newId=randomUUID(),credit=this.copyCredit(row.artist_credit_id);
    this.db.prepare(`INSERT INTO recording(id,title,artist_credit_id,duration_us,version_label,local_key)
      SELECT ?,title,?,duration_us,version_label,NULL FROM recording WHERE id=?`).run(newId,credit,recordingId);
    if(this.catalog.metadataProvenanceEnabled)copySourceDecisions(this.db,'recording',recordingId,newId);
    return newId;
  }

  private confirmedTrack(trackId:string,recordingId:string):string{
    const row=this.db.prepare('SELECT medium_id,artist_credit_id,recording_id,local_key FROM release_track WHERE id=?').get(trackId) as
      {medium_id:string;artist_credit_id:string|null;recording_id:string;local_key:string};
    if(row.local_key.startsWith('confirmed:')&&row.recording_id===recordingId)return trackId;
    const newId=randomUUID(),credit=this.copyCredit(row.artist_credit_id);
    const position=(this.db.prepare('SELECT COALESCE(MAX(position),0)+1 n FROM release_track WHERE medium_id=?').get(row.medium_id) as {n:number}).n;
    this.db.prepare(`INSERT INTO release_track(id,medium_id,position,printed_number,recording_id,artist_credit_id,title,local_key)
      SELECT ?,medium_id,?,printed_number,?,?,title,? FROM release_track WHERE id=?`)
      .run(newId,position,recordingId,credit,`confirmed:${newId}`,trackId);
    return newId;
  }

  private affectedReleases(releaseIds:string[]):string[]{
    if(!releaseIds.length)return [];
    return (this.db.prepare(`SELECT p.id FROM playable_item p JOIN release_track t ON t.id=p.release_track_id
      JOIN medium m ON m.id=t.medium_id WHERE m.release_id IN (${releaseIds.map(()=>'?').join(',')})`).all(...releaseIds) as unknown as Array<{id:string}>).map(row=>row.id);
  }

  private saveChange(action:string,before:Snapshot,after:Snapshot):CatalogChangeResult{
    const changeId=randomUUID();
    this.db.prepare('INSERT INTO catalog_change(id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?)')
      .run(changeId,action,JSON.stringify(before),JSON.stringify(after),Date.now());
    return {changeId,items:after.items.map(item=>({itemId:item.itemId,revision:item.revision}))};
  }

  link(request:CatalogLinkRequest):CatalogChangeResult{
    if(!request||!['recording','version','reset','group'].includes(request.action)||!Array.isArray(request.items)||!request.items.length||request.items.length>100)throw new Error('每次请选择 1–100 首曲目');
    for(const item of request.items){if(!item)throw new Error('无效曲目');id(item.itemId);revision(item.revision);}
    if(new Set(request.items.map(item=>item.itemId)).size!==request.items.length)throw new Error('曲目选择重复');
    const identity=[request.action,request.items.map(item=>[item.itemId,item.revision]),
      request.action==='group'?[request.title,request.releases?.map(release=>[release.releaseId,release.revision])]:
      request.action==='reset'?null:[request.target?.itemId,request.target?.revision]];
    return this.command(request.commandId,identity,()=>{
      const selected=request.items.map(item=>({id:item.itemId,catalog:this.checkedItem(item.itemId,item.revision)}));
      const before:Snapshot={items:selected.map(item=>this.itemSnapshot(item.id)),releases:[]};
      if(request.action==='reset'){
        if(before.items.every(item=>item.binding===null))throw new Error('所选曲目没有人工关联');
        for(const item of selected)this.bind(item.id,null);
      }else if(request.action==='group'){
        if(typeof request.title!=='string'||!request.title.trim()||request.title.trim().length>240||/[\u0000-\u001f]/.test(request.title))throw new Error('专辑概念名称需为 1–240 个字符');
        if(!Array.isArray(request.releases)||request.releases.length<2||request.releases.length>100||new Set(request.releases.map(r=>r.releaseId)).size!==request.releases.length)throw new Error('请选择至少两个不同发行版');
        if(new Set(selected.map(item=>item.catalog.releaseId)).size!==request.releases.length||selected.some(item=>!request.releases.some(r=>r.releaseId===item.catalog.releaseId)))throw new Error('发行版与所选曲目不一致');
        for(const release of request.releases){
          id(release.releaseId);revision(release.revision);
          const row=this.db.prepare('SELECT group_id,revision FROM release WHERE id=?').get(release.releaseId) as {group_id:string|null;revision:number}|undefined;
          if(!row||row.revision!==release.revision)throw new Error('发行版已变化，请刷新后重新确认');
          before.releases.push({releaseId:release.releaseId,groupId:row.group_id,revision:row.revision});
        }
        const groupId=randomUUID();this.db.prepare('INSERT INTO release_group(id,title) VALUES(?,?)').run(groupId,request.title.trim());
        if(this.catalog.metadataProvenanceEnabled)recordManual(this.db,'release_group',groupId,null,{title:request.title.trim(),type:null});
        for(const release of before.releases)this.db.prepare('UPDATE release SET group_id=?,revision=revision+1 WHERE id=?').run(groupId,release.releaseId);
        bumpGroupMembership(this.db,[groupId,...before.releases.map(r=>r.groupId)]);
        for(const itemId of this.affectedReleases(before.releases.map(r=>r.releaseId))){this.catalog.refreshRevision(itemId);this.refreshSearch(itemId);}
        const after:Snapshot={items:selected.map(item=>this.itemSnapshot(item.id)),releases:before.releases.map(r=>({releaseId:r.releaseId,groupId,revision:r.revision+1}))};
        return {...this.saveChange(request.action,before,after),groupId};
      }else{
        if(!request.target||selected.some(item=>item.id===request.target.itemId))throw new Error('请选择另一首曲目作为关联目标');
        const target=this.checkedItem(request.target.itemId,request.target.revision);
        if(selected.every(item=>item.catalog.confirmed&&(request.action==='version'?item.catalog.releaseTrackId===target.releaseTrackId:item.catalog.recordingId===target.recordingId)))throw new Error('所选曲目已经具有这项人工关联');
        const targetSnapshot=this.itemSnapshot(request.target.itemId);before.items.push(targetSnapshot);
        const recordingId=this.confirmedRecording(target.recordingId),targetTrack=this.confirmedTrack(target.releaseTrackId,recordingId);
        this.bind(request.target.itemId,{recordingId,trackId:targetTrack});
        const tracks=new Map<string,string>([[target.releaseTrackId,targetTrack]]);
        for(const item of selected){
          let trackId=targetTrack;
          if(request.action==='recording'){
            trackId=tracks.get(item.catalog.releaseTrackId)??this.confirmedTrack(item.catalog.releaseTrackId,recordingId);
            tracks.set(item.catalog.releaseTrackId,trackId);
          }
          this.bind(item.id,{recordingId,trackId});
        }
      }
      const after:Snapshot={items:before.items.map(item=>this.itemSnapshot(item.itemId)),releases:[]};
      return this.saveChange(request.action,before,after);
    });
  }

  undo(changeId:string,commandId:string):CatalogChangeResult{
    id(changeId);
    return this.command(commandId,['undo',changeId],()=>{
      const change=this.db.prepare('SELECT action,before_json,after_json,undone_at FROM catalog_change WHERE id=?').get(changeId) as
        {action:string;before_json:string;after_json:string;undone_at:number|null}|undefined;
      if(!change||change.undone_at!==null||change.action==='undo')throw new Error('曲库修订不存在或已撤销');
      const before=JSON.parse(change.before_json) as Snapshot,after=JSON.parse(change.after_json) as Snapshot;
      for(const item of after.items){
        this.checkedItem(item.itemId,item.revision);
        if(JSON.stringify(this.itemSnapshot(item.itemId).binding)!==JSON.stringify(item.binding))throw new Error('人工关联已变化，不能直接撤销');
      }
      for(const release of after.releases){
        const row=this.db.prepare('SELECT group_id,revision FROM release WHERE id=?').get(release.releaseId) as {group_id:string|null;revision:number};
        if(row.group_id!==release.groupId||row.revision!==release.revision)throw new Error('专辑概念已变化，不能直接撤销');
      }
      for(const item of before.items)this.bind(item.itemId,item.binding);
      for(const release of before.releases)this.db.prepare('UPDATE release SET group_id=?,revision=revision+1 WHERE id=?').run(release.groupId,release.releaseId);
      if(before.releases.length)bumpGroupMembership(this.db,[...before.releases.map(r=>r.groupId),...after.releases.map(r=>r.groupId)]);
      for(const itemId of this.affectedReleases(before.releases.map(r=>r.releaseId))){this.catalog.refreshRevision(itemId);this.refreshSearch(itemId);}
      this.db.prepare('UPDATE catalog_change SET undone_at=? WHERE id=?').run(Date.now(),changeId);
      const restored:Snapshot={items:before.items.map(item=>this.itemSnapshot(item.itemId)),releases:before.releases.map(r=>({releaseId:r.releaseId,groupId:r.groupId,revision:r.revision+2}))};
      return this.saveChange('undo',after,restored);
    });
  }
}
