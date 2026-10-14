import React,{useEffect,useMemo,useRef,useState} from 'react';
import type {LyricsDocument} from '../shared/contracts';

export function lyricsSource(document:LyricsDocument|null):string {
  if(!document)return '本地歌词';
  return `${document.sourceKind==='embedded'?'歌曲内嵌':document.sourceKind==='imported'?'用户导入':'本地文件'} · ${document.kind==='timed'?'逐行同步':'纯文本'}${document.language?` · ${document.language}`:''}`;
}

export function LyricsDisplay({contextKey,document,secondary=null,offsetMs=0,secondaryOffsetMs=0,fontSize=20,activeLine,loading,canSeek,seek,compact=false,visible=true}:{contextKey:string;document:LyricsDocument|null;secondary?:LyricsDocument|null;offsetMs?:number;secondaryOffsetMs?:number;fontSize?:number;activeLine:number;loading:boolean;canSeek:boolean;seek:(position:number)=>void;compact?:boolean;visible?:boolean}):React.JSX.Element {
  const list=useRef<HTMLDivElement|null>(null);
  const [following,setFollowing]=useState(true);
  const [auxiliaryExpanded,setAuxiliaryExpanded]=useState(false);
  const paired=useMemo(()=>{
    const result=new Map<number,string>(),used=new Set<number>();
    if(document?.kind!=='timed'||secondary?.kind!=='timed')return result;
    document.lines.forEach((line,index)=>{
      const target=line.atSeconds+(offsetMs-secondaryOffsetMs)/1000;
      let low=0,high=secondary.lines.length;
      while(low<high){const middle=(low+high)>>>1;if(secondary.lines[middle].atSeconds<target)low=middle+1;else high=middle;}
      const options=[low-1,low].filter(position=>position>=0&&position<secondary.lines.length&&!used.has(position)).sort((a,b)=>Math.abs(secondary.lines[a].atSeconds-target)-Math.abs(secondary.lines[b].atSeconds-target));
      const match=options[0];if(match!==undefined&&Math.abs(secondary.lines[match].atSeconds-target)<=0.75){used.add(match);result.set(index,secondary.lines[match].text);}
    });return result;
  },[document,secondary,offsetMs,secondaryOffsetMs]);
  // Metadata/preference refreshes may replace an identical document object.
  // Preserve manual browsing for the same song and source, but reset on change.
  const lastDocument=useRef<{context:string;id:string|null}>({context:contextKey,id:document?.id??null});
  useEffect(()=>{
    const previous=lastDocument.current;
    if(previous.context!==contextKey||document&&previous.id!==document.id){setFollowing(true);if(list.current)list.current.scrollTop=0;}
    lastDocument.current={context:contextKey,id:document?.id??(previous.context===contextKey?previous.id:null)};
  },[contextKey,document?.id]);
  useEffect(()=>{
    const container=list.current,line=container?.querySelector<HTMLElement>(`[data-line="${activeLine}"]`);
    if(!visible||!following||activeLine<0||!container||!line)return;
    // Move only this scroll container, never the detail page or the player bar.
    const center=()=>{
      const box=container.getBoundingClientRect(),row=line.getBoundingClientRect();
      const top=Math.max(0,container.scrollTop+row.top-box.top-(container.clientHeight-row.height)/2);
      container.scrollTo({top,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    };
    center();let frame=0;
    // Resize/font wrapping may move the current line even while paused. Only
    // observe this viewport and line; coalesce callbacks to one animation frame.
    const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(center);});
    observer.observe(container);observer.observe(line);
    return()=>{observer.disconnect();cancelAnimationFrame(frame);};
  },[following,activeLine,document,visible,fontSize,contextKey]);
  return <div className={`lyrics-display ${compact?'compact':''}`} style={{'--lyrics-font-size':`${compact?Math.max(14,fontSize*0.8):fontSize}px`} as React.CSSProperties}>
    {document?.kind==='timed'&&<div className="lyrics-follow-row"><button aria-pressed={following} onClick={()=>setFollowing(value=>!value)}>{following?'跟随播放：开':'回到当前歌词'}</button><small>{following?'手动滚动可暂停跟随':'手动浏览中'}</small></div>}
    <div className={compact?'lyrics-body':'detail-lyrics-scroll'} ref={list} tabIndex={0} aria-label="歌词内容" onWheel={()=>setFollowing(false)} onTouchMove={()=>setFollowing(false)} onPointerDown={()=>setFollowing(false)} onKeyDown={event=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(event.key))setFollowing(false);}}>
      {document?.lines.length?document.lines.map((line,index)=><button key={`${index}-${line.atSeconds}`} data-line={index} aria-current={index===activeLine?'true':undefined} className={`detail-lyric-line ${index===activeLine?'active':''}`} disabled={document.kind!=='timed'||!canSeek} onClick={()=>{seek(Math.max(0,line.atSeconds+offsetMs/1000));setFollowing(true);}}><span>{line.text}</span>{paired.has(index)&&<small className="lyric-secondary">{paired.get(index)}</small>}</button>):<p className={compact?'lyrics-empty':'detail-empty'}>{loading?'正在读取本地歌词…':'未找到歌词。支持歌曲内嵌歌词与同名 LRC/TXT；CUE 优先读取与曲名同名的歌词文件。'}</p>}
      {secondary&&(document?.kind!=='timed'||secondary.kind!=='timed')&&<section className="lyrics-separate" aria-label="独立辅助歌词"><h4>{secondary.label??'辅助歌词'} · 独立文本展示</h4>{secondary.lines.map((line,index)=><p key={index}>{line.text}</p>)}</section>}
      {secondary?.kind==='timed'&&document?.kind==='timed'&&<details className="lyrics-separate" onToggle={event=>setAuxiliaryExpanded(event.currentTarget.open)}><summary>辅助歌词原文{paired.size===0?'（未找到可对齐的行）':''}</summary>{auxiliaryExpanded&&secondary.lines.map((line,index)=><p key={index}>{line.text}</p>)}</details>}
    </div>
  </div>;
}
