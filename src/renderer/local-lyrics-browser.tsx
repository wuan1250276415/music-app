import React,{useEffect,useRef,useState} from 'react';
import type {LibraryItem,SavedLocalLyricsQuery,SavedLocalLyricsPage,SavedLocalLyricsVersion} from '../shared/contracts';
import {useFocus,trap} from './dialog-focus';
import {LyricsContext} from './lyrics-context';
import './lyrics-documents.css';

const associations={current:'当前曲目范围','previous-scope':'旧曲目范围',removed:'关联曲目已移除'};
export function LocalLyricsBrowserDialog({target,initialSameItem=false,onClose,onCopy}:{target:LibraryItem|null;initialSameItem?:boolean;onClose:()=>void;onCopy:(target:LibraryItem,source:SavedLocalLyricsVersion)=>void}):React.JSX.Element{
 const [query,setQuery]=useState(''),[association,setAssociation]=useState<SavedLocalLyricsQuery['association']>(initialSameItem&&target?'same-item':'all'),[kind,setKind]=useState<SavedLocalLyricsQuery['kind']>('all'),[lastKnownOnly,setLastKnownOnly]=useState(false);
 const [page,setPage]=useState<SavedLocalLyricsPage|null>(null),[viewing,setViewing]=useState<SavedLocalLyricsVersion|null>(null),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 const dialog=useRef<HTMLDivElement|null>(null),alive=useRef(true),working=useRef(false),epoch=useRef(0),events=useRef(0);
 useFocus(dialog);
 const disabled=loading||busy;
 function filters():SavedLocalLyricsQuery{return {query,association,kind,lastKnownOnly,...(association==='same-item'&&target?{itemId:target.id}:{})};}
 useEffect(()=>{
  alive.current=true;const stop=window.music.onEvent(event=>{if(event.event==='lyricsChanged'||event.event==='libraryChanged'){events.current++;if(working.current)setStale(true);else setRevision(value=>value+1);}});
  return()=>{alive.current=false;epoch.current++;stop();};
 },[]);
 useEffect(()=>{if(!target&&association==='same-item')setAssociation('all');},[target,association]);
 useEffect(()=>{const active=document.activeElement;if(disabled&&(!dialog.current?.contains(active)||active?.matches(':disabled')))dialog.current?.focus();},[disabled]);
 useEffect(()=>{
  const request=++epoch.current;setLoading(true);setError('');setPage(null);setViewing(null);setStale(false);
  const timer=setTimeout(()=>{
   if(association==='same-item'&&!target){setLoading(false);return;}
   const stamp=events.current;
   void window.music.savedLocalLyrics({query,association,kind,lastKnownOnly,...(association==='same-item'?{itemId:target!.id}:{})}).then(value=>{if(alive.current&&request===epoch.current){setPage(value);if(events.current!==stamp)setStale(true);}}).catch(e=>{if(alive.current&&request===epoch.current)setError(String(e));}).finally(()=>{if(alive.current&&request===epoch.current)setLoading(false);});
  },180);
  return()=>clearTimeout(timer);
 },[query,association,kind,lastKnownOnly,target?.id,revision]);
 async function more():Promise<void>{
  if(working.current||loading||stale||!page?.nextCursor)return;working.current=true;setBusy(true);setError('');const request=epoch.current,cursor=page.nextCursor;
  try{const value=await window.music.savedLocalLyrics({...filters(),cursor});if(alive.current&&request===epoch.current)setPage(previous=>previous?{...value,items:[...previous.items,...value.items]}:value);}
  catch(e){if(alive.current&&request===epoch.current)setError(String(e));}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 async function inspect(id:string):Promise<void>{
  if(working.current||loading)return;working.current=true;setBusy(true);setError('');setViewing(null);const request=epoch.current,stamp=events.current;
  try{const value=await window.music.savedLocalLyricsVersion(id);if(alive.current&&request===epoch.current){setViewing(value);setStale(events.current!==stamp);}}
  catch(e){if(alive.current&&request===epoch.current){setError(String(e));setStale(true);}}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 return <div className="collection-backdrop"><div ref={dialog} className="collection-dialog catalog-dialog lyrics-documents-dialog" role="dialog" aria-modal="true" aria-label="本地歌词原文目录" tabIndex={-1} onKeyDown={event=>trap(event,dialog.current,onClose,disabled)}>
  <header><div><h2>本地歌词原文目录</h2><p>查阅读取时保存的 LRC / TXT，包括旧范围和已移除曲目的历史。</p></div><button disabled={disabled} aria-label="关闭本地歌词原文目录" onClick={onClose}>×</button></header>
  <fieldset className="lyrics-saved-filters lyrics-local-filters" disabled={busy}>
   <label>检索文件名或原曲目信息<input maxLength={256} value={query} placeholder="文件名 / 歌曲 / 歌手 / 专辑 / 语言" onChange={event=>setQuery(event.target.value)}/></label>
   <label>关联范围<select value={association} onChange={event=>setAssociation(event.target.value as SavedLocalLyricsQuery['association'])}><option value="all">全部本地原文</option><option value="removed">关联曲目已移除</option><option value="same-item" disabled={!target}>当前曲目的全部范围</option></select></label>
   <label>歌词类型<select value={kind} onChange={event=>setKind(event.target.value as SavedLocalLyricsQuery['kind'])}><option value="all">全部类型</option><option value="timed">同步歌词</option><option value="plain">纯文本</option></select></label>
   <label className="lyrics-local-latest"><input type="checkbox" checked={lastKnownOnly} onChange={event=>setLastKnownOnly(event.target.checked)}/>只看各来源最近保存版本</label>
  </fieldset>
  {error&&<p className="lyrics-document-error" role="alert">{error}</p>}{stale&&<p role="status">曲库或历史已变化，请刷新目录后再复制。</p>}
  <div className="lyrics-document-body">
   <p>“最近保存”不表示文件当前可用或内容未变。此目录不会自动替换正在使用的歌词。</p>
   {!page?.items.length&&<p>{loading?'正在查找原文历史…':'没有符合条件的本地原文历史。'}</p>}
   {page?.items.map(version=><div className="lyrics-document-version" key={version.id}><div><strong>{version.label}{version.lastKnown?' · 最近保存':''}</strong><small>{associations[version.association]}{version.itemTitle?` · ${version.itemTitle}`:''}{version.fileAvailable===false?' · 音乐文件不可用':''}</small><small>原曲目：{version.originalTitle} · {version.originalArtist} · {version.originalAlbum}</small><small>{version.kind==='timed'?'同步':'文本'} · {version.encoding}{version.language?` · ${version.language}`:''} · {version.lineCount} 行 · {new Date(version.createdAt).toLocaleString()}</small></div><button disabled={disabled} onClick={()=>void inspect(version.id)}>查看原文</button></div>)}
   {page?.nextCursor&&<button disabled={disabled||stale} onClick={()=>void more()}>更多原文版本</button>}
   {viewing&&<section className="lyrics-document-preview"><h3>{viewing.summary.label}</h3><p>{associations[viewing.summary.association]} · {viewing.summary.encoding} · {viewing.summary.rawBytes} 字节</p><LyricsContext value={viewing.preview.scopeSnapshot}/><small className="lyrics-document-hash">原始内容 SHA-256：{viewing.summary.rawSha256}</small><textarea aria-label="本地歌词保存原文" rows={10} readOnly value={viewing.preview.text}/><div className="lyrics-saved-actions"><button disabled={disabled} onClick={()=>void inspect(viewing.summary.id)}>重新读取此版本</button></div><p>{target?`复制目标：${target.title} · ${target.artist}`:'选择一首歌曲后，可将此原文复制为它的新歌词版本。'}</p><button disabled={disabled||stale||!target} onClick={()=>target&&onCopy(target,viewing)}>复制到当前曲目并预览</button><p>复制需要重新选择目标时间基并确认；保存的原始版本继续保留。</p></section>}
  </div>
  <footer><button disabled={disabled} onClick={()=>setRevision(value=>value+1)}>刷新目录</button><button disabled={disabled} onClick={onClose}>关闭</button></footer>
 </div></div>;
}
