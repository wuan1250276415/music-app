import {readSmartPlaylistDefinition,smartPlaylistId,type SmartPlaylistDefinition} from './smart-playlists.js';
import {readFilterPresetDefinition,type FilterPresetDefinition} from './filter-presets.js';
import {readMusicFilters,type MusicFilters} from './music-filters.js';
export const RULE_BUNDLE_MAX_BYTES=1024*1024;
export const RULE_TRANSFER_MAX_BYTES=2*1024*1024;
export const RULE_TRANSFER_MAX_ENTRIES=64;
export const RULE_REFERENCE_PAGE_SIZE=50;
export const RULE_REFERENCE_KINDS=['artist','release','group','genre','root'] as const;
export type RuleReferenceKind=typeof RULE_REFERENCE_KINDS[number];
export type RuleReference={kind:RuleReferenceKind;id:string;name:string;context:string;fingerprint:string};
export type RuleEntry={id:string;name:string}&({kind:'smart';definition:SmartPlaylistDefinition}|{kind:'preset';definition:FilterPresetDefinition});
export type RuleBundle={format:'aural-rule-bundle';version:1;origin:string;exportedAt:string;entries:RuleEntry[];references:RuleReference[]};
export type RuleSelection={kind:'smart'|'preset';id:string;revision:number};
export type RuleExportRequest={items:RuleSelection[]};
export type RuleMapping={source:string;target:RuleReference};
export type RuleImportRequest={commandId:string;bundle:RuleBundle;selected:string[];mappings:RuleMapping[]};
export type RuleImportValue={digest:string;created:Array<{source:string;kind:'smart'|'preset';id:string;name:string}>};
export type RuleImportResult={commandId:string;status:'saved'|'rejected';value:RuleImportValue|null;error:string};
export type RuleInspectionRequest={bundle:RuleBundle;selected:string[];mappings:RuleMapping[]};
export type RuleTransferInspection={digest:string;sameLibrary:boolean;needed:RuleReference[];suggested:RuleMapping[];retained:RuleMapping[]};
export type RuleReferenceQuery={kind:RuleReferenceKind;query:string;cursor?:string};
export type RuleReferencePage={kind:RuleReferenceKind;query:string;status:'ready'|'stale';snapshot:string;items:RuleReference[];nextCursor:string|null};
const compareKeys=(a:string,b:string)=>a<b?-1:a>b?1:0;
export const ruleEntryKey=(entry:Pick<RuleEntry,'kind'|'id'>):string=>JSON.stringify([entry.kind,entry.id]);
export const ruleReferenceKey=(reference:Pick<RuleReference,'kind'|'id'>):string=>JSON.stringify([reference.kind,reference.id]);
function object(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new Error('规则文件字段不完整或不支持');return v as Record<string,unknown>;}
function text(v:unknown,max:number,empty=false):string{if(typeof v!=='string'||v.length>max||!empty&&!v.trim()||/[\u0000-\u001f\u007f]/.test(v))throw new Error('规则文件文本无效');return v;}
function digest(v:unknown):string{const s=text(v,64);if(!/^[a-f0-9]{64}$/.test(s))throw new Error('规则摘要无效');return s;}
function bytes(v:unknown,max:number):void{if(new TextEncoder().encode(JSON.stringify(v)).length>max)throw new Error('规则文件或操作超过大小预算');}
function array(v:unknown,max:number):unknown[]{if(!Array.isArray(v)||v.length>max)throw new Error('规则文件列表超过预算');return v;}
function kind(v:unknown):RuleReferenceKind{if(typeof v!=='string'||!RULE_REFERENCE_KINDS.includes(v as RuleReferenceKind))throw new Error('规则引用类型无效');return v as RuleReferenceKind;}
function entryKind(v:unknown):'smart'|'preset'{if(v!=='smart'&&v!=='preset')throw new Error('规则条目类型无效');return v;}
export function readRuleReference(v:unknown):RuleReference{const r=object(v,['kind','id','name','context','fingerprint']);return {kind:kind(r.kind),id:text(r.id,128),name:text(r.name,512),context:text(r.context,512,true),fingerprint:digest(r.fingerprint)};}
export function readRuleEntry(v:unknown):RuleEntry{const r=object(v,['kind','id','name','definition']),k=entryKind(r.kind),base={id:smartPlaylistId(r.id),name:text(r.name,120).trim()};return k==='smart'?{...base,kind:k,definition:readSmartPlaylistDefinition(r.definition)}:{...base,kind:k,definition:readFilterPresetDefinition(r.definition)};}
export function ruleReferences(entries:RuleEntry[]):Array<{kind:RuleReferenceKind;id:string}>{
 const refs=new Map<string,{kind:RuleReferenceKind;id:string}>();
 const add=(k:RuleReferenceKind,id:string)=>{const value={kind:k,id:text(id,128)};refs.set(ruleReferenceKey(value),value);};
 const filters=(f:MusicFilters|undefined)=>{f?.artists?.ids.forEach(id=>add('artist',id));f?.genres?.ids.forEach(id=>add('genre',id));};
 for(const entry of entries){
  if(entry.kind==='preset'){filters(entry.definition.filters);continue;}
  const q=entry.definition.query;filters(q.filters);q.genreFilter?.ids.forEach(id=>add('genre',id));
  if(q.facetId){const k=({artists:'artist',albums:'release',albumGroups:'group',genres:'genre'} as Partial<Record<string,RuleReferenceKind>>)[q.view];if(!k)throw new Error('当前规则范围不能携带实体身份');add(k,q.facetId);}
  if(q.view==='folders'&&q.value)add('root',q.value);
 }
 return [...refs.values()].sort((a,b)=>compareKeys(ruleReferenceKey(a),ruleReferenceKey(b)));
}
export function readRuleBundle(v:unknown):RuleBundle{
 bytes(v,RULE_BUNDLE_MAX_BYTES);const r=object(v,['format','version','origin','exportedAt','entries','references']);
 if(r.format!=='aural-rule-bundle'||r.version!==1)throw new Error('不支持的规则文件版本');
 const exportedAt=text(r.exportedAt,24);if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(exportedAt)||!Number.isFinite(Date.parse(exportedAt))||new Date(exportedAt).toISOString()!==exportedAt)throw new Error('规则导出时间无效');
 const entries=array(r.entries,RULE_TRANSFER_MAX_ENTRIES).map(readRuleEntry);if(!entries.length||new Set(entries.map(ruleEntryKey)).size!==entries.length)throw new Error('规则条目为空或身份重复');
 const references=array(r.references,2048).map(readRuleReference),required=ruleReferences(entries).map(ruleReferenceKey),actual=references.map(ruleReferenceKey);
 if(new Set(actual).size!==actual.length||actual.length!==required.length||required.some(key=>!actual.includes(key)))throw new Error('规则引用资料不完整或包含多余引用');
 return {format:'aural-rule-bundle',version:1,origin:smartPlaylistId(r.origin),exportedAt,entries,references:references.sort((a,b)=>compareKeys(ruleReferenceKey(a),ruleReferenceKey(b)))};
}
export function readRuleExportRequest(v:unknown):RuleExportRequest{
 const r=object(v,['items']),items=array(r.items,RULE_TRANSFER_MAX_ENTRIES).map(v=>{const i=object(v,['kind','id','revision']);if(typeof i.revision!=='number'||!Number.isSafeInteger(i.revision)||i.revision<0||i.revision>=Number.MAX_SAFE_INTEGER)throw new Error('规则导出修订无效');return {kind:entryKind(i.kind),id:smartPlaylistId(i.id),revision:i.revision};});
 if(!items.length||new Set(items.map(ruleEntryKey)).size!==items.length)throw new Error('请选择最多64个不重复的已保存规则');return {items};
}
export function selectedRuleEntries(bundle:RuleBundle,v:unknown):RuleEntry[]{
 const selected=array(v,RULE_TRANSFER_MAX_ENTRIES).map(key=>text(key,180));
 if(!selected.length||new Set(selected).size!==selected.length||selected.some(key=>!bundle.entries.some(entry=>ruleEntryKey(entry)===key)))throw new Error('导入选择为空、重复或不存在');
 return bundle.entries.filter(entry=>selected.includes(ruleEntryKey(entry)));
}
function mapping(v:unknown):RuleMapping{const r=object(v,['source','target']);return {source:text(r.source,300),target:readRuleReference(r.target)};}
export function readRuleInspectionRequest(v:unknown):RuleInspectionRequest{bytes(v,RULE_TRANSFER_MAX_BYTES);const r=object(v,['bundle','selected','mappings']),bundle=readRuleBundle(r.bundle),entries=selectedRuleEntries(bundle,r.selected),required=ruleReferences(entries),mappings=array(r.mappings,2048).map(mapping);if(new Set(mappings.map(m=>m.source)).size!==mappings.length||mappings.some(m=>!required.some(ref=>m.source===ruleReferenceKey(ref)&&m.target.kind===ref.kind)))throw new Error('待核对匹配与规则引用不一致');return {bundle,selected:entries.map(ruleEntryKey),mappings};}
export function readRuleImportRequest(v:unknown):RuleImportRequest{
 bytes(v,RULE_TRANSFER_MAX_BYTES);const r=object(v,['commandId','bundle','selected','mappings']),bundle=readRuleBundle(r.bundle),entries=selectedRuleEntries(bundle,r.selected),required=ruleReferences(entries),mappings=array(r.mappings,2048).map(mapping);
 if(new Set(mappings.map(m=>m.source)).size!==mappings.length||mappings.length!==required.length||required.some(ref=>!mappings.some(m=>m.source===ruleReferenceKey(ref)&&m.target.kind===ref.kind)))throw new Error('请为每个所选规则引用指定对应类型的当前资料');
 return {commandId:smartPlaylistId(r.commandId),bundle,selected:entries.map(ruleEntryKey),mappings:mappings.sort((a,b)=>compareKeys(a.source,b.source))};
}
export function mapRuleEntry(entry:RuleEntry,mappings:RuleMapping[]):RuleEntry {
 const mapped=(kind:RuleReferenceKind,id:string)=>{const m=mappings.find(m=>m.source===ruleReferenceKey({kind,id}));if(!m||m.target.kind!==kind)throw new Error('规则引用尚未匹配');return m.target;};
 const ids=(kind:RuleReferenceKind,values:string[])=>values.map(id=>mapped(kind,id).id);
 const filters=(f:MusicFilters):MusicFilters=>readMusicFilters({...f,...(f.artists?{artists:{...f.artists,ids:ids('artist',f.artists.ids)}}:{}),...(f.genres?{genres:{...f.genres,ids:ids('genre',f.genres.ids)}}:{})});
 if(entry.kind==='preset')return {...entry,definition:readFilterPresetDefinition({version:1,filters:filters(entry.definition.filters)})};
 const q=entry.definition.query,query={...q,...(q.filters?{filters:filters(q.filters)}:{}),...(q.genreFilter?{genreFilter:{...q.genreFilter,ids:ids('genre',q.genreFilter.ids)}}:{})};
 if(q.facetId){const k=({artists:'artist',albums:'release',albumGroups:'group',genres:'genre'} as Record<string,RuleReferenceKind>)[q.view],target=mapped(k,q.facetId);query.facetId=target.id;query.value=target.name.slice(0,256);}
 if(q.view==='folders'&&q.value)query.value=mapped('root',q.value).id;
 // Collapsing two original IDs onto one destination changes all/any semantics;
 // validators reject duplicates rather than silently deduplicating the rule.
 return {...entry,definition:readSmartPlaylistDefinition({version:1,query})};
}
export function readRuleTransferInspection(v:unknown):RuleTransferInspection{const r=object(v,['digest','sameLibrary','needed','suggested','retained']);if(typeof r.sameLibrary!=='boolean')throw new Error('规则来源核对无效');const needed=array(r.needed,2048).map(readRuleReference),suggested=array(r.suggested,2048).map(mapping),retained=array(r.retained,2048).map(mapping);if(new Set(needed.map(ruleReferenceKey)).size!==needed.length||new Set(suggested.map(m=>m.source)).size!==suggested.length||suggested.some(m=>!needed.some(n=>ruleReferenceKey(n)===m.source&&n.kind===m.target.kind&&n.id===m.target.id&&n.fingerprint===m.target.fingerprint))||!r.sameLibrary&&suggested.length||new Set(retained.map(m=>m.source)).size!==retained.length||retained.some(m=>!needed.some(n=>ruleReferenceKey(n)===m.source&&n.kind===m.target.kind)))throw new Error('规则匹配响应不一致');return {digest:digest(r.digest),sameLibrary:r.sameLibrary,needed,suggested,retained};}
export function readRuleReferenceQuery(v:unknown):RuleReferenceQuery{const has=Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&Object.hasOwn(v,'cursor')),r=object(v,has?['kind','query','cursor']:['kind','query']);return {kind:kind(r.kind),query:text(r.query,128,true).trim(),...(r.cursor!==undefined?{cursor:text(r.cursor,2048)}:{})};}
export function readRuleReferencePage(v:unknown):RuleReferencePage{const r=object(v,['kind','query','status','snapshot','items','nextCursor']),k=kind(r.kind),query=text(r.query,128,true),items=array(r.items,RULE_REFERENCE_PAGE_SIZE).map(readRuleReference);if(r.status!=='ready'&&r.status!=='stale'||r.status==='stale'&&(items.length||r.nextCursor!==null)||items.some(i=>i.kind!==k)||new Set(items.map(i=>i.id)).size!==items.length)throw new Error('规则目标目录无效');return {kind:k,query,status:r.status,snapshot:digest(r.snapshot),items,nextCursor:r.nextCursor===null?null:text(r.nextCursor,2048)};}
export function readRuleImportValue(v:unknown):RuleImportValue{const r=object(v,['digest','created']),created=array(r.created,RULE_TRANSFER_MAX_ENTRIES).map(value=>{const i=object(value,['source','kind','id','name']);return {source:text(i.source,180),kind:entryKind(i.kind),id:smartPlaylistId(i.id),name:text(i.name,120)};});if(!created.length||new Set(created.map(i=>i.source)).size!==created.length||new Set(created.map(i=>i.id)).size!==created.length)throw new Error('规则导入回执条目不一致');return {digest:digest(r.digest),created};}
export function readRuleImportResult(v:unknown):RuleImportResult{const r=object(v,['commandId','status','value','error']);if(r.status!=='saved'&&r.status!=='rejected'||typeof r.error!=='string'||r.error.length>512||r.status==='saved'&&(r.value===null||r.error!=='')||r.status==='rejected'&&r.value!==null)throw new Error('规则导入响应无效');return {commandId:smartPlaylistId(r.commandId),status:r.status,value:r.value===null?null:readRuleImportValue(r.value),error:r.error};}
