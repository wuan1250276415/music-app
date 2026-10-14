import {browseIndex,browseSnapshot,readBrowseQuery,type BrowseQuery} from './library-browse.js';
import {musicFilterTimeAnchor} from './music-filters.js';

export const MUSIC_PREVIEW_SIZE=8;
export type MusicPreviewDependencies={counts:boolean;recency:boolean;relative:boolean};
export type MusicPreviewRequest={query:BrowseQuery};
export type MusicPreviewCheckRequest=MusicPreviewRequest&{snapshot:string};
export type MusicPreviewItem={id:string;entryId:string|null;title:string;artist:string;album:string;kind:'file'|'cue';available:boolean;durationSeconds:number|null};
type PreviewEvidence={version:1;query:BrowseQuery;snapshot:string;asOfMs:number;dependencies:MusicPreviewDependencies};
export type MusicPreviewResponse=PreviewEvidence&{status:'ready'|'stale';total:number;items:MusicPreviewItem[]};
export type MusicPreviewCheck=PreviewEvidence&{status:'current'|'stale'};

function record(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('无效筛选预览字段');
 return value as Record<string,unknown>;
}
function query(value:unknown):BrowseQuery{
 const result=readBrowseQuery(value);
 if(JSON.stringify(result).length>16384)throw new Error('筛选预览条件过长');
 return result;
}
export function readMusicPreviewRequest(value:unknown):MusicPreviewRequest{
 const r=record(value,['query']);return {query:query(r.query)};
}
export function readMusicPreviewCheckRequest(value:unknown):MusicPreviewCheckRequest{
 const r=record(value,['query','snapshot']);return {query:query(r.query),snapshot:browseSnapshot(r.snapshot)};
}
function evidence(r:Record<string,unknown>):PreviewEvidence{
 if(r.version!==1||typeof r.asOfMs!=='number'||musicFilterTimeAnchor(r.asOfMs)!==r.asOfMs)throw new Error('无效筛选预览时间基准');
 const d=record(r.dependencies,['counts','recency','relative']);
 if(typeof d.counts!=='boolean'||typeof d.recency!=='boolean'||typeof d.relative!=='boolean')throw new Error('无效筛选预览依赖');
 return {version:1,query:query(r.query),snapshot:browseSnapshot(r.snapshot),asOfMs:r.asOfMs,dependencies:{counts:d.counts,recency:d.recency,relative:d.relative}};
}
function text(value:unknown,max:number,empty=true):string{
 if(typeof value!=='string'||value.length>max||!empty&&!value||/[\u0000-\u001f\u007f]/.test(value))throw new Error('无效筛选预览资料');
 return value;
}
function item(value:unknown):MusicPreviewItem{
 const r=record(value,['id','entryId','title','artist','album','kind','available','durationSeconds']);
 if(r.kind!=='file'&&r.kind!=='cue'||typeof r.available!=='boolean'||r.durationSeconds!==null&&(typeof r.durationSeconds!=='number'||!Number.isFinite(r.durationSeconds)||r.durationSeconds<0||r.durationSeconds>1e9))throw new Error('无效筛选预览曲目');
 return {id:text(r.id,128,false),entryId:r.entryId===null?null:text(r.entryId,128,false),title:text(r.title,512),artist:text(r.artist,512),album:text(r.album,512),kind:r.kind,available:r.available,durationSeconds:r.durationSeconds as number|null};
}
export function readMusicPreviewResponse(value:unknown):MusicPreviewResponse{
 const r=record(value,['version','query','snapshot','asOfMs','dependencies','status','total','items']),base=evidence(r),total=browseIndex(r.total);
 if(r.status!=='ready'&&r.status!=='stale'||!Array.isArray(r.items)||r.items.length>MUSIC_PREVIEW_SIZE||r.status==='stale'&&(total!==0||r.items.length!==0)||r.status==='ready'&&r.items.length!==Math.min(MUSIC_PREVIEW_SIZE,total))throw new Error('无效筛选预览结果范围');
 const items=r.items.map(item),identities=items.map(i=>i.entryId===null?`item:${i.id}`:`entry:${i.entryId}`);
 if(new Set(identities).size!==items.length||base.query.view!=='playlists'&&items.some(i=>i.entryId!==null))throw new Error('筛选预览曲目身份重复或越界');
 return {...base,status:r.status,total,items};
}
export function readMusicPreviewCheck(value:unknown):MusicPreviewCheck{
 const r=record(value,['version','query','snapshot','asOfMs','dependencies','status']);
 if(r.status!=='current'&&r.status!=='stale')throw new Error('无效筛选预览核对状态');
 return {...evidence(r),status:r.status};
}
