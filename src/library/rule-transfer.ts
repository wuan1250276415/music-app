import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import type {SmartPlaylists} from './smart-playlists.js';
import type {FilterPresets} from './filter-presets.js';
import {RULE_REFERENCE_PAGE_SIZE,mapRuleEntry,readRuleBundle,readRuleExportRequest,readRuleInspectionRequest,readRuleImportRequest,readRuleImportValue,readRuleReferenceQuery,ruleEntryKey,ruleReferenceKey,ruleReferences,selectedRuleEntries,type RuleBundle,type RuleEntry,type RuleImportRequest,type RuleImportResult,type RuleImportValue,type RuleReference,type RuleReferenceKind,type RuleReferencePage,type RuleTransferInspection} from '../shared/rule-transfer.js';
import {smartPlaylistId} from '../shared/smart-playlists.js';

export const ruleTransferSchema=`
 CREATE TABLE rule_transfer_origin(slot INTEGER PRIMARY KEY CHECK(slot=1),id TEXT NOT NULL CHECK(length(id)=36));
 CREATE TRIGGER rule_transfer_origin_immutable BEFORE UPDATE ON rule_transfer_origin BEGIN SELECT RAISE(ABORT,'曲库规则来源身份不可修改'); END;
 CREATE TRIGGER rule_transfer_origin_no_delete BEFORE DELETE ON rule_transfer_origin BEGIN SELECT RAISE(ABORT,'曲库规则来源身份不可删除'); END;
 CREATE TABLE rule_transfer_audit(command_id TEXT PRIMARY KEY REFERENCES user_command_receipt(command_id) ON DELETE RESTRICT,bundle_digest TEXT NOT NULL CHECK(length(bundle_digest)=64 AND bundle_digest NOT GLOB '*[^0-9a-f]*'),request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=2097152),created_at TEXT NOT NULL);
 CREATE TRIGGER rule_transfer_audit_immutable BEFORE UPDATE ON rule_transfer_audit BEGIN SELECT RAISE(ABORT,'规则导入记录不可修改'); END;
 CREATE TRIGGER rule_transfer_audit_no_delete BEFORE DELETE ON rule_transfer_audit BEGIN SELECT RAISE(ABORT,'规则导入记录不可删除'); END;
 CREATE TRIGGER rule_transfer_audit_budget BEFORE INSERT ON rule_transfer_audit WHEN (SELECT COUNT(*) FROM rule_transfer_audit)>=512 OR (SELECT COALESCE(SUM(length(CAST(request_json AS BLOB))),0) FROM rule_transfer_audit)+length(CAST(NEW.request_json AS BLOB))>134217728 BEGIN SELECT RAISE(ABORT,'规则导入记录达到保留预算，请先完成受控曲库归档'); END;
`;
type Row=Record<string,SQLInputValue>;
type Receipt={fingerprint:string;result_json:string};
const sha=(domain:string,value:unknown)=>createHash('sha256').update(domain).update(JSON.stringify(value)).digest('hex');
export const ruleBundleDigest=(bundle:RuleBundle):string=>sha('aural-rule-bundle-v1:',readRuleBundle(bundle));
const requestDigest=(request:RuleImportRequest)=>sha('aural-rule-import-v1:',request);
const label=(v:unknown,fallback:string)=>String(v??fallback).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,512).trim()||fallback;
const tables:Record<RuleReferenceKind,{from:string;name:string;active:string}>= {
 artist:{from:'artist e',name:'e.name',active:"e.archived=0 AND NOT EXISTS(SELECT 1 FROM artist_identity_binding b WHERE b.source_artist_id=e.id)"},
 release:{from:'release e',name:'e.title',active:'1'},group:{from:'release_group e',name:'e.title',active:'1'},genre:{from:'genre e',name:'e.name',active:'e.archived=0'},root:{from:'library_root e',name:'e.path',active:'1'}
};

