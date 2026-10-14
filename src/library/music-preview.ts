import {MUSIC_PREVIEW_SIZE,readMusicPreviewRequest,readMusicPreviewCheckRequest,type MusicPreviewResponse,type MusicPreviewCheck,type MusicPreviewDependencies} from '../shared/music-preview.js';
import {musicFilterDependencies,musicFilterTimeAnchor} from '../shared/music-filters.js';
import type {BrowseQuery} from '../shared/library-browse.js';
import {libraryBrowseSnapshot} from './library-browse.js';
import type {LibraryDatabase} from './database.js';

function dependencies(db:LibraryDatabase,query:BrowseQuery):MusicPreviewDependencies{
 const saved=query.view==='playlists'&&query.value?db.smartPlaylists.maybe(query.value):null;
 return musicFilterDependencies(query.filters,saved?.definition.query.filters);
}
function display(value:string):string{
 const result=value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,512);
 return /[\ud800-\udbff]$/.test(result)?result.slice(0,-1):result;
}
export function previewMusicQuery(db:LibraryDatabase,value:unknown):MusicPreviewResponse{
 const {query}=readMusicPreviewRequest(value),asOfMs=musicFilterTimeAnchor(),before=libraryBrowseSnapshot(db,query,asOfMs);
 const page=db.list({...query,offset:0,limit:MUSIC_PREVIEW_SIZE},asOfMs);
 const afterMs=musicFilterTimeAnchor(),after=libraryBrowseSnapshot(db,query,afterMs),currentDependencies=dependencies(db,query);
 if(after!==before)return {version:1,query,snapshot:after,asOfMs:afterMs,dependencies:currentDependencies,status:'stale',total:0,items:[]};
 return {version:1,query,snapshot:before,asOfMs,dependencies:currentDependencies,status:'ready',total:page.total,items:page.items.map(item=>({
  id:item.id,entryId:item.playlistEntryId??null,title:display(item.title),artist:display(item.artist),album:display(item.album),kind:item.kind,available:item.available,
  durationSeconds:item.durationSeconds!==null&&Number.isFinite(item.durationSeconds)&&item.durationSeconds>=0&&item.durationSeconds<=1e9?item.durationSeconds:null
 }))};
}
export function checkMusicPreview(db:LibraryDatabase,value:unknown):MusicPreviewCheck{
 const {query,snapshot}=readMusicPreviewCheckRequest(value),asOfMs=musicFilterTimeAnchor(),current=libraryBrowseSnapshot(db,query,asOfMs);
 return {version:1,query,snapshot:current,asOfMs,dependencies:dependencies(db,query),status:current===snapshot?'current':'stale'};
}
