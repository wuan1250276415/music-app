import {readMusicFilters,type MusicFilters} from './music-filters.js';
import type {ArtistRole,LibraryItem} from './contracts.js';
import {browseIndex,browseSnapshot} from './library-browse.js';
export const CATALOG_PAGE_SIZE=60,CATALOG_CACHE_PAGES=5;
export type CatalogBrowseView='artists'|'albums'|'albumGroups';
export type CatalogBrowseQuery={filters?:MusicFilters;direction?:'asc'|'desc';view:CatalogBrowseView;role:ArtistRole;query:string;sort:'name'|'count'|'date'};
export type CatalogBrowseRequest={query:CatalogBrowseQuery;offset:number;snapshot?:string};
export type CatalogCard={id:string;name:string;subtitle:string;artist:string;date:string;edition:string;country:string;label:string;catalogNumber:string;context:string;trackCount:number;fileCount:number;releaseCount:number;discCount:number;availableCount:number;formats:string[];representative:LibraryItem|null};
export type CatalogBrowseResponse={version:1;status:'ready'|'stale';snapshot:string;offset:number;total:number;items:CatalogCard[]};
export type CatalogViewPreference={version:1;revision:number;layout:'cards'|'list';density:'compact'|'comfortable'|'large'};
export const defaultCatalogViewPreference=():CatalogViewPreference=>({version:1,revision:0,layout:'cards',density:'comfortable'});
function object(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error('无效分类浏览字段');return v as Record<string,unknown>;}
export function readCatalogBrowseQuery(v:unknown):CatalogBrowseQuery{
 const r=object(v,['view','role','query','sort','filters','direction']);
 if(typeof r.view!=='string'||!['artists','albums','albumGroups'].includes(r.view)||typeof r.role!=='string'||!['performer','album_artist','composer','conductor','orchestra'].includes(r.role)||typeof r.query!=='string'||r.query.length>256||r.query.includes('\0')||typeof r.sort!=='string'||!['name','count','date'].includes(r.sort))throw new Error('无效分类浏览查询');
 if(r.direction!==undefined&&(typeof r.direction!=='string'||!['asc','desc'].includes(r.direction)))throw new Error('无效分类排序方向');
 if(r.sort==='date'&&r.view!=='albums')throw new Error('仅专辑支持发行日期排序');
 return {...(r.direction!==undefined?{direction:r.direction as 'asc'|'desc'}:{}),...(r.filters!==undefined?{filters:readMusicFilters(r.filters)}:{}),view:r.view as CatalogBrowseView,role:r.role as ArtistRole,query:r.query,sort:r.sort as CatalogBrowseQuery['sort']};
}
export function readCatalogBrowseRequest(v:unknown):CatalogBrowseRequest{const r=object(v,['query','offset','snapshot']),offset=browseIndex(r.offset);if(offset%CATALOG_PAGE_SIZE!==0)throw new Error('分类浏览需要对齐分页');return {query:readCatalogBrowseQuery(r.query),offset,...(r.snapshot!==undefined?{snapshot:browseSnapshot(r.snapshot)}:{})};}
export function readCatalogViewPreference(v:unknown):CatalogViewPreference{
 const r=object(v,['version','revision','layout','density']);if(Object.keys(r).length!==4||r.version!==1||typeof r.revision!=='number'||!Number.isSafeInteger(r.revision)||r.revision<0||typeof r.layout!=='string'||!['cards','list'].includes(r.layout)||typeof r.density!=='string'||!['compact','comfortable','large'].includes(r.density))throw new Error('无效分类显示设置');
 return {version:1,revision:r.revision,layout:r.layout as CatalogViewPreference['layout'],density:r.density as CatalogViewPreference['density']};
}
export function readCatalogViewSave(v:unknown):{expected:CatalogViewPreference;value:CatalogViewPreference}{const r=object(v,['expected','value']),expected=readCatalogViewPreference(r.expected),value=readCatalogViewPreference(r.value);if(Object.keys(r).length!==2||expected.revision>=Number.MAX_SAFE_INTEGER||value.revision!==expected.revision+1)throw new Error('分类显示修订无效');return {expected,value};}
