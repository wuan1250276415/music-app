import {readBrowseQuery,browseIndex,browseSnapshot,type BrowseQuery} from './library-browse.js';
export const SMART_PLAYLIST_PAGE_SIZE=50;
export type SmartPlaylistDefinition={version:1;query:BrowseQuery};
export type SmartPlaylistSummary={id:string;name:string;revision:number;createdAt:string;updatedAt:string};
export type SmartPlaylistDetail=SmartPlaylistSummary&{definition:SmartPlaylistDefinition};
export type SmartPlaylistResult={status:'saved'|'rejected';value:SmartPlaylistDetail|null;error:string};
export type SmartPlaylistPage={version:1;status:'ready'|'stale';snapshot:string;offset:number;total:number;items:SmartPlaylistSummary[]};
export type SmartPlaylistPageRequest={offset:number;snapshot?:string};
export type SmartPlaylistMutation={commandId:string}&({action:'create';name:string;definition:SmartPlaylistDefinition}|{action:'update';id:string;baseRevision:number;name:string;definition:SmartPlaylistDefinition}|{action:'delete';id:string;baseRevision:number});
function object(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error('无效智能歌单字段');return v as Record<string,unknown>;}
export function smartPlaylistId(v:unknown):string{if(typeof v!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v))throw new Error('无效智能歌单身份');return v;}
export function readSmartPlaylistDefinition(v:unknown):SmartPlaylistDefinition{
 const r=object(v,['version','query']);if(r.version!==1)throw new Error('不支持的智能歌单规则版本');const query=readBrowseQuery(r.query);
 if(query.view==='playlists')throw new Error('智能歌单不能引用其他歌单');return {version:1,query};
}
export function readSmartPlaylistPageRequest(v:unknown):SmartPlaylistPageRequest{
 const r=object(v,['offset','snapshot']),offset=browseIndex(r.offset);if(offset%SMART_PLAYLIST_PAGE_SIZE)throw new Error('智能歌单分页需对齐');return {offset,...(r.snapshot!==undefined?{snapshot:browseSnapshot(r.snapshot)}:{})};
}
export function readSmartPlaylistMutation(v:unknown):SmartPlaylistMutation{
 const a=object(v,['action','commandId','id','baseRevision','name','definition']);
 if(typeof a.action!=='string'||!['create','update','delete'].includes(a.action))throw new Error('无效智能歌单操作');
 const keys=a.action==='create'?['action','commandId','name','definition']:a.action==='update'?['action','commandId','id','baseRevision','name','definition']:['action','commandId','id','baseRevision'];
 const r=object(v,keys);if(Object.keys(r).length!==keys.length)throw new Error('智能歌单请求不完整');const commandId=smartPlaylistId(r.commandId);
 const identity=r.action==='create'?{}:{id:smartPlaylistId(r.id),baseRevision:(()=>{if(typeof r.baseRevision!=='number'||!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0||r.baseRevision>=Number.MAX_SAFE_INTEGER)throw new Error('无效智能歌单基础修订');return r.baseRevision;})()};
 if(r.action==='delete')return {action:'delete',commandId,...identity} as SmartPlaylistMutation;
 if(typeof r.name!=='string'||!r.name.trim()||r.name.trim().length>120||/[\u0000-\u001f]/.test(r.name))throw new Error('智能歌单名称需为1–120个字符');
 return {action:r.action,commandId,...identity,name:r.name.trim(),definition:readSmartPlaylistDefinition(r.definition)} as SmartPlaylistMutation;
}
function readSummary(v:unknown):SmartPlaylistSummary{
 const r=object(v,['id','name','revision','createdAt','updatedAt']);
 if(Object.keys(r).length!==5||typeof r.name!=='string'||!r.name.trim()||r.name.length>120||/[\u0000-\u001f]/.test(r.name)||typeof r.revision!=='number'||!Number.isSafeInteger(r.revision)||r.revision<0||!['createdAt','updatedAt'].every(k=>typeof r[k]==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r[k] as string)&&Number.isFinite(Date.parse(r[k] as string))))throw new Error('无效智能歌单资料');
 return {id:smartPlaylistId(r.id),name:r.name,revision:r.revision,createdAt:r.createdAt as string,updatedAt:r.updatedAt as string};
}
export function readSmartPlaylistDetail(v:unknown):SmartPlaylistDetail{const r=object(v,['id','name','revision','createdAt','updatedAt','definition']),{definition,...rest}=r;return {...readSummary(rest),definition:readSmartPlaylistDefinition(definition)};}
export function readSmartPlaylistPage(v:unknown):SmartPlaylistPage{
 const r=object(v,['version','status','snapshot','offset','total','items']);if(Object.keys(r).length!==6||r.version!==1||typeof r.status!=='string'||!['ready','stale'].includes(r.status)||!Array.isArray(r.items)||r.items.length>SMART_PLAYLIST_PAGE_SIZE||r.status==='stale'&&(r.items.length||r.total!==0))throw new Error('无效智能歌单分页响应');
 const offset=browseIndex(r.offset),total=browseIndex(r.total);if(offset%SMART_PLAYLIST_PAGE_SIZE||r.items.length>Math.max(0,total-offset))throw new Error('智能歌单分页范围无效');const items=r.items.map(readSummary);if(new Set(items.map(i=>i.id)).size!==items.length)throw new Error('智能歌单分页身份重复');return {version:1,status:r.status as 'ready'|'stale',snapshot:browseSnapshot(r.snapshot),offset,total,items};
}
export function readSmartPlaylistResult(v:unknown):SmartPlaylistResult{const r=object(v,['status','value','error']);if(Object.keys(r).length!==3||typeof r.error!=='string'||r.error.length>512||r.status!=='saved'&&r.status!=='rejected'||r.status==='rejected'&&r.value!==null||r.status==='saved'&&r.error!=='')throw new Error('无效智能歌单操作响应');return {status:r.status,value:r.value===null?null:readSmartPlaylistDetail(r.value),error:r.error};}
