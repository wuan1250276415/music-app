import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {LibraryItem} from '../shared/contracts';
type Props={total:number;itemAt:(index:number)=>LibraryItem|undefined;range:(start:number,end:number,focused?:number|null)=>void;renderRow:(item:LibraryItem,index:number)=>React.ReactNode;generation:number;label:string};
const ROW_HEIGHT=76,OVERSCAN=5;
export function VirtualLibrary({total,itemAt,range,renderRow,generation,label}:Props):React.JSX.Element{
 const viewport=useRef<HTMLDivElement|null>(null),raf=useRef<number|null>(null),[view,setView]=useState({top:0,height:440}),[focused,setFocused]=useState<number|null>(null),[jump,setJump]=useState('');
 const first=Math.max(0,Math.floor(view.top/ROW_HEIGHT)-OVERSCAN),end=Math.min(total,first+Math.min(100,Math.ceil(view.height/ROW_HEIGHT)+2*OVERSCAN));
 const indices=Array.from({length:Math.max(0,end-first)},(_,i)=>first+i);
 if(focused!==null&&focused<total&&!indices.includes(focused))indices.push(focused);
 indices.sort((a,b)=>a-b);
 const measure=()=>{const e=viewport.current;if(e)setView({top:e.scrollTop,height:e.clientHeight});};
 const schedule=()=>{if(raf.current===null)raf.current=requestAnimationFrame(()=>{raf.current=null;measure();});};
 useLayoutEffect(()=>{measure();const e=viewport.current;if(!e)return;const observer=new ResizeObserver(schedule);observer.observe(e);return()=>{observer.disconnect();if(raf.current!==null)cancelAnimationFrame(raf.current);raf.current=null;};},[]);
 useEffect(()=>{range(first,end,focused);},[first,end,range,total,generation,focused]);
 useLayoutEffect(()=>{const e=viewport.current;if(!e)return;const max=Math.max(0,total*ROW_HEIGHT-e.clientHeight);if(e.scrollTop>max){e.scrollTop=max;measure();}if(focused!==null&&focused>=total){setFocused(null);e.focus();}},[total,focused]);
 function move(index:number):void{const e=viewport.current;if(!e||!total)return;index=Math.max(0,Math.min(total-1,index));e.scrollTop=Math.max(0,index*ROW_HEIGHT);setFocused(null);measure();}
 function keyDown(event:React.KeyboardEvent<HTMLDivElement>):void{
  // Inputs and row buttons keep their native keyboard behavior. The viewport itself offers list navigation.
  if(event.target!==event.currentTarget||!['ArrowDown','ArrowUp','PageDown','PageUp','Home','End'].includes(event.key))return;
  event.preventDefault();const at=Math.floor(view.top/ROW_HEIGHT),step=Math.max(1,Math.floor(view.height/ROW_HEIGHT)-1);
  move(event.key==='Home'?0:event.key==='End'?total-1:at+(event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:event.key==='PageDown'?step:-step));
 }
 function seek(event:React.FormEvent):void{event.preventDefault();if(/^\d{1,10}$/.test(jump)){move(Number(jump)-1);viewport.current?.focus();}}
 return <>
  <div className="virtual-library-tools"><span role="status">{total?`${Math.min(total,Math.floor(view.top/ROW_HEIGHT)+1)}–${Math.min(total,Math.ceil((view.top+view.height)/ROW_HEIGHT))} / ${total.toLocaleString()} 首`: '没有曲目'}</span><form onSubmit={seek}><label>跳到第 <input aria-label="跳到第几首歌曲" inputMode="numeric" value={jump} onChange={e=>setJump(e.target.value.slice(0,10))}/> 首</label><button disabled={!total||!/^\d{1,10}$/.test(jump)} type="submit">跳转</button></form></div>
  <div className="virtual-library" ref={viewport} role="list" aria-label={label} tabIndex={0} onScroll={schedule} onKeyDown={keyDown} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setFocused(null);}}>
   <div className="virtual-library-space" style={{height:total*ROW_HEIGHT}}>
    {indices.map(index=>{const item=itemAt(index);return <div className="virtual-library-row" key={item?.playlistEntryId??item?.id??`loading-${index}`} role="listitem" aria-posinset={index+1} aria-setsize={total} data-browse-index={index} style={{top:index*ROW_HEIGHT,height:ROW_HEIGHT}} onFocusCapture={()=>setFocused(index)}>{item?renderRow(item,index):<div className="virtual-library-placeholder" aria-label={`第 ${index+1} 首正在读取`}><span>{index+1}</span><span>正在读取歌曲…</span></div>}</div>;})}
   </div>
  </div>
 </>;
}
