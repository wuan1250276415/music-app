import React,{useEffect,useRef,useState} from 'react';
import {readHistoryPage,type PlaybackHistoryPage} from '../shared/playback-history';
import {HistoryExportControls} from './history-export-controls';
import {PlaybackPolicySettings} from './playback-policy-settings';
import {playbackRuleSummary,defaultPlaybackRule} from '../shared/playback-policy';
import {useFocus,trap} from './dialog-focus';
import './playback-history.css';

function duration(us:number):string{const seconds=Math.floor(us/1000000);return seconds>=3600?`${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分钟`:`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
function time(value:string):string{return new Date(value).toLocaleString('zh-CN',{hour12:false});}
export function PlaybackHistoryDialog({itemId,onClose,onPlay,onSearch}:{itemId?:string;onClose:()=>void;onPlay:(id:string)=>Promise<void>;onSearch:(value:string)=>void}):React.JSX.Element {
 const dialog=useRef<HTMLDivElement|null>(null),list=useRef<HTMLDivElement|null>(null),alive=useRef(true),epoch=useRef(0),working=useRef(false),events=useRef(0);
 const [policyBusy,setPolicyBusy]=useState(false);
 const [query,setQuery]=useState(''),[sameItem,setSameItem]=useState(Boolean(itemId)),[page,setPage]=useState<PlaybackHistoryPage|null>(null),[revision,setRevision]=useState(0),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState<{enabled:boolean;pending:number;error:string}|null>(null);
 useFocus(dialog);
 useEffect(()=>{if(list.current)list.current.scrollTop=0;},[page?.items[0]?.id]);
 useEffect(()=>{if(!busy&&!loading&&!policyBusy)return;const active=document.activeElement;if(!dialog.current?.contains(active)||active?.matches(':disabled'))dialog.current?.focus();},[busy,loading,policyBusy]);
 useEffect(()=>{alive.current=true;const stop=window.music.onEvent(e=>{if(e.event==='playbackHistoryChanged'||e.event==='libraryChanged'){events.current++;setStale(true);}});return()=>{alive.current=false;epoch.current++;stop();};},[]);
 useEffect(()=>{
  const token=++epoch.current,stamp=events.current;setLoading(true);setError('');setPage(null);setStatus(null);setStale(false);
  const timer=setTimeout(()=>{
   void Promise.all([window.music.playbackHistory({query,...(sameItem&&itemId?{itemId}:{})}),window.music.playbackHistoryStatus()]).then(([raw,state])=>{
    const value=readHistoryPage(raw);
    if(!state||Object.keys(state).length!==3||typeof state.enabled!=='boolean'||!Number.isSafeInteger(state.pending)||state.pending<0||state.pending>512||typeof state.error!=='string')throw new Error('播放历史保存状态无效');
    if(alive.current&&epoch.current===token){setPage(value);setStatus(state);setStale(events.current!==stamp);}
   }).catch(e=>{if(alive.current&&epoch.current===token)setError(String(e instanceof Error?e.message:e));}).finally(()=>{if(alive.current&&epoch.current===token)setLoading(false);});
  },180);return()=>clearTimeout(timer);
 },[query,sameItem,itemId,revision]);
 async function more():Promise<void>{
  if(working.current||policyBusy||loading||stale||!page?.nextCursor)return;working.current=true;setBusy(true);setError('');const token=epoch.current,cursor=page.nextCursor,stamp=events.current;
  try{const value=readHistoryPage(await window.music.playbackHistory({query,...(sameItem&&itemId?{itemId}:{}),cursor}));
   if(value.items.some(row=>row.id>=cursor.before)||value.nextCursor&&(value.nextCursor.ceiling!==cursor.ceiling||value.nextCursor.scope!==cursor.scope))throw new Error('播放历史分页范围不符');
   if(alive.current&&token===epoch.current){setPage(value);setStale(events.current!==stamp);}
  }catch(e){if(alive.current&&token===epoch.current)setError(String(e instanceof Error?e.message:e));}finally{working.current=false;if(alive.current)setBusy(false);}
 }
 async function play(id:string):Promise<void>{
  if(working.current||policyBusy||loading)return;working.current=true;setBusy(true);setError('');
  try{await onPlay(id);}catch(e){if(alive.current){setError(String(e instanceof Error?e.message:e));setStale(true);}}finally{working.current=false;if(alive.current)setBusy(false);}
 }
 return <div className="collection-backdrop"><div ref={dialog} className="collection-dialog catalog-dialog playback-history-dialog" role="dialog" aria-modal="true" aria-label="播放历史与统计" tabIndex={-1} onKeyDown={e=>trap(e,dialog.current,onClose,busy||policyBusy)}>
  <header><div><h2>播放历史与统计</h2><p>保留播放时的歌曲资料，跳转进度不计入时长。</p></div><button disabled={busy||policyBusy} aria-label="关闭播放历史" onClick={onClose}>×</button></header>
  <fieldset disabled={busy||policyBusy} className="playback-history-filters"><label>搜索历史<input value={query} maxLength={256} placeholder="歌曲、歌手、专辑" onChange={e=>setQuery(e.target.value)}/></label>{itemId&&<label className="playback-history-same"><input type="checkbox" checked={sameItem} onChange={e=>setSameItem(e.target.checked)}/>仅此曲目</label>}<button disabled={loading} onClick={()=>setRevision(v=>v+1)}>刷新</button></fieldset>
  {status?.error&&<p className="error" role="alert">{status.error}</p>}
  {status&&<p className="playback-history-save" role="status">{status.enabled?`${status.pending?`有 ${status.pending} 项待保存；`:'已保存的记录可在重启后查看；'}播放中约每 15 秒更新。`:'当前历史记录暂停，请检查待保存数据。'}</p>}
  {page&&<div className="playback-history-totals"><span>历史记录 <strong>{page.totals.sessions.toLocaleString()}</strong></span><span>达标播放 <strong>{page.totals.plays.toLocaleString()}</strong></span><span>设备回报时长 <strong>{duration(page.totals.presentedUs)}</strong></span><span>估算时长 <strong>{duration(page.totals.estimatedUs)}</strong></span></div>}
  <details className="playback-history-policy"><summary>统计口径与设置</summary><PlaybackPolicySettings onBusy={setPolicyBusy}/></details>
  <HistoryExportControls scope={{query,...(sameItem&&itemId?{itemId}:{})}} disabled={busy||policyBusy||loading}/>
  {stale&&<p role="status">记录或曲库已更新，可刷新后继续浏览。</p>}{error&&<p className="error" role="alert">{error}</p>}{loading&&<p role="status">正在读取播放历史…</p>}
  <div ref={list} className="playback-history-list" aria-busy={loading||busy}>{page?.items.map(row=><article key={row.id}>
   <div className="playback-history-song"><strong>{row.title||'未命名歌曲'}</strong><div><button disabled={busy||policyBusy||!row.artist} onClick={()=>{onClose();onSearch(row.artist);}}>{row.artist||'未知歌手'}</button><span> · </span><button disabled={busy||policyBusy||!row.album} onClick={()=>{onClose();onSearch(row.album);}}>{row.album||'未知专辑'}</button></div><small>{time(row.startedAt)}{row.counted?' · 已达标':''}</small><small>最近进度：{time(row.observedAt!)}{row.timeBasis==='legacy-start'?' · 旧记录仅有首次观察时间':''}</small><details className="playback-history-row-policy"><summary>该次播放的统计规则</summary><p>{row.policyVersion===1?'旧版固定规则；':''}{playbackRuleSummary(row.policy?.rule??defaultPlaybackRule())}</p></details></div>
   <div className="playback-history-times"><span>设备回报 {duration(row.presentedUs)}</span>{row.estimatedUs>0&&<span>估算 {duration(row.estimatedUs)}</span>}</div>
   <button disabled={busy||policyBusy||loading||!row.available} title={row.available?'重新播放当前曲库中的歌曲':'关联歌曲暂不可用或已移出曲库'} onClick={()=>void play(row.itemId)}>{row.available?'播放':'暂不可用'}</button>
  </article>)}{page&&!page.items.length&&<p>{query||sameItem?'没有匹配的播放记录。':'还没有已保存的播放记录。'}</p>}</div>
  <footer><button disabled={busy||policyBusy} onClick={onClose}>关闭</button><button disabled={busy||policyBusy||loading||stale||!page?.nextCursor} onClick={()=>void more()}>{busy?'处理中…':'加载更早记录'}</button></footer>
 </div></div>;
}
