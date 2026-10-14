import React,{useEffect,useMemo,useRef,useState} from 'react';
import type {QueueView,LibraryItem} from '../shared/contracts';
import {Artwork} from './artwork';

export function DetailQueue({queue,jump,move,remove,artworkRevision,busy=false,visible=true}:{queue:QueueView;jump:(entryId:string)=>void;move:(entryId:string,direction:-1|1)=>void;remove:(entryId:string)=>void;artworkRevision:(item:LibraryItem|undefined)=>string;busy?:boolean;visible?:boolean}):React.JSX.Element {
  const list=useRef<HTMLDivElement|null>(null);
  const search=useRef<HTMLInputElement|null>(null);
  const [query,setQuery]=useState('');
  const locating=useRef(false);
  const items=useMemo(()=>new Map(queue.items.map(item=>[item.id,item])),[queue.items]);
  const terms=useMemo(()=>query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),[query]);
  const entries=useMemo(()=>queue.entries.map((entry,index)=>({entry,index,item:items.get(entry.itemId)})).filter(({item})=>{
    if(!terms.length)return true;
    const text=[item?.title??'曲目已移除',item?.artist,item?.album,item?.catalog?.releaseTitle].filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase();
    return terms.every(term=>text.includes(term));
  }),[queue.entries,items,terms]);
  function scrollCurrent():void{
    const container=list.current;
    const active=container?.querySelector<HTMLElement>('.detail-queue-entry.active');
    if(!container||!active)return;
    const row=active.getBoundingClientRect(),box=container.getBoundingClientRect();
    if(row.top<box.top)container.scrollTop-=box.top-row.top;
    else if(row.bottom>box.bottom)container.scrollTop+=row.bottom-box.bottom;
  }
  function locateCurrent():void{
    if(terms.length){locating.current=true;setQuery('');return;}
    scrollCurrent();
  }
  function clearFilter():void{locating.current=false;setQuery('');search.current?.focus();}
  useEffect(()=>{if(visible)scrollCurrent();},[queue.currentEntryId,visible]);
  useEffect(()=>{if(visible&&locating.current&&!terms.length){locating.current=false;scrollCurrent();}},[visible,terms]);
  const currentIndex=queue.entries.findIndex(entry=>entry.id===queue.currentEntryId);
  return <><div className="detail-queue-location"><small>{currentIndex>=0?`当前曲目 · 第 ${currentIndex+1} 首`:'尚未选择曲目'}</small><button className="detail-refresh" disabled={currentIndex<0} onClick={locateCurrent}>定位当前曲目</button></div><div className="detail-queue-filter"><label htmlFor="detail-queue-search">搜索播放列表</label><div><input id="detail-queue-search" ref={search} type="search" maxLength={256} placeholder="歌曲、歌手或专辑" value={query} onChange={event=>{locating.current=false;setQuery(event.target.value);}}/>{query&&<button className="detail-refresh" onClick={clearFilter}>清除</button>}</div><small role="status">{terms.length?`找到 ${entries.length} 首，共 ${queue.entries.length} 首；移动按完整列表顺序`:`共 ${queue.entries.length} 首`}</small></div><div className="detail-queue-scroll" ref={list} tabIndex={0} aria-label="播放列表歌曲">
    {entries.length?entries.map(({entry,index,item})=>{
      const current=entry.id===queue.currentEntryId;
      const name=item?.title??'曲目已移除';
      return <div key={entry.id} className={`detail-queue-entry ${current?'active':''}`}>
        <button className={`detail-queue-item ${current?'active':''}`} aria-current={current?'true':undefined} disabled={busy||!item?.available} onClick={()=>jump(entry.id)}>
          <span>{current?'▶':String(index+1).padStart(2,'0')}</span><strong title={name}>{name}</strong><small title={item?`${item.artist} · ${item.catalog?.releaseTitle??item.album}`:undefined}>{item?.available?`${item.artist} · ${item.catalog?.releaseTitle??item.album}`:item?.cue?.interpretationPending?'等待 CUE 编排核对':'文件不可用'}</small>
          {visible&&<Artwork item={item} revision={artworkRevision(item)} className="detail-queue-cover"/>}
        </button>
        <div className="detail-queue-actions">
          <button aria-label={`上移 ${name}（第 ${index+1} 首）`} title="上移" disabled={busy||index===0} onClick={()=>move(entry.id,-1)}>↑</button>
          <button aria-label={`下移 ${name}（第 ${index+1} 首）`} title="下移" disabled={busy||index===queue.entries.length-1} onClick={()=>move(entry.id,1)}>↓</button>
          <button aria-label={`移出 ${name}（第 ${index+1} 首）`} title={current?'当前曲目播放结束后可移出':'移出队列'} disabled={busy||current} onClick={()=>remove(entry.id)}>×</button>
        </div>
      </div>;
    }):<p className="detail-empty">{queue.entries.length?'没有符合搜索条件的曲目。清除搜索可查看完整播放列表。':'点击一首歌曲，当前列表会成为播放队列。'}</p>}
  </div></>;
}
