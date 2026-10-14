import React,{useEffect,useRef,useState} from 'react';
import type {LibraryItem,SavedLyricsQuery,SavedLyricsPage,SavedLyricsDocument,SavedLyricsStateRequest,SavedLyricsChangePage,SavedLocalLyricsVersion} from '../shared/contracts';
import {useFocus,trap} from './dialog-focus';
import {LyricsContext} from './lyrics-context';
import './lyrics-documents.css';

const associations={current:'当前曲目范围','previous-scope':'旧曲目范围',removed:'关联曲目已移除'};
const actions={import:'导入',archive:'归档',restore:'恢复'};
export function SavedLyricsDialog({target,initialSameItem=false,onClose,onCopy,onBrowseLocal}:{target:LibraryItem|null;initialSameItem?:boolean;onClose:()=>void;onCopy:(target:LibraryItem,source:SavedLyricsDocument)=>void;onBrowseLocal?:()=>void}):React.JSX.Element{
 const [localOrigin,setLocalOrigin]=useState<SavedLocalLyricsVersion|null>(null);
 const [query,setQuery]=useState(''),[association,setAssociation]=useState<SavedLyricsQuery['association']>(initialSameItem&&target?'same-item':'all'),[state,setState]=useState<SavedLyricsQuery['state']>('all');
 const [page,setPage]=useState<SavedLyricsPage|null>(null),[viewing,setViewing]=useState<SavedLyricsDocument|null>(null),[changes,setChanges]=useState<SavedLyricsChangePage|null>(null);
 const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[revision,setRevision]=useState(0);
 const dialog=useRef<HTMLDivElement|null>(null),alive=useRef(true),working=useRef(false),epoch=useRef(0),attempt=useRef<SavedLyricsStateRequest|null>(null);
 useFocus(dialog);
 function filters():SavedLyricsQuery{return {query,association,state,...(association==='same-item'&&target?{itemId:target.id}:{})};}
 useEffect(()=>{alive.current=true;const stop=window.music.onEvent(event=>{if(event.event==='lyricsChanged'||event.event==='libraryChanged'){if(working.current||attempt.current)setStale(true);else setRevision(value=>value+1);}});return()=>{alive.current=false;stop();};},[]);
 useEffect(()=>{if(!target&&association==='same-item'&&!pending)setAssociation('all');},[target,association,pending]);
 useEffect(()=>{const active=document.activeElement;if((loading||busy)&&(!dialog.current?.contains(active)||active?.matches(':disabled')))dialog.current?.focus();},[loading,busy]);
 useEffect(()=>{
  const request=++epoch.current;setLoading(true);setError('');setNotice('');setPage(null);setViewing(null);setChanges(null);setLocalOrigin(null);setStale(false);
  const timer=setTimeout(()=>{
   if(association==='same-item'&&!target){setLoading(false);return;}
   void window.music.savedLyrics({query,association,state,...(association==='same-item'?{itemId:target!.id}:{})}).then(value=>{if(alive.current&&request===epoch.current)setPage(value);}).catch(e=>{if(alive.current&&request===epoch.current)setError(String(e));}).finally(()=>{if(alive.current&&request===epoch.current)setLoading(false);});
  },180);
  return()=>{clearTimeout(timer);};
 },[query,association,state,target?.id,revision]);
 async function more():Promise<void>{
  if(working.current||pending||loading||!page?.nextCursor)return;working.current=true;setBusy(true);setError('');const request=epoch.current,cursor=page.nextCursor;
  try{const value=await window.music.savedLyrics({...filters(),cursor});if(alive.current&&request===epoch.current)setPage(previous=>previous?{...value,items:[...previous.items,...value.items]}:value);}
  catch(e){if(alive.current&&request===epoch.current)setError(String(e));}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 async function inspect(id:string):Promise<void>{
  if(working.current||pending||loading)return;working.current=true;setBusy(true);setError('');setNotice('');const request=epoch.current;setChanges(null);setLocalOrigin(null);
  try{const value=await window.music.savedLyricsDocument(id);if(alive.current&&request===epoch.current){setViewing(value);setStale(false);}}
  catch(e){if(alive.current&&request===epoch.current){setError(String(e));setStale(true);}}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 async function inspectLocalOrigin(id:string):Promise<void>{
  if(working.current||pending||loading||id!==viewing?.summary.copiedFromLocalVersionId)return;working.current=true;setBusy(true);setError('');const request=epoch.current;
  try{const value=await window.music.savedLocalLyricsVersion(id);if(alive.current&&request===epoch.current)setLocalOrigin(value);}
  catch(e){if(alive.current&&request===epoch.current)setError(String(e));}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 async function history(cursor?:string):Promise<void>{
  if(working.current||pending||loading||!viewing)return;working.current=true;setBusy(true);setError('');const request=epoch.current,version=viewing.summary;
  try{const value=await window.music.savedLyricsChanges(version.id,cursor);if(!alive.current||request!==epoch.current)return;if(value.scope!==version.scope||value.revision!==version.scopeRevision){setStale(true);throw new Error('歌词范围已变化，请重新读取原文后查阅修订');}setChanges(previous=>cursor&&previous?{...value,items:[...previous.items,...value.items]}:value);}
  catch(e){if(alive.current&&request===epoch.current)setError(String(e));}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 async function submit(value?:SavedLyricsStateRequest):Promise<void>{
  if(working.current)return;const intent=value??attempt.current;if(!intent)return;
  attempt.current=intent;working.current=true;setBusy(true);setPending(true);setError('');setNotice('');const request=epoch.current;
  try{
   const result=await window.music.editSavedLyrics(intent);if(!alive.current)return;
   attempt.current=null;setPending(false);setStale(true);
   if(result.status==='rejected'){setError(result.error);return;}
   setNotice(`${actions[intent.action]}已保存，原始字节、关联范围和修订记录继续保留。`);
   // Read failures after the acknowledged commit must not create a second write attempt.
   const current=await window.music.savedLyricsDocument(intent.documentId),list=await window.music.savedLyrics(filters());
   if(alive.current&&request===epoch.current){setViewing(current);setPage(list);setChanges(null);setStale(false);}
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 function toggle():void{
  if(loading||busy||pending||stale||!viewing)return;const v=viewing.summary;
  void submit({commandId:crypto.randomUUID(),itemId:v.itemId,scope:v.scope,baseRevision:v.scopeRevision,documentId:v.id,action:v.archived?'restore':'archive'});
 }
 const disabled=loading||busy||pending;
 return <div className="collection-backdrop"><div className="collection-dialog catalog-dialog lyrics-documents-dialog" role="dialog" aria-modal="true" aria-label="用户歌词原文目录" ref={dialog} tabIndex={-1} onKeyDown={event=>trap(event,dialog.current,onClose,disabled)}>
  <header><div><h2>用户歌词原文目录</h2><p>查看保存的版本，管理旧曲目范围和已移除曲目的歌词。</p></div><button aria-label="关闭用户歌词目录" disabled={disabled} onClick={onClose}>×</button></header>
  {onBrowseLocal&&<div className="lyrics-import-entry"><button disabled={disabled} onClick={onBrowseLocal}>查阅本地 LRC / TXT 原文历史</button></div>}
  <fieldset className="lyrics-saved-filters" disabled={busy||pending}><label>检索版本名称或语言<input value={query} maxLength={256} onChange={event=>setQuery(event.target.value)} placeholder="版本名称 / zh / en"/></label><label>关联范围<select value={association} onChange={event=>setAssociation(event.target.value as SavedLyricsQuery['association'])}><option value="all">全部用户歌词</option><option value="removed">关联曲目已移除</option><option value="same-item" disabled={!target}>当前曲目的全部范围</option></select></label><label>版本状态<select value={state} onChange={event=>setState(event.target.value as SavedLyricsQuery['state'])}><option value="all">全部状态</option><option value="active">已启用</option><option value="archived">已归档</option></select></label></fieldset>
  {error&&<p className="lyrics-document-error" role="alert">{error}</p>}{notice&&<p className="lyrics-document-notice" role="status">{notice}</p>}{pending&&<p role="status">操作结果尚未确认，保留原操作等待核对。</p>}{stale&&<p role="status">歌词范围或资料已变化，请重新读取后再修改。</p>}
  <div className="lyrics-document-body">
   {!page?.items.length&&<p>{loading?'正在查找保存的原文…':'没有符合条件的用户歌词。'}</p>}
   {page?.items.map(version=><div className="lyrics-document-version" key={version.id}><div><strong>{version.label}{version.archived?' · 已归档':''}</strong><small>{associations[version.association]}{version.itemTitle?` · ${version.itemTitle}`:''}{version.fileAvailable===false?' · 音乐文件不可用':''}</small><small>{version.encoding}{version.language?` · ${version.language}`:''} · {version.lineCount} 行 · {new Date(version.createdAt).toLocaleString()}{version.copiedFromId?' · 从保存原文复制':version.copiedFromLocalVersionId?' · 从本地原文历史复制':''}</small></div><button disabled={disabled} onClick={()=>void inspect(version.id)}>查看原文</button></div>)}
   {page?.nextCursor&&<button disabled={disabled} onClick={()=>void more()}>更多原文版本</button>}
   {viewing&&<section className="lyrics-document-preview"><h3>{viewing.summary.label}{viewing.summary.archived?' · 已归档':''}</h3><p>{associations[viewing.summary.association]} · 范围修订 {viewing.summary.scopeRevision} · {viewing.preview.encoding} · {viewing.preview.rawBytes} 字节 · {viewing.summary.timeBasis==='audio-absolute'?'源音频时间':'原曲目相对时间'}</p><LyricsContext value={viewing.preview.scopeSnapshot}/><small className="lyrics-document-hash">原文 SHA-256：{viewing.preview.rawSha256}</small><textarea aria-label="用户歌词保存原文" readOnly rows={10} value={viewing.preview.text}/>
    <div className="lyrics-saved-actions"><button disabled={disabled||stale} onClick={toggle}>{viewing.summary.archived?'恢复此原范围版本':'归档此版本'}</button><button disabled={disabled} onClick={()=>void inspect(viewing.summary.id)}>重新读取此版本</button><button disabled={disabled||stale} onClick={()=>void history()}>查看此版本修订</button>{viewing.summary.copiedFromId&&<button disabled={disabled} onClick={()=>void inspect(viewing.summary.copiedFromId!)}>查看复制来源原文</button>}{viewing.summary.copiedFromLocalVersionId&&<button disabled={disabled} onClick={()=>void inspectLocalOrigin(viewing.summary.copiedFromLocalVersionId!)}>查看本地复制来源</button>}</div>
    {localOrigin&&<details open><summary>本地复制来源：{localOrigin.summary.label}</summary><LyricsContext value={localOrigin.preview.scopeSnapshot}/><p>{associations[localOrigin.summary.association]} · {localOrigin.summary.encoding} · {localOrigin.summary.rawBytes} 字节</p><small className="lyrics-document-hash">来源原文 SHA-256：{localOrigin.summary.rawSha256}</small><textarea aria-label="本地复制来源原文" readOnly rows={8} value={localOrigin.preview.text}/></details>}
    <p>{viewing.summary.association==='current'?'归档会停用当前范围的歌词来源，原文继续保留。':'归档或恢复只修改保存的原范围状态；此旧范围版本不会因此用于当前歌曲。'}</p>
    {changes&&<div className="lyrics-saved-history">{changes.items.map(change=><div className="lyrics-document-change" key={change.commandId}><strong>{actions[change.action]} · 修订 {change.revision}</strong><small>{new Date(change.createdAt).toLocaleString()}</small><small className="lyrics-document-hash">操作 ID：{change.commandId}</small></div>)}{changes.nextCursor&&<button disabled={disabled||stale} onClick={()=>void history(changes.nextCursor!)}>更多修订</button>}</div>}
    <p>{target?`复制目标：${target.title} · ${target.artist}`:'选择一首歌曲后，可将保存的原文复制为该曲目的新版本。'}</p><button disabled={disabled||stale||!target} onClick={()=>target&&onCopy(target,viewing)}>复制到当前曲目并预览</button><p>复制前重新选择目标时间基，旧范围不会自动绑定到新曲目；原始版本继续保留。</p>
   </section>}
  </div><footer><button disabled={disabled} onClick={()=>setRevision(value=>value+1)}>刷新目录</button>{pending&&<button disabled={busy||loading} onClick={()=>void submit()}>核对上次操作结果</button>}<button disabled={disabled} onClick={onClose}>关闭</button></footer>
 </div></div>;
}
