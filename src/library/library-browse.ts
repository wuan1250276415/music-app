import {musicFilterTimeAnchor} from '../shared/music-filters.js';
import {createHash} from 'node:crypto';
import {BROWSE_PAGE_SIZE,BROWSE_STALE_ERROR,readBrowseRequest,readBrowsePlayRequest,type BrowseQuery,type BrowseResponse,type BrowsePlayContext} from '../shared/library-browse.js';
import type {LibraryDatabase} from './database.js';
export function libraryBrowseSnapshot(db:LibraryDatabase,query:BrowseQuery,asOfMs=musicFilterTimeAnchor()):string{return createHash('sha256').update(db.browseQueryStamp(query,asOfMs)).update('\n').update(JSON.stringify(query)).digest('hex');}
export function browseLibrary(db:LibraryDatabase,value:unknown):BrowseResponse{
 const r=readBrowseRequest(value),asOfMs=musicFilterTimeAnchor(),stamp=libraryBrowseSnapshot(db,r.query,asOfMs);
 if(r.snapshot!==undefined&&r.snapshot!==stamp)return {version:1,status:'stale',snapshot:stamp,offset:r.offset,total:0,items:[]};
 const page=db.list({...r.query,offset:r.offset,limit:BROWSE_PAGE_SIZE},asOfMs);
 if(libraryBrowseSnapshot(db,r.query)!==stamp)return {version:1,status:'stale',snapshot:libraryBrowseSnapshot(db,r.query),offset:r.offset,total:0,items:[]};
 return {version:1,status:'ready',snapshot:stamp,offset:r.offset,...page};
}
export function browsePlayContext(db:LibraryDatabase,value:unknown):BrowsePlayContext{
 const r=readBrowsePlayRequest(value),asOfMs=musicFilterTimeAnchor();if(libraryBrowseSnapshot(db,r.query,asOfMs)!==r.snapshot)throw new Error(`${BROWSE_STALE_ERROR}: 曲库浏览结果已变化，请刷新后再播放`);
 const start=Math.floor(r.index/BROWSE_PAGE_SIZE)*BROWSE_PAGE_SIZE,items=[];let total=0;
 for(let page=0;page<5;page++){const offset=start+page*BROWSE_PAGE_SIZE,result=db.list({...r.query,offset,limit:BROWSE_PAGE_SIZE},asOfMs);total=result.total;items.push(...result.items);if(offset+result.items.length>=total)break;}
 if(items[r.index-start]?.id!==r.itemId||libraryBrowseSnapshot(db,r.query)!==r.snapshot)throw new Error(`${BROWSE_STALE_ERROR}: 曲库浏览位置已变化，请刷新后再播放`);
 return {itemId:r.itemId,ids:items.map(item=>item.id),start,total,snapshot:r.snapshot};
}
