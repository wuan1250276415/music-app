import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {LibraryItem,MetadataChangeResult,MetadataField,MetadataUndoField,MetadataUndoPreview,MetadataUndoRequest} from '../shared/contracts.js';
import {provenanceSnapshot,restoreMetadataField,type ProvenanceSnapshot} from './metadata-provenance.js';

const fields:MetadataField[]=['title','artist','album'],uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const metadataUndoSchema=`
 CREATE TABLE metadata_compensation(id TEXT PRIMARY KEY,change_id TEXT NOT NULL REFERENCES metadata_change(id),item_id TEXT NOT NULL REFERENCES playable_item(id),title TEXT NOT NULL,fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),created_at INTEGER NOT NULL);
 CREATE INDEX idx_metadata_compensation_change ON metadata_compensation(change_id,created_at);
 CREATE TABLE metadata_undo_member(change_id TEXT NOT NULL REFERENCES metadata_change(id),field TEXT NOT NULL CHECK(field IN('title','artist','album')),compensation_id TEXT NOT NULL REFERENCES metadata_compensation(id),PRIMARY KEY(change_id,field));
 CREATE TRIGGER metadata_compensation_immutable BEFORE UPDATE ON metadata_compensation BEGIN SELECT RAISE(ABORT,'补偿修订不可改写'); END;
 CREATE TRIGGER metadata_compensation_no_delete BEFORE DELETE ON metadata_compensation BEGIN SELECT RAISE(ABORT,'补偿修订不可删除'); END;
 CREATE TRIGGER metadata_undo_member_immutable BEFORE UPDATE ON metadata_undo_member BEGIN SELECT RAISE(ABORT,'字段撤销记录不可改写'); END;
 CREATE TRIGGER metadata_undo_member_no_delete BEFORE DELETE ON metadata_undo_member BEGIN SELECT RAISE(ABORT,'字段撤销记录不可删除'); END;
 CREATE TRIGGER metadata_compensation_owner BEFORE INSERT ON metadata_compensation WHEN NOT EXISTS(SELECT 1 FROM metadata_change m WHERE m.id=NEW.change_id AND m.item_id=NEW.item_id) BEGIN SELECT RAISE(ABORT,'补偿修订曲目归属错误'); END;
 CREATE TRIGGER metadata_undo_member_owner BEFORE INSERT ON metadata_undo_member WHEN NOT EXISTS(SELECT 1 FROM metadata_compensation c,json_each(c.fields_json) f WHERE c.id=NEW.compensation_id AND c.change_id=NEW.change_id AND f.value=NEW.field) BEGIN SELECT RAISE(ABORT,'撤销字段不属于补偿修订'); END;
 ALTER TABLE metadata_batch_row ADD COLUMN undo_result_json TEXT CHECK(undo_result_json IS NULL OR json_valid(undo_result_json));
`;
type Values=Record<MetadataField,string|null>;
type Snapshot=Values&{provenance?:ProvenanceSnapshot;effective?:Record<MetadataField,string>;updated?:MetadataField[]};
type Change={id:string;item_id:string;after_revision:number;before_json:string;after_json:string;undone_at:string|null};
interface Dependencies {item(id:string):LibraryItem|undefined;refresh(id:string):void;catalogRevision(id:string):number}
function decision(snapshot:ProvenanceSnapshot|undefined,field:MetadataField):unknown{return [snapshot?.rows.find(value=>value.field===field)??null,snapshot?.selections?.find(value=>value.field===field)??null];}
export class MetadataUndoRepository {
 constructor(private readonly db:DatabaseSync,private readonly dependencies:Dependencies){}
 owns(id:string):boolean{return Boolean(this.db.prepare('SELECT 1 FROM metadata_change WHERE id=?').get(id));}
 private change(id:string):Change{if(typeof id!=='string'||!uuid.test(id))throw new Error('无效元数据修订');const row=this.db.prepare('SELECT * FROM metadata_change WHERE id=?').get(id) as Change|undefined;if(!row)throw new Error('元数据修订不存在');return row;}
 private current(id:string):Values&{revision:number}{return (this.db.prepare('SELECT title,artist,album,revision FROM metadata_override WHERE item_id=?').get(id) as Values&{revision:number}|undefined)??{title:null,artist:null,album:null,revision:0};}
 preview(id:string):MetadataUndoPreview{
  const change=this.change(id),before=JSON.parse(change.before_json) as Snapshot,after=JSON.parse(change.after_json) as Snapshot,item=this.dependencies.item(change.item_id);if(!item)throw new Error('修订对应曲目不存在');
  const current=this.current(item.id),provenance=provenanceSnapshot(this.db,'playable_item',item.id),raw=this.db.prepare('SELECT title,artist,album FROM playable_item WHERE id=?').get(item.id) as Record<MetadataField,string>;
  const updated=Array.isArray(after.updated)?after.updated:fields.filter(field=>before[field]!==after[field]);if(!updated.length||updated.some(field=>!fields.includes(field))||new Set(updated).size!==updated.length)throw new Error('原修订字段记录无效');
  const undone=new Set((this.db.prepare('SELECT field FROM metadata_undo_member WHERE change_id=?').all(id) as unknown as Array<{field:MetadataField}>).map(row=>row.field));
  const result:MetadataUndoField[]=updated.map(field=>{
   const automatic=before[field]===null,restore=automatic?raw[field]:before[field],observed=before.provenance?.rows.find(value=>value.field===field)?.observation_id;
   let status:MetadataUndoField['status']='ready',reason:string|null=null;
   const live=provenance.rows.find(value=>value.field===field),collection=provenance.collections?.rows.find(value=>value.field==='artists');
   if(change.undone_at||undone.has(field)){status='undone';reason='此字段已撤销';}
   else if(current[field]!==after[field]){status='conflict';reason='覆盖值已被后续修改';}
   else if(after.effective&&item[field]!==after.effective[field]){status='conflict';reason='有效展示值或艺人身份已变化';}
   else if(live?.locked){status='conflict';reason='字段已被锁定';}
   else if(field==='artist'&&(item.catalog?.creditConfirmed||collection?.locked===1||collection?.mode&&collection.mode!=='automatic')){status='conflict';reason='歌曲已有独立确认或锁定的署名';}
   else if(after.provenance?digest(decision(provenance,field))!==digest(decision(after.provenance,field)):current.revision!==change.after_revision||fields.some(value=>current[value]!==after[value])||Boolean(live)){status='conflict';reason=after.provenance?'字段来源、选择或修订已变化':'旧修订缺少来源快照，无法证明可安全撤销';}
   let source:string|null=null,rights:string|null=null;
   const restorationId=automatic?(this.db.prepare("SELECT observation_id FROM metadata_auto_source WHERE entity_kind='playable_item' AND entity_id=? AND field=?").get(item.id,field) as {observation_id:string}|undefined)?.observation_id:observed;
   if(restorationId){const row=this.db.prepare("SELECT o.source,o.value_json,r.policy_json FROM metadata_observation o JOIN provider_rights r ON r.id=o.rights_id WHERE o.id=? AND o.entity_kind='playable_item' AND o.entity_id=? AND o.field=?").get(restorationId,item.id,field) as {source:string;value_json:string;policy_json:string}|undefined;const policy=row?JSON.parse(row.policy_json):null;source=row?.source??null;rights=policy?.label??null;if(status==='ready'&&(!policy||policy.display!==true||policy.persist!==true||policy.expires!=null&&(!Number.isFinite(Date.parse(policy.expires))||Date.parse(policy.expires)<=Date.now()))){status='conflict';reason='恢复来源缺失、过期或权限不足';}}
   else if(status==='ready'&&!automatic&&before.provenance&&observed){status='conflict';reason='恢复来源已不存在';}
   return {field,status,reason,before:before.effective?.[field]??before[field],after:after.effective?.[field]??after[field],current:item[field],restore,restoreAutomatic:automatic,source,rights};
  });
  const fingerprint=digest([change,current,provenance,raw,item.catalog,result,[...undone].sort()]);return {changeId:id,itemId:item.id,title:item.title,revision:current.revision,fingerprint,fields:result,complete:result.every(field=>field.status==='undone')};
 }
 private receipt(commandId:string,identity:unknown):MetadataChangeResult|null{if(typeof commandId!=='string'||!uuid.test(commandId))throw new Error('无效撤销命令 ID');const row=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as {fingerprint:string;result_json:string}|undefined;if(!row)return null;if(row.fingerprint!==digest(['metadata-undo',identity]))throw new Error('命令 ID 已用于不同撤销');return JSON.parse(row.result_json);}
 private command(commandId:string,identity:unknown,action:()=>MetadataChangeResult):MetadataChangeResult{this.db.exec('BEGIN IMMEDIATE');try{const prior=this.receipt(commandId,identity);if(prior){this.db.exec('COMMIT');return prior;}const result=action();this.db.prepare('INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)').run(commandId,digest(['metadata-undo',identity]),JSON.stringify(result),new Date().toISOString());this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 apply(request:MetadataUndoRequest):MetadataChangeResult{if(!request)throw new Error('无效撤销请求');return this.command(request.commandId,request,()=>this.applyInTransaction(request));}
 eligible(commandId:string,changeId:string):MetadataChangeResult{return this.command(commandId,{action:'eligible',changeId},()=>{const result=this.eligibleInTransaction(changeId);if(!result.updated.length)throw new Error('没有可撤销的字段：'+result.conflicts?.map(value=>value.reason).join('；'));return result;});}
 applyInTransaction(request:Omit<MetadataUndoRequest,'commandId'>):MetadataChangeResult{
  if(!Array.isArray(request.fields)||!request.fields.length||request.fields.length>3||new Set(request.fields).size!==request.fields.length||request.fields.some(field=>!fields.includes(field)))throw new Error('请选择有效且不重复的撤销字段');
  const preview=this.preview(request.changeId);if(typeof request.fingerprint!=='string'||request.fingerprint!==preview.fingerprint)throw new Error('撤销预览已变化，请重新读取');const chosen=request.fields.map(field=>{const value=preview.fields.find(value=>value.field===field);if(!value||value.status!=='ready')throw new Error('所选字段已撤销或存在冲突');return value;});
  const change=this.change(preview.changeId),before=JSON.parse(change.before_json) as Snapshot,current=this.current(preview.itemId),sourceBefore=provenanceSnapshot(this.db,'playable_item',preview.itemId),values={...current};
  for(const selected of chosen){values[selected.field]=before[selected.field];restoreMetadataField(this.db,preview.itemId,selected.field,before.provenance,selected.restoreAutomatic);}
  const revision=current.revision+1;this.db.prepare('UPDATE metadata_override SET title=?,artist=?,album=?,revision=? WHERE item_id=?').run(values.title,values.artist,values.album,revision,preview.itemId);this.dependencies.refresh(preview.itemId);
  const undoId=randomUUID(),updated=chosen.map(value=>value.field),sourceAfter=provenanceSnapshot(this.db,'playable_item',preview.itemId),item=this.dependencies.item(preview.itemId)!;
  this.db.prepare('INSERT INTO metadata_compensation(id,change_id,item_id,title,fields_json,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(undoId,change.id,preview.itemId,preview.title,JSON.stringify(updated),JSON.stringify({values:current,provenance:sourceBefore}),JSON.stringify({values:{title:values.title,artist:values.artist,album:values.album,revision},provenance:sourceAfter,effective:{title:item.title,artist:item.artist,album:item.album},items:[{itemId:item.id,revision:this.dependencies.catalogRevision(item.id)}]}),Date.now());
  for(const field of updated)this.db.prepare('INSERT INTO metadata_undo_member(change_id,field,compensation_id) VALUES(?,?,?)').run(change.id,field,undoId);
  const rest=this.preview(change.id),remaining=rest.fields.filter(value=>value.status!=='undone').map(value=>value.field);if(!remaining.length)this.db.prepare('UPDATE metadata_change SET undone_at=? WHERE id=?').run(new Date().toISOString(),change.id);
  return {changeId:change.id,undoId,revision,updated,remaining,conflicts:rest.fields.filter(value=>value.status==='conflict').map(value=>({field:value.field,reason:value.reason!}))};
 }
 eligibleInTransaction(id:string):MetadataChangeResult{const preview=this.preview(id),ready=preview.fields.filter(value=>value.status==='ready').map(value=>value.field);if(preview.complete)throw new Error('修订已撤销');if(!ready.length)return {changeId:id,revision:preview.revision,updated:[],remaining:preview.fields.filter(value=>value.status!=='undone').map(value=>value.field),conflicts:preview.fields.filter(value=>value.status==='conflict').map(value=>({field:value.field,reason:value.reason!}))};return this.applyInTransaction({changeId:id,fingerprint:preview.fingerprint,fields:ready});}
}
