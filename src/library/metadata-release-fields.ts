import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {CatalogChangeResult,ReleaseRef,MetadataPolicyRef} from '../shared/contracts.js';
import type {MetadataReleaseContext} from '../shared/metadata-release-context.js';
import {releaseOnlineFields,readReleaseFieldsApply,readReleaseFieldsUndo,type ReleaseOnlineField,type ReleaseFieldsReview,type ReleaseFieldsApply,type ReleaseFieldsUndo,type ReleaseFieldsUndoPreview,type ReleaseFieldsUndoResult} from '../shared/metadata-release-fields.js';
import {metadataFields,scalarValues,provenanceSnapshot,fieldLocked,recordOnlineReleaseField,restoreReleaseField,type ProvenanceSnapshot,MetadataProvenanceRepository} from './metadata-provenance.js';
import {requireOnlineRetention} from './provider-retention.js';
import {CatalogRepository} from './catalog.js';
import {ReleaseCurationRepository} from './release-curation.js';
type Snapshot={release:ReleaseRef;fields:Record<string,string|null>;profile:boolean;items:Array<{itemId:string;revision:number}>;provenance:ProvenanceSnapshot;automatic:Record<string,string|null>;onlineRelease?:{version:1;provider:'musicbrainz';fields:ReleaseOnlineField[];sourceUrl:string;fetchedAt:string};onlineReleaseUndo?:{version:1;originalChangeId:string;fields:ReleaseOnlineField[]}};
type Grant={review:ReleaseFieldsReview;release:ReleaseRef;policy:MetadataPolicyRef;itemFingerprint:string;candidateToken:string;requestId:string;fetchedAt:string};
type Change={id:string;action:string;title:string;before_json:string;after_json:string;undone_at:number|null};
const hash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class MetadataReleaseFieldsRepository {
 private readonly grants=new Map<string,Grant>();
 private expiryTimer:NodeJS.Timeout|undefined;
 constructor(private readonly db:DatabaseSync,private readonly catalog:CatalogRepository,private readonly releases:ReleaseCurationRepository,private readonly provenance:MetadataProvenanceRepository,private readonly refreshSearch:(id:string)=>void){}
 clear(requestId?:string):void{for(const [token,g] of this.grants)if(requestId===undefined||g.requestId===requestId)this.grants.delete(token);this.scheduleExpiry();}
 private scheduleExpiry():void{if(this.expiryTimer)clearTimeout(this.expiryTimer);this.expiryTimer=undefined;if(!this.grants.size)return;const next=Math.min(...[...this.grants.values()].map(g=>Date.parse(g.review.expiresAt)));this.expiryTimer=setTimeout(()=>{this.expiryTimer=undefined;for(const [token,g] of this.grants)if(Date.parse(g.review.expiresAt)<=Date.now())this.grants.delete(token);this.scheduleExpiry();},Math.max(1,next-Date.now()));this.expiryTimer.unref();}
 review(input:{itemId:string;releaseId:string;itemFingerprint:string;candidateToken:string;requestId:string;recordingId:string;context:MetadataReleaseContext;fetchedAt:string;expiresAt:string}):ReleaseFieldsReview|null{
  const now=Date.now();for(const [token,g] of this.grants)if(Date.parse(g.review.expiresAt)<=now)this.grants.delete(token);
  if(!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)<=now||!Number.isFinite(Date.parse(input.fetchedAt))||!input.context.media.some(m=>m.tracks.some(t=>t.recordingId===input.recordingId.toLowerCase())))return null;
  const release=this.releases.summary(input.releaseId);if(!release.fileCount||release.fileCount>5000)return null;
  const policy=this.provenance.get('release',input.releaseId),values=scalarValues(this.db,'release',input.releaseId),review:ReleaseFieldsReview={reviewToken:randomUUID(),itemId:input.itemId,releaseId:input.releaseId,title:release.title,fileCount:release.fileCount,sourceUrl:`https://musicbrainz.org/release/${input.context.releaseId}`,expiresAt:input.expiresAt,current:Object.fromEntries(releaseOnlineFields.map(f=>[f,values[f]])) as ReleaseFieldsReview['current'],locked:releaseOnlineFields.filter(f=>fieldLocked(this.db,'release',input.releaseId,f)),proposed:{date:input.context.date,country:input.context.country,barcode:input.context.barcode,labels:input.context.labels.filter(v=>v.id!==null).map(v=>({name:v.name,catalogNumber:v.catalogNumber}))}};
  while(this.grants.size>=128)this.grants.delete(this.grants.keys().next().value!);
  this.grants.set(review.reviewToken,{review:structuredClone(review),release:{releaseId:release.releaseId,revision:release.revision,fingerprint:release.fingerprint},policy:{kind:'release',entityId:policy.entityId,revision:policy.revision,fingerprint:policy.fingerprint},itemFingerprint:input.itemFingerprint,candidateToken:input.candidateToken,requestId:input.requestId,fetchedAt:input.fetchedAt});this.scheduleExpiry();return review;
 }
 private identity(request:ReleaseFieldsApply|ReleaseFieldsUndo):string{return hash(['metadata-release-fields-v1',request]);}
 receipt(request:ReleaseFieldsApply):CatalogChangeResult|null{
  const checked=readReleaseFieldsApply(request),row=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(checked.commandId) as {fingerprint:string;result_json:string}|undefined;
  if(!row)return null;if(row.fingerprint!==this.identity(checked))throw new Error('命令 ID 已用于不同操作');return JSON.parse(row.result_json);
 }
 private command<T extends CatalogChangeResult>(request:ReleaseFieldsApply|ReleaseFieldsUndo,action:()=>T):T{
  this.db.exec('BEGIN IMMEDIATE');try{
   const fingerprint=this.identity(request),row=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(request.commandId) as {fingerprint:string;result_json:string}|undefined;
   if(row){if(row.fingerprint!==fingerprint)throw new Error('命令 ID 已用于不同操作');this.db.exec('COMMIT');return JSON.parse(row.result_json);}
   const result=action();this.db.prepare('INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)').run(request.commandId,fingerprint,JSON.stringify(result),new Date().toISOString());this.db.exec('COMMIT');return result;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 private snapshot(id:string):Snapshot{
  const release=this.releases.summary(id),fields=this.db.prepare('SELECT title,date,country,label,catalog_no,barcode,edition,artist_credit_id FROM release WHERE id=?').get(id) as Record<string,string|null>;
  const items=this.db.prepare('SELECT p.id itemId,COALESCE(s.revision,0) revision FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id LEFT JOIN item_catalog_state s ON s.item_id=p.id WHERE m.release_id=? ORDER BY p.id').all(id) as unknown as Snapshot['items'];
  const automatic=Object.fromEntries(releaseOnlineFields.map(f=>[f,(this.db.prepare("SELECT observation_id FROM metadata_auto_source WHERE entity_kind='release' AND entity_id=? AND field=?").get(id,f) as {observation_id:string}|undefined)?.observation_id??null]));
  return {release:{releaseId:id,revision:release.revision,fingerprint:release.fingerprint},fields:{...fields},profile:release.profileConfirmed,items:items.map(v=>({...v})),provenance:provenanceSnapshot(this.db,'release',id),automatic};
 }
 private update(id:string,values:Partial<Record<ReleaseOnlineField,string|null>>):void{
  const keys=Object.keys(values) as ReleaseOnlineField[];if(!keys.length)return;
  this.db.prepare(`UPDATE release SET ${keys.map(f=>`${metadataFields.release[f].column}=?`).join(',')},revision=revision+1 WHERE id=?`).run(...keys.map(f=>values[f]!),id);
  for(const item of this.snapshot(id).items){this.catalog.refreshRevision(item.itemId);this.refreshSearch(item.itemId);}
 }
 private save(before:Snapshot,after:Snapshot,title:string,action:'release-profile'|'undo'):CatalogChangeResult{
  const changeId=randomUUID();this.db.prepare('INSERT INTO release_profile_change(id,action,title,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)').run(changeId,action,title,JSON.stringify(before),JSON.stringify(after),Date.now());return {changeId,items:after.items};
 }
 apply(raw:ReleaseFieldsApply,authorize:(itemId:string,candidateToken:string,fingerprint:string)=>boolean):CatalogChangeResult{
  const request=readReleaseFieldsApply(raw);return this.command(request,()=>{
   const g=this.grants.get(request.reviewToken);if(!g||g.review.itemId!==request.itemId||Date.parse(g.review.expiresAt)<=Date.now())throw new Error('发行资料审核已过期，请重新读取');
   requireOnlineRetention(this.db,'musicbrainz');if(!authorize(request.itemId,g.candidateToken,g.itemFingerprint))throw new Error('歌曲资料或候选已变化，请重新匹配');
   const release=this.releases.summary(g.release.releaseId),policy=this.provenance.get('release',g.release.releaseId);if(release.revision!==g.release.revision||release.fingerprint!==g.release.fingerprint||policy.revision!==g.policy.revision||policy.fingerprint!==g.policy.fingerprint)throw new Error('专辑成员、资料或字段锁已变化，请重新读取');
   const pair=request.labelIndex===undefined?undefined:g.review.proposed.labels[request.labelIndex];if(request.fields.some(f=>f==='label'||f==='catalogNumber')&&!pair||request.labelIndex!==undefined&&!request.fields.some(f=>f==='label'||f==='catalogNumber'))throw new Error('请明确选择唱片公司与目录号条目');
   const before=this.snapshot(release.releaseId),values:Partial<Record<ReleaseOnlineField,string>>={};
   for(const f of request.fields){if(fieldLocked(this.db,'release',release.releaseId,f))throw new Error('所选发行字段已锁定');const value=f==='label'?pair?.name:f==='catalogNumber'?pair?.catalogNumber:g.review.proposed[f];if(typeof value!=='string'||!value.trim())throw new Error('在线来源未提供所选字段，不会自动清空本地值');if(before.fields[metadataFields.release[f].column]===value)throw new Error('所选字段没有值差异，请取消勾选');values[f]=value;recordOnlineReleaseField(this.db,release.releaseId,f,value,g.review.sourceUrl,g.fetchedAt);}
   this.update(release.releaseId,values);const after=this.snapshot(release.releaseId);after.onlineRelease={version:1,provider:'musicbrainz',fields:request.fields,sourceUrl:g.review.sourceUrl,fetchedAt:g.fetchedAt};return this.save(before,after,release.title,'release-profile');
  });
 }
 private change(id:string):{row:Change;before:Snapshot;after:Snapshot}{
  if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error('无效发行修订');
  const row=this.db.prepare('SELECT * FROM release_profile_change WHERE id=?').get(id) as Change|undefined;if(!row)throw new Error('发行修订不存在');const before=JSON.parse(row.before_json) as Snapshot,after=JSON.parse(row.after_json) as Snapshot;if(row.action!=='release-profile'||after.onlineRelease?.version!==1||after.onlineRelease.provider!=='musicbrainz')throw new Error('此修订不属于在线发行字段');return {row,before,after};
 }
 owns(id:string):boolean{const row=this.db.prepare('SELECT after_json FROM release_profile_change WHERE id=?').get(id) as {after_json:string}|undefined;return Boolean(row&&JSON.parse(row.after_json).onlineRelease);}
 preview(id:string):ReleaseFieldsUndoPreview{
  const {row,before,after}=this.change(id),current=this.snapshot(after.release.releaseId),undone=new Set<ReleaseOnlineField>();
  const history=this.db.prepare("SELECT after_json FROM release_profile_change WHERE action='undo' AND json_extract(after_json,'$.onlineReleaseUndo.originalChangeId')=? ORDER BY created_at,id").all(id) as Array<{after_json:string}>;for(const h of history)for(const f of (JSON.parse(h.after_json) as Snapshot).onlineReleaseUndo!.fields)undone.add(f);
  const sameMembers=JSON.stringify(current.items.map(v=>v.itemId))===JSON.stringify(after.items.map(v=>v.itemId));
  const decision=(s:Snapshot,f:string)=>[s.provenance.rows.find(v=>v.field===f)??null,s.provenance.selections?.find(v=>v.field===f)??null,s.automatic[f]??null];
  const fields=after.onlineRelease!.fields.map(f=>{const col=metadataFields.release[f].column,prior=before.fields[col],applied=after.fields[col],value=current.fields[col];const status=undone.has(f)?'undone':!sameMembers||fieldLocked(this.db,'release',current.release.releaseId,f)||value!==applied||JSON.stringify(decision(current,f))!==JSON.stringify(decision(after,f))?'conflict':'ready';return {field:f,before:prior,after:applied,current:value,status,reason:status==='undone'?'已通过补偿修订撤销':!sameMembers?'专辑成员已变化，请保留当前值':status==='conflict'?'字段值、来源、自动候选或锁定已变化，保留当前值':''} as ReleaseFieldsUndoPreview['fields'][number];});
  return {changeId:id,title:row.title,fileCount:current.items.length,fingerprint:hash([id,current,history]),complete:fields.every(f=>f.status==='undone'),fields};
 }
 undo(raw:ReleaseFieldsUndo):ReleaseFieldsUndoResult{
  const request=readReleaseFieldsUndo(raw);return this.command(request,()=>{
   const p=this.preview(request.changeId);if(p.fingerprint!==request.fingerprint)throw new Error('撤销预览已变化，请重新读取');if(request.fields.some(f=>!p.fields.some(v=>v.field===f&&v.status==='ready')))throw new Error('所选字段已变化、锁定或撤销，保留当前值');
   const {before,after}=this.change(request.changeId),current=this.snapshot(after.release.releaseId),values:Partial<Record<ReleaseOnlineField,string|null>>={};for(const f of request.fields){values[f]=before.fields[metadataFields.release[f].column];restoreReleaseField(this.db,after.release.releaseId,f,before.provenance);}
   this.update(after.release.releaseId,values);const restored=this.snapshot(after.release.releaseId);restored.onlineReleaseUndo={version:1,originalChangeId:request.changeId,fields:request.fields};const result=this.save(current,restored,p.title,'undo'),remaining=p.fields.filter(f=>f.status!=='undone'&&!request.fields.includes(f.field)).map(f=>f.field);if(!remaining.length)this.db.prepare('UPDATE release_profile_change SET undone_at=? WHERE id=?').run(Date.now(),request.changeId);return {...result,updated:request.fields,remaining};
  });
 }
 undoEligible(id:string,commandId:string):CatalogChangeResult{throw new Error('在线发行字段需查看逐字段撤销预览后确认');}
}
