import {readLibrarySort} from './library-sort.js';
import {readMusicFilters} from './music-filters.js';
import type {ListRequest,LibraryItem,QueueCommand} from './contracts.js';
export const BROWSE_PAGE_SIZE=100;
export const BROWSE_CACHE_PAGES=5;
export const BROWSE_STALE_ERROR='AURAL_BROWSE_STALE';
export type BrowseQuery=Omit<ListRequest,'offset'|'limit'|'releaseTrackId'>;
export type BrowseRequest={query:BrowseQuery;offset:number;snapshot?:string};
export type BrowseResponse={version:1;status:'ready'|'stale';snapshot:string;offset:number;total:number;items:LibraryItem[]};
export type BrowsePlayRequest={query:BrowseQuery;snapshot:string;index:number;itemId:string;command:QueueCommand};
export type BrowsePlayContext={itemId:string;ids:string[];start:number;total:number;snapshot:string};
const views=['all','artists','albums','albumGroups','genres','folders','favorites','recent','playlists'];
function object(value:unknown,allowed:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new Error('无效曲库浏览字段');return value as Record<string,unknown>;}
function text(value:unknown,max:number):string{if(typeof value!=='string'||value.length>max||value.includes('\0'))throw new Error('无效曲库浏览文本');return value;}
export function browseIndex(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>1_000_000_000)throw new Error('无效曲库浏览位置');return value;}
export function browseSnapshot(value:unknown):string{const s=text(value,64);if(!/^[a-f0-9]{64}$/.test(s))throw new Error('无效曲库浏览快照');return s;}
export function readBrowseQuery(value:unknown):BrowseQuery{
 const r=object(value,['view','value','facetId','artistRole','query','collapseVersions','genreFilter','filters','sort']);if(typeof r.view!=='string'||!views.includes(r.view))throw new Error('无效曲库视图');
 const q:BrowseQuery={view:r.view as BrowseQuery['view']};
 for(const key of ['value','facetId','query'] as const)if(r[key]!==undefined)q[key]=text(r[key],key==='facetId'?128:256);
 if(r.artistRole!==undefined){if(typeof r.artistRole!=='string'||!['performer','album_artist','composer','conductor','orchestra'].includes(r.artistRole))throw new Error('无效艺人角色');q.artistRole=r.artistRole as BrowseQuery['artistRole'];}
 if(r.collapseVersions!==undefined){if(typeof r.collapseVersions!=='boolean')throw new Error('无效文件版本显示');q.collapseVersions=r.collapseVersions;}
 if(r.genreFilter!==undefined){const f=object(r.genreFilter,['ids','operator','descendants']);
  if(!Array.isArray(f.ids)||f.ids.length>16||new Set(f.ids).size!==f.ids.length||typeof f.operator!=='string'||!['any','all'].includes(f.operator)||typeof f.descendants!=='boolean')throw new Error('无效风格筛选');
  q.genreFilter={ids:f.ids.map(id=>{const s=text(id,128);if(!s)throw new Error('无效风格 ID');return s;}),operator:f.operator as 'any'|'all',descendants:f.descendants};
 }
 if(r.filters!==undefined)q.filters=readMusicFilters(r.filters);
 if(r.sort!==undefined){q.sort=readLibrarySort(r.sort);if(q.view==='playlists'&&q.sort.mode!=='default')throw new Error('歌单保持原始条目顺序');}
 return q;
}
export function readBrowseRequest(value:unknown):BrowseRequest{const r=object(value,['query','offset','snapshot']),offset=browseIndex(r.offset);if(offset%BROWSE_PAGE_SIZE!==0)throw new Error('曲库浏览位置必须对齐分页');return {query:readBrowseQuery(r.query),offset,...(r.snapshot!==undefined?{snapshot:browseSnapshot(r.snapshot)}:{})};}
export function readBrowsePlayRequest(value:unknown):BrowsePlayRequest{
 const r=object(value,['query','snapshot','index','itemId','command']),itemId=text(r.itemId,128);if(!itemId)throw new Error('无效播放曲目');
 const c=object(r.command,['commandId','baseRevision']);if(typeof c.commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(c.commandId)||typeof c.baseRevision!=='number'||!Number.isSafeInteger(c.baseRevision)||c.baseRevision<0)throw new Error('无效播放操作');
 return {query:readBrowseQuery(r.query),snapshot:browseSnapshot(r.snapshot),index:browseIndex(r.index),itemId,command:{commandId:c.commandId,baseRevision:c.baseRevision}};
}
