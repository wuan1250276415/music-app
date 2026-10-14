import React,{useEffect,useRef,useState} from 'react';
import {readSmartHistoryPage,readSmartHistoryDetail,readSmartPlaylistRestoreRequest,readSmartPlaylistRestoreResult,type SmartHistoryPage,type SmartHistoryDetail,type SmartPlaylistRestoreRequest} from '../shared/smart-playlist-history';
import type {BrowseQuery} from '../shared/library-browse';
import {musicFilterCount} from '../shared/music-filters';
import {MusicFiltersDialog} from './music-filters-dialog';
import {MusicQueryPreview} from './music-query-preview';
import {trap,useFocus} from './dialog-focus';
import './smart-playlist-history.css';

const pendingKey='aural-smart-playlist-restore-pending-v1';
const actions={create:'创建',update:'修改',delete:'删除前规则',restore:'恢复'};
const sorts={default:'当前范围的默认排序',title:'歌曲名称',artist:'艺人名称',album:'专辑名称',date:'发行日期（保留精度）',added:'加入时间'};
function scopeLabel(query:BrowseQuery):string{
 const labels={all:'全曲库',artists:'艺人分类',albums:'发行专辑',albumGroups:'专辑概念',genres:'风格分类',folders:'原文件夹范围',favorites:'已收藏音乐',recent:'最近添加',playlists:'歌单'};
 return `${labels[query.view]}${query.value&&query.view!=='folders'?` · ${query.value}`:''}`;
}
function initialPending():{pending:SmartPlaylistRestoreRequest|null;broken:boolean}{
 try{const raw=localStorage.getItem(pendingKey);if(raw&&raw.length>16384)throw new Error('恢复记录过长');return {pending:raw?readSmartPlaylistRestoreRequest(JSON.parse(raw)):null,broken:false};}
 catch{return {pending:null,broken:true};}
}
type Source={playlistId:string;revision:number;fingerprint:string};
export function SmartPlaylistHistoryDialog({playlistId,revision,onClose,onOpen,onChanged}:{playlistId?:string;revision:number;onClose:()=>void;onOpen:(id:string)=>void;onChanged:()=>void}):React.JSX.Element{
 const [initial]=useState(initialPending),[pending,setPending]=useState(initial.pending),[broken,setBroken]=useState(initial.broken);
 const [scope,setScope]=useState(initial.pending?.playlistId??playlistId),[cursor,setCursor]=useState<string|undefined>(),[refresh,setRefresh]=useState(0),[page,setPage]=useState<SmartHistoryPage|null>(null),[pageBusy,setPageBusy]=useState(false);
 const [detail,setDetail]=useState<SmartHistoryDetail|null>(null),[detailBusy,setDetailBusy]=useState(false),[stale,setStale]=useState(false),[changed,setChanged]=useState(false),[filtersOpen,setFiltersOpen]=useState(false),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[genreNames,setGenreNames]=useState<Record<string,string>>({});
 const ref=useRef<HTMLDivElement|null>(null),alive=useRef(true),flight=useRef(false),readGeneration=useRef(0),readSource=useRef<Source|null>(null),detailRef=useRef(detail);detailRef.current=detail;useFocus(ref);
 function reloadList():void{setCursor(undefined);setRefresh(value=>value+1);setChanged(false);}
 useEffect(()=>{
  alive.current=true;
  const unsubscribe=window.music.onEvent(event=>{
   if(event.event!=='libraryChanged'||(event.payload as {smartPlaylist?:boolean}).smartPlaylist!==true)return;
   setChanged(true);const target=(event.payload as {playlistId?:string}).playlistId;
   if(!target||target===detailRef.current?.record.playlistId||target===readSource.current?.playlistId){setStale(true);setConfirm(false);readGeneration.current++;readSource.current=null;setDetailBusy(false);}
  });
  return()=>{alive.current=false;readGeneration.current++;unsubscribe();};
 },[]);
 useEffect(()=>{
  let active=true;setPageBusy(true);setPage(null);
  void window.music.smartPlaylistHistory({...(scope?{playlistId:scope}:{}),...(cursor?{cursor}:{})}).then(raw=>{
   const value=readSmartHistoryPage(raw);if(value.playlistId!==(scope??null))throw new Error('历史响应与所选范围不一致');
   if(active)setPage(value);
  }).catch(e=>{if(active)setError(String(e instanceof Error?e.message:e).slice(0,512));}).finally(()=>{if(active)setPageBusy(false);});
  return()=>{active=false;};
 },[scope,cursor,refresh]);
 async function load(source:Source,allowPending=false):Promise<void>{
  if(flight.current||pending&&!allowPending)return;
  const g=++readGeneration.current;readSource.current=source;setDetailBusy(true);setConfirm(false);setError('');
  try{
   const value=readSmartHistoryDetail(await window.music.smartPlaylistHistoryDetail({playlistId:source.playlistId,revision:source.revision}));
   if(value.record.playlistId!==source.playlistId||value.record.revision!==source.revision||value.record.fingerprint!==source.fingerprint)throw new Error('历史内容与所选来源不一致，请刷新');
   if(alive.current&&g===readGeneration.current){setDetail(value);setStale(false);}
  }catch(e){if(alive.current&&g===readGeneration.current){setDetail(null);setError(String(e instanceof Error?e.message:e).slice(0,512));}}
  finally{if(alive.current&&g===readGeneration.current){readSource.current=null;setDetailBusy(false);}}
 }
 useEffect(()=>{if(initial.pending)void load({playlistId:initial.pending.playlistId,revision:initial.pending.sourceRevision,fingerprint:initial.pending.sourceFingerprint},true);},[]);
 const genreIds=detail?.record.definition.query.genreFilter?.ids??[];
 useEffect(()=>{
  let active=true;setGenreNames({});
  void Promise.allSettled(genreIds.map(id=>window.music.genre(id))).then(values=>{if(active)setGenreNames(Object.fromEntries(values.flatMap((value,index)=>value.status==='fulfilled'?[[genreIds[index],value.value.genre.name]]:[])));});
  return()=>{active=false;};
 },[JSON.stringify(genreIds)]);
 async function restore():Promise<void>{
  if(flight.current||broken||!pending&&(!detail||stale||!confirm||detailBusy))return;
  flight.current=true;setBusy(true);setError('');setNotice('');
  try{
   const request=pending??readSmartPlaylistRestoreRequest({commandId:crypto.randomUUID(),playlistId:detail!.record.playlistId,sourceRevision:detail!.record.revision,sourceFingerprint:detail!.record.fingerprint,headRevision:detail!.headRevision,baseRevision:detail!.current?.revision??null});
   const canonical=JSON.stringify(request),existing=localStorage.getItem(pendingKey);
   if(existing&&existing!==canonical)throw new Error('另一个原恢复操作待核对，请关闭后重新打开历史');
   localStorage.setItem(pendingKey,canonical);setPending(request);
   const result=readSmartPlaylistRestoreResult(await window.music.restoreSmartPlaylist(request));
   if(result.commandId!==request.commandId||result.status==='saved'&&(!result.value||result.value.id!==request.playlistId||result.value.revision!==request.headRevision+1))throw new Error('恢复回执与原请求不一致，请重试原操作');
   if(result.status==='saved'&&detail?.record.fingerprint===request.sourceFingerprint&&(result.value!.name!==detail.record.name||JSON.stringify(result.value!.definition)!==JSON.stringify(detail.record.definition)))throw new Error('恢复回执与历史规则不一致，请重试原操作');
   if(localStorage.getItem(pendingKey)!==canonical)throw new Error('原恢复记录已变化，请重新打开历史核对');
   localStorage.removeItem(pendingKey);
   if(!alive.current)return;setPending(null);setConfirm(false);setStale(true);
   if(result.status==='rejected'){setError(result.error);return;}
   setNotice('原恢复操作已保存。请重新读取当前状态；历史列表可查看新增的恢复记录。');reloadList();onChanged();
  }catch(e){if(alive.current)setError(String(e instanceof Error?e.message:e).slice(0,512));}
  finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 function clearBroken():void{try{localStorage.removeItem(pendingKey);setBroken(false);setError('');setNotice('无效恢复记录已清除，请重新读取当前状态后操作。');}catch(e){setError(String(e instanceof Error?e.message:e).slice(0,512));}}
 const locked=busy||!!pending||broken,query=detail?.record.definition.query,genre=query?.genreFilter,sort=query?.sort;
 return <><div className="collection-backdrop"><div ref={ref} className="collection-dialog smart-history-dialog" role="dialog" aria-modal="true" aria-labelledby="smart-history-title" aria-hidden={filtersOpen||undefined} onKeyDown={event=>trap(event,ref.current,onClose,busy||filtersOpen)}>
  <header><h2 id="smart-history-title">智能歌单规则历史</h2><button type="button" disabled={busy||filtersOpen} aria-label="关闭智能歌单规则历史" onClick={onClose}>×</button></header>
  <p className="collection-note">历史保存规则内容。恢复会生成新版本；匹配歌曲以当前曲库为准。</p>
  {broken&&<p className="collection-error" role="alert">上次恢复记录无法读取。请核对历史和当前歌单后清除无效记录。</p>}{error&&<p className="collection-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {pending&&<div className="smart-history-pending"><p>原恢复操作结果待核对。重试会使用同一个操作和所选历史来源。</p><button type="button" disabled={busy||broken} onClick={()=>void restore()}>{busy?'正在核对…':'重试原恢复操作'}</button></div>}
  <div className="smart-history-tools"><button type="button" disabled={pageBusy||busy} onClick={reloadList}>刷新历史</button>{scope&&<button type="button" disabled={locked} onClick={()=>{setScope(undefined);setCursor(undefined);}}>查看全部历史（含已删除歌单）</button>}{changed&&<span role="status">规则目录有更新，可刷新历史查看。</span>}</div>
  {pageBusy?<p role="status">正在读取历史…</p>:<ol className="smart-history-list">{page?.items.map(item=><li key={item.ordinal}><div><strong>{item.name}</strong><small>{actions[item.action]} · {new Date(item.createdAt).toLocaleString('zh-CN')}</small></div><button type="button" disabled={locked||detailBusy} onClick={()=>void load({playlistId:item.playlistId,revision:item.revision,fingerprint:item.fingerprint})}>查看规则</button></li>)}{page?.items.length===0&&<li>此范围没有更多规则历史。</li>}</ol>}
  <div className="smart-history-tools"><button type="button" disabled={pageBusy||busy||!cursor} onClick={reloadList}>回到最新记录</button><button type="button" disabled={pageBusy||busy||!page?.nextCursor} onClick={()=>setCursor(page!.nextCursor!)}>更早的记录</button></div>
  {detailBusy&&<p role="status">正在核对历史来源与当前规则…</p>}
  {detail&&query&&<section className="smart-history-detail" aria-label="所选历史规则"><h3>{detail.record.name} · {actions[detail.record.action]}</h3><dl><dt>范围</dt><dd>{scopeLabel(query)}</dd><dt>检索词</dt><dd>{query.query||'不限'}</dd><dt>排序</dt><dd>{sorts[sort?.mode??'default']}{sort&&sort.mode!=='default'?sort.direction==='asc'?' · 升序':' · 降序':''}</dd><dt>文件版本</dt><dd>{query.collapseVersions?'折叠同一发行曲目的文件版本':'显示全部文件版本'}</dd>{genre&&genre.ids.length>0&&<><dt>分类风格范围</dt><dd>{genre.ids.map(id=>genreNames[id]??'无法读取的风格').join('、')} · {genre.operator==='all'?'全部满足':'任意满足'} · {genre.descendants?'包含下级':'仅指定风格'}</dd></>}</dl>
   <button type="button" disabled={busy} onClick={()=>setFiltersOpen(true)}>查看历史组合条件 · {musicFilterCount(query.filters??{})} 组</button>{detail.record.sourceRevision!==null&&<button type="button" disabled={locked||detailBusy} onClick={()=>void load({playlistId:detail.record.playlistId,revision:detail.record.sourceRevision!,fingerprint:detail.record.sourceFingerprint!})}>查看该恢复记录的来源</button>}
   <p>{detail.current?`当前歌单：“${detail.current.name}”。确认后会替换当前规则。`:'当前歌单已删除。确认后会按原身份恢复。'}</p>{detail.record.action==='delete'&&<p>此记录保存删除前的规则内容。</p>}{stale&&<p role="status">当前状态待重新核对，请重新读取后恢复。</p>}
   <div className="smart-history-tools"><button type="button" disabled={busy||detailBusy} onClick={()=>void load({playlistId:detail.record.playlistId,revision:detail.record.revision,fingerprint:detail.record.fingerprint},true)}>重新读取当前状态</button>{detail.current&&<button type="button" disabled={busy} onClick={()=>onOpen(detail.record.playlistId)}>打开当前歌单</button>}</div>
   {!filtersOpen&&<MusicQueryPreview query={query} revision={revision} scopeLabel={scopeLabel(query)} disabled={busy}/>}
   {!pending&&<div className="smart-history-confirm"><label><input type="checkbox" checked={confirm} disabled={locked||stale||detailBusy} onChange={event=>setConfirm(event.target.checked)}/>{detail.current?'确认用这份历史规则替换当前规则':'确认恢复这份历史规则及原歌单身份'}</label><button type="button" className="primary-button" disabled={locked||stale||detailBusy||!confirm} onClick={()=>void restore()}>{busy?'正在恢复…':'恢复所选历史规则'}</button></div>}
  </section>}
  <footer>{broken&&<button type="button" onClick={clearBroken}>清除无效恢复记录</button>}<button type="button" disabled={busy||filtersOpen} onClick={onClose}>{pending?'关闭，保留待核对操作':'关闭'}</button></footer>
 </div></div>{filtersOpen&&detail&&query&&<MusicFiltersDialog value={query.filters??{}} previewQuery={query} scopeLabel={scopeLabel(query)} revision={revision} readOnly onApply={()=>{}} onClose={()=>setFiltersOpen(false)}/>}</>;
}