export class RuleTransfers {
 private readonly epoch=randomUUID();private readonly secret=randomBytes(32);private clockInstalled=false;
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T,private readonly smart:SmartPlaylists,private readonly presets:FilterPresets){this.origin();}
 private origin():string{const row=this.db.prepare('SELECT id FROM rule_transfer_origin WHERE slot=1').get() as {id:string}|undefined;if(!row)throw new Error('曲库规则来源身份缺失');return smartPlaylistId(row.id);}
 private referenceStamp():string{
  if(!this.clockInstalled){
   this.transaction(()=>{this.db.exec('CREATE TEMP TABLE aural_rule_reference_clock(revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991));INSERT INTO temp.aural_rule_reference_clock VALUES(0)');for(const table of ['artist','artist_identity_state','artist_identity_binding','artist_credit','artist_credit_member','release','release_group','genre','library_root'])for(const action of ['INSERT','UPDATE','DELETE'])this.db.exec(`CREATE TEMP TRIGGER aural_rule_reference_${table}_${action.toLowerCase()} AFTER ${action} ON main.${table} BEGIN UPDATE aural_rule_reference_clock SET revision=revision+1; END;`);});this.clockInstalled=true;
  }
  const row=this.db.prepare('SELECT revision FROM temp.aural_rule_reference_clock').get() as {revision:number},external=this.db.prepare('PRAGMA main.data_version').get() as {data_version:number};return `${row.revision}:${external.data_version}`;
 }
 private reference(kind:RuleReferenceKind,id:string,active:boolean):RuleReference|null {
  let row:Row|undefined;
  if(kind==='artist')row=this.db.prepare('SELECT a.*,COALESCE(s.revision,0) identity_revision,b.identity_artist_id FROM artist a LEFT JOIN artist_identity_state s ON s.artist_id=a.id LEFT JOIN artist_identity_binding b ON b.source_artist_id=a.id WHERE a.id=?').get(id) as Row|undefined;
  else if(kind==='release')row=this.db.prepare('SELECT r.*,c.display_text artist FROM release r LEFT JOIN artist_credit c ON c.id=r.artist_credit_id WHERE r.id=?').get(id) as Row|undefined;
  else if(kind==='group')row=this.db.prepare('SELECT * FROM release_group WHERE id=?').get(id) as Row|undefined;
  else if(kind==='genre')row=this.db.prepare('SELECT g.*,p.name parent_name FROM genre g LEFT JOIN genre p ON p.id=g.parent_id WHERE g.id=?').get(id) as Row|undefined;
  else row=this.db.prepare('SELECT id,path FROM library_root WHERE id=?').get(id) as Row|undefined;
  if(!row||active&&(row.archived===1||kind==='artist'&&row.identity_artist_id!==null))return null;
  const name=label(kind==='root'?path.basename(String(row.path))||row.path:row.name??row.title,id);
  const context=label(kind==='artist'?`${row.disambiguation??''}${row.identity_artist_id?' · 已关联其他身份':''}${row.archived===1?' · 已归档':''}`:kind==='release'?[row.artist,row.date,row.edition,row.country,row.catalog_no,row.local_context].filter(Boolean).join(' · '):kind==='genre'?[row.parent_name,row.archived===1?'已归档':null].filter(Boolean).join(' · '):kind==='root'?row.path:row.type,'');
  return {kind,id,name,context,fingerprint:sha('aural-rule-reference-v1:',[kind,row])};
 }
 export(value:unknown):RuleBundle {
  const request=readRuleExportRequest(value);
  return this.transaction(()=>{
   const entries:RuleEntry[]=request.items.map(item=>{
    const current=item.kind==='smart'?this.smart.get(item.id):this.presets.get(item.id);
    if(current.revision!==item.revision)throw new Error('规则已更新，请重新读取后导出');
    return {kind:item.kind,id:current.id,name:current.name,definition:current.definition} as RuleEntry;
   });
   const references=ruleReferences(entries).map(ref=>this.reference(ref.kind,ref.id,false)??{...ref,name:`已失效引用 ${ref.id}`,context:'原资料已不存在，导入时需明确匹配',fingerprint:sha('aural-rule-missing-reference-v1:',ref)});
   return readRuleBundle({format:'aural-rule-bundle',version:1,origin:this.origin(),exportedAt:new Date().toISOString(),entries,references});
  });
 }
 inspect(value:unknown):RuleTransferInspection {
  const r=readRuleInspectionRequest(value),bundle=r.bundle,entries=selectedRuleEntries(bundle,r.selected),neededKeys=ruleReferences(entries).map(ruleReferenceKey);
  return this.transaction(()=>{
   const sameLibrary=bundle.origin===this.origin(),needed=bundle.references.filter(ref=>neededKeys.includes(ruleReferenceKey(ref))),suggested=[] as RuleTransferInspection['suggested'];
   if(sameLibrary)for(const ref of needed){const current=this.reference(ref.kind,ref.id,true);if(current?.fingerprint===ref.fingerprint)suggested.push({source:ruleReferenceKey(ref),target:current});}
   const retained=r.mappings.filter(mapping=>{const current=this.reference(mapping.target.kind,mapping.target.id,true);return current&&JSON.stringify(current)===JSON.stringify(mapping.target);});
   return {digest:ruleBundleDigest(bundle),sameLibrary,needed,suggested,retained};
  });
 }
 private cursor(value:unknown):string{const raw=Buffer.from(JSON.stringify(value)).toString('base64url');return `${raw}.${createHmac('sha256',this.secret).update(raw).digest('base64url')}`;}
 private readCursor(token:string):Record<string,unknown>{
  const parts=token.split('.');if(parts.length!==2||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))throw new Error('目标目录分页凭证无效');
  const expected=createHmac('sha256',this.secret).update(parts[0]).digest(),actual=Buffer.from(parts[1],'base64url');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error('目标目录分页凭证已失效，请重新搜索');
  const value:unknown=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('目标目录分页凭证无效');return value as Record<string,unknown>;
 }
 search(value:unknown):RuleReferencePage {
  const request=readRuleReferenceQuery(value),snapshot=()=>sha('aural-rule-reference-page-v1:',[this.epoch,this.referenceStamp(),request.kind,request.query]),before=snapshot(),table=tables[request.kind];
  const stale=():RuleReferencePage=>({kind:request.kind,query:request.query,status:'stale',snapshot:snapshot(),items:[],nextCursor:null});
  const conditions=[table.active],params:SQLInputValue[]=[];
  if(request.query){conditions.push(`lower(${table.name}) LIKE lower(?) ESCAPE '\\'`);params.push(`%${request.query.replace(/[\\%_]/g,'\\$&')}%`);}
  if(request.cursor){
   const c=this.readCursor(request.cursor);if(c.epoch!==this.epoch||c.kind!==request.kind||c.query!==request.query)throw new Error('目标目录分页范围不一致');
   if(c.snapshot!==before)return stale();
   if(typeof c.keyDigest!=='string'||!/^[a-f0-9]{64}$/.test(c.keyDigest)||typeof c.id!=='string'||!c.id||c.id.length>128)throw new Error('目标目录分页位置无效');
   const previous=this.db.prepare(`SELECT aural_natural_key_v1(${table.name}) page_key FROM ${table.from} WHERE ${conditions.join(' AND ')} AND e.id=?`).get(...params,c.id) as {page_key:Uint8Array}|undefined;
   if(!previous||createHash('sha256').update(previous.page_key).digest('hex')!==c.keyDigest)return stale();
   const key=Buffer.from(previous.page_key);conditions.push(`(aural_natural_key_v1(${table.name})>? OR (aural_natural_key_v1(${table.name})=? AND e.id>?))`);params.push(key,key,c.id);
  }
  const rows=this.db.prepare(`SELECT e.id,aural_natural_key_v1(${table.name}) page_key FROM ${table.from} WHERE ${conditions.join(' AND ')} ORDER BY page_key,e.id LIMIT ?`).all(...params,RULE_REFERENCE_PAGE_SIZE+1) as {id:string;page_key:Uint8Array}[];
  const visible=rows.slice(0,RULE_REFERENCE_PAGE_SIZE),items=visible.map(row=>{const ref=this.reference(request.kind,row.id,true);if(!ref)throw new Error('目标资料已失效，请重新搜索');return ref;});
  if(snapshot()!==before)return stale();
  const last=visible.at(-1),nextCursor=rows.length>RULE_REFERENCE_PAGE_SIZE&&last?this.cursor({epoch:this.epoch,kind:request.kind,query:request.query,snapshot:before,keyDigest:createHash('sha256').update(last.page_key).digest('hex'),id:last.id}):null;
  // The signed cursor carries a digest, not an unbounded natural key. Resolve
  // its original row under the same snapshot on the next page, before seeking.
  return {kind:request.kind,query:request.query,status:'ready',snapshot:before,items,nextCursor};
 }
 private receipt(id:string):Receipt|undefined{return this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(id) as Receipt|undefined;}
 import(value:unknown):RuleImportResult&{changed:boolean}{
  const request=readRuleImportRequest(value),fingerprint=requestDigest(request),commandId=request.commandId;
  try{
   return this.transaction(()=>{
    const old=this.receipt(commandId);if(old){if(old.fingerprint!==fingerprint)throw new Error('导入操作身份已用于另一请求');return {commandId,status:'saved',value:readRuleImportValue(JSON.parse(old.result_json)),error:'',changed:false};}
    for(const mapping of request.mappings){const current=this.reference(mapping.target.kind,mapping.target.id,true);if(!current||current.fingerprint!==mapping.target.fingerprint||JSON.stringify(current)!==JSON.stringify(mapping.target))throw new Error('已选择的目标资料已变化，请重新核对匹配');}
    const entries=selectedRuleEntries(request.bundle,request.selected).map(entry=>mapRuleEntry(entry,request.mappings)),created:RuleImportValue['created']=[];
    for(const entry of entries){
     const source=ruleEntryKey(entry),hash=sha('aural-rule-import-child-v1:',[commandId,source]),childId=`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
     if(this.receipt(childId))throw new Error('规则导入子操作身份冲突，请核对历史');
     const result=entry.kind==='smart'?this.smart.mutate({action:'create',commandId:childId,name:entry.name,definition:entry.definition}):this.presets.result({action:'create',commandId:childId,name:entry.name,definition:entry.definition}).value;
     if(!result)throw new Error('新建规则未返回完整资料');created.push({source,kind:entry.kind,id:result.id,name:result.name});
    }
    const result=readRuleImportValue({digest:ruleBundleDigest(request.bundle),created}),now=new Date().toISOString();
    this.db.prepare('INSERT INTO user_command_receipt VALUES(?,?,?,?)').run(commandId,fingerprint,JSON.stringify(result),now);
    this.db.prepare('INSERT INTO rule_transfer_audit VALUES(?,?,?,?)').run(commandId,result.digest,JSON.stringify(request),now);
    return {commandId,status:'saved',value:result,error:'',changed:true};
   });
  }catch(error){
   if(this.db.isTransaction)throw error;
   // Receipt lookup failure remains unresolved. A timeout or lost commit ACK
   // must be retried with the same request and command UUID, after restart too.
   const old=this.receipt(commandId);
   if(old?.fingerprint===fingerprint)return {commandId,status:'saved',value:readRuleImportValue(JSON.parse(old.result_json)),error:'',changed:false};
   return {commandId,status:'rejected',value:null,error:String(error instanceof Error?error.message:error).slice(0,512),changed:false};
  }
 }
}
