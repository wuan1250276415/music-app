import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {ArtistRole} from '../shared/contracts';
import {CATALOG_PAGE_SIZE,CATALOG_CACHE_PAGES,type CatalogBrowseView,type CatalogBrowseQuery,type CatalogCard,type CatalogViewPreference} from '../shared/catalog-browse';
import {useSnapshotPages} from './snapshot-pages';
import {useCatalogViewPreference} from './catalog-view-preference';
import {Artwork} from './artwork';
import './catalog-browser.css';
const config={size:CATALOG_PAGE_SIZE,cachePages:CATALOG_CACHE_PAGES,read:(query:CatalogBrowseQuery,offset:number,snapshot?:string)=>window.music.browseCatalog({query,offset,...(snapshot?{snapshot}:{})})};
const geometry={compact:{min:136,height:244},comfortable:{min:184,height:298},large:{min:244,height:368}};
const labels={artists:'歌手',albums:'专辑',albumGroups:'专辑概念'};
type Props={filters?:import('../shared/music-filters').MusicFilters;view:CatalogBrowseView;role:ArtistRole;revision:number;selectedId:string;selectedName:string;onSelect:(id:string,name:string)=>void;artworkRevision:(item:CatalogCard['representative'])=>string};
function Card({card,view,selected,onSelect,revision}:{card:CatalogCard;view:CatalogBrowseView;selected:boolean;onSelect:()=>void;revision:string}):React.JSX.Element{
 const count=view==='artists'?`${card.releaseCount} 张专辑 · ${card.trackCount} 首曲目`:view==='albumGroups'?`${card.releaseCount} 个发行版 · ${card.trackCount} 首曲目`:`${card.discCount} 碟 · ${card.trackCount} 首曲目`;
 const details=[card.subtitle,card.artist,card.date,card.edition,card.country,card.label,card.catalogNumber].filter(Boolean).join(' · ');
 const quality=card.representative?[card.representative.codec.toUpperCase(),card.representative.bitsPerSample?`${card.representative.bitsPerSample} bit`:'',card.representative.sampleRate?`${card.representative.sampleRate/1000} kHz`:''].filter(Boolean).join(' · '):'';
 return <button type="button" className={`catalog-cover-card ${selected?'selected':''} ${card.availableCount===0?'offline':''}`} data-facet-id={card.id} aria-pressed={selected} aria-label={`查看${labels[view]} ${card.name}，${count}`} onClick={onSelect} title={[card.name,details,count,`${card.fileCount} 个文件版本，${card.availableCount} 个在线`,quality?`代表曲目：${quality}`:'',card.context].filter(Boolean).join('\n')}>
  <Artwork item={card.representative} revision={revision} className="catalog-card-art"/>
  <span className="catalog-card-info"><strong>{card.name}</strong><small className="catalog-card-description">{details|| (view==='artists'?'代表作品的专辑封面':view==='albumGroups'?'同一专辑的多个发行版':'本地音乐专辑')}</small><span>{count}</span><small>{card.fileCount!==card.trackCount?`${card.fileCount} 个文件版本 · `:''}{card.availableCount===0?'文件暂离线':`${card.availableCount} 个在线文件`}</small><small>{card.formats.slice(0,4).map(value=>value.toUpperCase()).join(' / ')}{card.formats.length>4?' …':''}</small></span>
 </button>;
}
function Grid({browse,preference,view,selectedId,onSelect,artworkRevision}:{browse:ReturnType<typeof useSnapshotPages<CatalogCard,CatalogBrowseQuery>>;preference:CatalogViewPreference;view:CatalogBrowseView;selectedId:string;onSelect:(card:CatalogCard)=>void;artworkRevision:Props['artworkRevision']}):React.JSX.Element{
 const root=useRef<HTMLDivElement|null>(null),raf=useRef<number|null>(null),pendingFocus=useRef<number|null>(null),[box,setBox]=useState({width:600,height:420,top:0}),[focused,setFocused]=useState<number|null>(null),[jump,setJump]=useState('');
 const g=geometry[preference.density],columns=preference.layout==='list'?1:Math.max(1,Math.min(8,Math.floor((box.width+12)/(g.min+12)))),pitch=preference.layout==='list'?96:g.height+12;
 const rows=Math.ceil(browse.total/columns),firstRow=Math.max(0,Math.floor(box.top/pitch)-2),first=firstRow*columns,end=Math.min(browse.total,first+120,(firstRow+Math.ceil(box.height/pitch)+4)*columns),oldGeometry=useRef({columns,pitch});
 const indices=Array.from({length:Math.max(0,end-first)},(_,i)=>first+i);if(focused!==null&&focused<browse.total&&!indices.includes(focused))indices.push(focused);indices.sort((a,b)=>a-b);
 const measure=()=>{const e=root.current;if(e)setBox({width:e.clientWidth,height:e.clientHeight,top:e.scrollTop});};
 const schedule=()=>{if(raf.current===null)raf.current=requestAnimationFrame(()=>{raf.current=null;measure();});};
 useLayoutEffect(()=>{measure();const e=root.current;if(!e)return;const observer=new ResizeObserver(schedule);observer.observe(e);return()=>{observer.disconnect();if(raf.current!==null)cancelAnimationFrame(raf.current);raf.current=null;};},[]);
 useLayoutEffect(()=>{const e=root.current;if(!e)return;const old=oldGeometry.current,anchor=Math.floor(box.top/old.pitch)*old.columns,max=Math.max(0,rows*pitch-e.clientHeight);e.scrollTop=Math.min(max,old.columns===columns&&old.pitch===pitch?e.scrollTop:Math.floor(anchor/columns)*pitch);oldGeometry.current={columns,pitch};measure();},[columns,pitch,rows]);
 useEffect(()=>{browse.range(first,end,focused);},[first,end,focused,browse.generation,browse.total,browse.range]);
 useLayoutEffect(()=>{const at=pendingFocus.current;if(at!==null&&browse.itemAt(at)){const button=root.current?.querySelector<HTMLButtonElement>(`[data-catalog-index="${at}"] button`);if(button){pendingFocus.current=null;button.focus({preventScroll:true});}}},[browse.generation,focused,columns,pitch]);
 useEffect(()=>{if(focused!==null&&focused>=browse.total){setFocused(null);pendingFocus.current=null;root.current?.focus();}},[browse.total,focused]);
 function navigate(at:number):void{const e=root.current;if(!e||!browse.total)return;at=Math.max(0,Math.min(browse.total-1,at));const top=Math.floor(at/columns)*pitch;if(top<e.scrollTop)e.scrollTop=top;else if(top+pitch>e.scrollTop+e.clientHeight)e.scrollTop=Math.max(0,top+pitch-e.clientHeight);pendingFocus.current=at;setFocused(at);e.focus({preventScroll:true});measure();}
 function keyDown(event:React.KeyboardEvent<HTMLDivElement>):void{
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))return;
  event.preventDefault();const node=(event.target as HTMLElement).closest<HTMLElement>('[data-catalog-index]'),at=node?Number(node.dataset.catalogIndex):Math.floor(box.top/pitch)*columns,step=Math.max(columns,Math.floor(box.height/pitch)*columns);
  navigate(event.key==='Home'?0:event.key==='End'?browse.total-1:at+(event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:event.key==='ArrowUp'?-columns:event.key==='ArrowDown'?columns:event.key==='PageUp'?-step:step));
 }
 const width=Math.max(0,(box.width-12*(columns-1))/columns);
 return <><div className="catalog-grid-navigation"><span role="status">{browse.total.toLocaleString()} 个{labels[view]}</span><form onSubmit={e=>{e.preventDefault();if(/^\d{1,10}$/.test(jump))navigate(Number(jump)-1);}}><label>跳到第 <input aria-label={`跳到第几个${labels[view]}`} inputMode="numeric" value={jump} onChange={e=>setJump(e.target.value.slice(0,10))}/> 项</label><button disabled={!browse.total||!/^\d{1,10}$/.test(jump)}>跳转</button></form></div>
 <div ref={root} className={`catalog-cover-viewport density-${preference.density} layout-${preference.layout}`} role="list" aria-label={`${labels[view]}封面浏览`} tabIndex={0} onScroll={schedule} onKeyDown={keyDown} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null)){setFocused(null);pendingFocus.current=null;}}}>
  <div className="catalog-cover-space" style={{height:rows*pitch}}>{indices.map(index=>{const card=browse.itemAt(index);return <div className="catalog-cover-cell" key={card?.id??`loading-${index}`} role="listitem" aria-posinset={index+1} aria-setsize={browse.total} data-catalog-index={index} style={{top:Math.floor(index/columns)*pitch,left:(index%columns)*(width+12),width,height:pitch-12}} onFocusCapture={()=>setFocused(index)}>{card?<Card card={card} view={view} selected={selectedId===card.id} onSelect={()=>onSelect(card)} revision={artworkRevision(card.representative)}/>:<div className="catalog-card-placeholder" aria-label={`第 ${index+1} 项正在读取`}>正在读取…</div>}</div>;})}</div>
 </div></>;
}
export function CatalogBrowser({filters,view,role,revision,selectedId,selectedName,onSelect,artworkRevision}:Props):React.JSX.Element{
 const [query,setQuery]=useState(''),[settled,setSettled]=useState(''),[sort,setSort]=useState<CatalogBrowseQuery['sort']>('name'),[direction,setDirection]=useState<'asc'|'desc'>('asc'),[selectionError,setSelectionError]=useState(''),settings=useCatalogViewPreference();
 useEffect(()=>{const timer=setTimeout(()=>setSettled(query),220);return()=>clearTimeout(timer);},[query]);
 const request=useMemo(()=>({view,role,query:settled,sort,direction,...(filters?{filters}:{})}),[view,role,settled,sort,direction,filters]),browse=useSnapshotPages(request,revision,config),p=settings.preference;
 function select(card:CatalogCard):void{try{const row=browse.find(item=>item.id===card.id);setSelectionError('');onSelect(row.item.id,row.item.name);}catch(e){setSelectionError(String(e instanceof Error?e.message:e));}}
 return <section className="catalog-cover-browser" aria-label={`${labels[view]}分类`}><div className="section-heading"><h2>{labels[view]}收藏</h2><button className="catalog-clear-filter" aria-pressed={!selectedId} onClick={()=>onSelect('','')}>全部曲目</button></div>
  <div className="catalog-cover-toolbar"><label className="catalog-cover-search">搜索{labels[view]}<input aria-label={`搜索${labels[view]}分类`} placeholder={`输入${labels[view]}名称、拼音或首字母`} value={query} onChange={e=>setQuery(e.target.value.slice(0,256))}/></label><label>排序<select aria-label={`${labels[view]}排序`} title="发行日期升序按最早可能日期、降序按最晚可能日期；未知日期置后，年／月信息不会当作准确日期。" value={sort} onChange={e=>{const value=e.target.value as CatalogBrowseQuery['sort'];setSort(value);setDirection(value==='name'?'asc':'desc');}}><option value="name">名称</option><option value="count">文件数量</option>{view==='albums'&&<option value="date">发行日期</option>}</select></label>
   <label>方向<select aria-label="分类排序方向" value={direction} onChange={e=>setDirection(e.target.value as 'asc'|'desc')}><option value="asc">从小到大／从早到晚</option><option value="desc">从大到小／从晚到早</option></select></label><div className="catalog-layout-buttons" aria-label="分类显示方式"><button aria-pressed={p.layout==='cards'} disabled={settings.status!=='ready'} onClick={()=>void settings.change('cards',p.density)}>封面</button><button aria-pressed={p.layout==='list'} disabled={settings.status!=='ready'} onClick={()=>void settings.change('list',p.density)}>列表</button></div><label>密度<select aria-label="封面网格密度" value={p.density} disabled={settings.status!=='ready'||p.layout==='list'} onChange={e=>void settings.change(p.layout,e.target.value as CatalogViewPreference['density'])}><option value="compact">紧凑</option><option value="comfortable">舒适</option><option value="large">宽松</option></select></label><button onClick={browse.retry}>刷新分类</button>
  </div>
  {selectedId&&<p className="catalog-selected-filter">当前筛选：{selectedName}<button onClick={()=>onSelect('','')}>清除</button></p>}
  {(settings.message||settings.status==='unknown')&&<div className="catalog-view-message" role={settings.status==='unknown'?'alert':'status'}>{settings.message}{settings.status==='unknown'&&<button onClick={()=>void settings.reload()}>重新读取显示设置</button>}</div>}
  {(browse.error||selectionError)&&<div className="catalog-view-message" role="alert">{browse.error||selectionError}<button onClick={()=>{setSelectionError('');browse.retry();}}>重新读取分类</button></div>}
  {browse.total>0?<Grid key={JSON.stringify(request)} browse={browse} preference={p} view={view} selectedId={selectedId} onSelect={select} artworkRevision={artworkRevision}/>:<p className="catalog-cover-empty" role="status">{browse.loading?'正在读取分类…':query?'没有匹配的分类':'还没有可显示的分类，添加音乐后会出现在这里。'}</p>}
  {view==='artists'&&<p className="catalog-cover-caption">封面来自代表作品；上方“作品署名”可切换歌手、专辑艺人、作曲等角色。</p>}
 </section>;
}
