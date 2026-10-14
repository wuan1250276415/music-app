import type {LibraryItem,QueueCommand} from '../shared/contracts';
import {BROWSE_PAGE_SIZE,BROWSE_CACHE_PAGES,type BrowseQuery,type BrowsePlayRequest} from '../shared/library-browse';
import {useSnapshotPages} from './snapshot-pages';
const config={size:BROWSE_PAGE_SIZE,cachePages:BROWSE_CACHE_PAGES,read:(query:BrowseQuery,offset:number,snapshot?:string)=>window.music.browse({query,offset,...(snapshot?{snapshot}:{})})};
export function useLibraryBrowse(query:BrowseQuery,revision:number){
 const browse=useSnapshotPages(query,revision,config);
 const playRequest=(item:LibraryItem,command:QueueCommand):BrowsePlayRequest=>{const row=browse.find(value=>value.id===item.id&&value.playlistEntryId===item.playlistEntryId);return {query:row.query,snapshot:row.snapshot,index:row.index,itemId:item.id,command};};
 return {...browse,playRequest};
}
