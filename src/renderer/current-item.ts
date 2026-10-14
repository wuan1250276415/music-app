import {useEffect,useRef,useState} from 'react';
import type {LibraryItem} from '../shared/contracts';

type Snapshot={key:string;item:LibraryItem|null;error:string};

// Playback details are independent of the current library page/filter. The
// page/queue can supply an immediate preview while the authoritative row loads.
export function useCurrentItem(id:string|null,revision:number,fallback:LibraryItem|undefined):{item:LibraryItem|null|undefined;loading:boolean;error:string}{
  const key=JSON.stringify([id,revision]);
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const lastKnown=useRef<LibraryItem|null>(null);
  useEffect(()=>{
    if(!id){lastKnown.current=null;setSnapshot(null);return;}
    let alive=true;
    void window.music.item(id).then(item=>{
      if(item&&item.id!==id)throw new Error('歌曲信息与当前播放不一致，请重新读取');
      if(alive){lastKnown.current=item;setSnapshot({key,item,error:''});}
    }).catch(error=>{if(alive)setSnapshot({key,item:null,error:error instanceof Error?error.message:String(error)});});
    return()=>{alive=false;};
  },[id,key]);
  const active=snapshot?.key===key?snapshot:null;
  // Keep the same song visible during refresh or a transient read failure.
  // A successful missing-row response remains authoritative; never carry a
  // previous song's cover into the next song.
  const preview=fallback?.id===id?fallback:lastKnown.current?.id===id?lastKnown.current:undefined;
  return {item:!id?null:active&&!active.error?active.item:preview,loading:Boolean(id&&!active),error:active?.error??''};
}
