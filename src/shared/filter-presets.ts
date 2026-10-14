import {readMusicFilters,type MusicFilters} from './music-filters.js';
import {browseIndex,browseSnapshot} from './library-browse.js';

export const FILTER_PRESET_PAGE_SIZE=50;
export const FILTER_PRESET_LIMIT=1024;
export type FilterPresetDefinition={version:1;filters:MusicFilters};
export type FilterPresetSummary={id:string;name:string;revision:number;createdAt:string;updatedAt:string};
export type FilterPresetDetail=FilterPresetSummary&{definition:FilterPresetDefinition};
export type FilterPresetPageRequest={offset:number;snapshot?:string};
export type FilterPresetPage={version:1;status:'ready'|'stale';snapshot:string;offset:number;total:number;items:FilterPresetSummary[]};
export type FilterPresetMutation={commandId:string}&(
 {action:'create';name:string;definition:FilterPresetDefinition}|
 {action:'update';id:string;baseRevision:number;name:string;definition:FilterPresetDefinition}|
 {action:'delete';id:string;baseRevision:number}
);
export type FilterPresetResult={commandId:string;status:'saved'|'rejected';value:FilterPresetDetail|null;error:string};

function record(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('无效筛选预设字段');
 return value as Record<string,unknown>;
}
export function filterPresetId(value:unknown):string{
 if(typeof value!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))throw new Error('无效筛选预设身份');
 return value;
}
function name(value:unknown):string{
 if(typeof value!=='string'||!value.trim()||value.trim().length>120||/[\u0000-\u001f\u007f]/.test(value))throw new Error('预设名称需为1–120个字符');
 return value.trim();
}
function revision(value:unknown):number{
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)throw new Error('无效筛选预设修订');
 return value;
}
function instant(value:unknown):string{
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new Error('无效筛选预设时间');
 return value;
}
export function readFilterPresetDefinition(value:unknown):FilterPresetDefinition{
 const r=record(value,['version','filters']);if(r.version!==1)throw new Error('不支持的筛选预设版本');
 const result:FilterPresetDefinition={version:1,filters:readMusicFilters(r.filters)};
 if(JSON.stringify(result).length>16384)throw new Error('筛选预设条件过长');
 return result;
}
export function readFilterPresetMutation(value:unknown):FilterPresetMutation{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('无效筛选预设操作');
 const action=(value as Record<string,unknown>).action;
 if(action==='create'){
  const r=record(value,['action','commandId','name','definition']);
  return {action,commandId:filterPresetId(r.commandId),name:name(r.name),definition:readFilterPresetDefinition(r.definition)};
 }
 if(action==='update'){
  const r=record(value,['action','commandId','id','baseRevision','name','definition']);
  return {action,commandId:filterPresetId(r.commandId),id:filterPresetId(r.id),baseRevision:revision(r.baseRevision),name:name(r.name),definition:readFilterPresetDefinition(r.definition)};
 }
 if(action==='delete'){
  const r=record(value,['action','commandId','id','baseRevision']);
  return {action,commandId:filterPresetId(r.commandId),id:filterPresetId(r.id),baseRevision:revision(r.baseRevision)};
 }
 throw new Error('无效筛选预设操作');
}
function readSummary(value:unknown):FilterPresetSummary{
 const r=record(value,['id','name','revision','createdAt','updatedAt']);
 if(name(r.name)!==r.name)throw new Error('预设名称未规范化');
 return {id:filterPresetId(r.id),name:r.name as string,revision:revision(r.revision),createdAt:instant(r.createdAt),updatedAt:instant(r.updatedAt)};
}
export function readFilterPresetDetail(value:unknown):FilterPresetDetail{
 const r=record(value,['id','name','revision','createdAt','updatedAt','definition']),{definition,...rest}=r;
 return {...readSummary(rest),definition:readFilterPresetDefinition(definition)};
}
export function readFilterPresetPageRequest(value:unknown):FilterPresetPageRequest{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('无效筛选预设分页');
 const hasSnapshot=Object.hasOwn(value,'snapshot'),r=record(value,hasSnapshot?['offset','snapshot']:['offset']),offset=browseIndex(r.offset);
 if(offset%FILTER_PRESET_PAGE_SIZE)throw new Error('筛选预设分页需对齐');
 return {offset,...(hasSnapshot?{snapshot:browseSnapshot(r.snapshot)}:{})};
}
export function readFilterPresetPage(value:unknown):FilterPresetPage{
 const r=record(value,['version','status','snapshot','offset','total','items']),offset=browseIndex(r.offset),total=browseIndex(r.total);
 if(r.version!==1||r.status!=='ready'&&r.status!=='stale'||!Array.isArray(r.items)||r.items.length>FILTER_PRESET_PAGE_SIZE||offset%FILTER_PRESET_PAGE_SIZE||total>FILTER_PRESET_LIMIT||r.items.length>Math.max(0,total-offset)||r.status==='stale'&&(total!==0||r.items.length!==0))throw new Error('无效筛选预设目录响应');
 const items=r.items.map(readSummary);
 if(new Set(items.map(item=>item.id)).size!==items.length||r.status==='ready'&&items.length!==Math.min(FILTER_PRESET_PAGE_SIZE,Math.max(0,total-offset)))throw new Error('筛选预设目录范围不完整');
 return {version:1,status:r.status,snapshot:browseSnapshot(r.snapshot),offset,total,items};
}
export function readFilterPresetResult(value:unknown):FilterPresetResult{
 const r=record(value,['commandId','status','value','error']);
 if(r.status!=='saved'&&r.status!=='rejected'||typeof r.error!=='string'||r.error.length>512||r.status==='saved'&&r.error!==''||r.status==='rejected'&&r.value!==null)throw new Error('无效筛选预设操作回执');
 return {commandId:filterPresetId(r.commandId),status:r.status,value:r.value===null?null:readFilterPresetDetail(r.value),error:r.error};
}
