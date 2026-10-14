import React,{useEffect,useRef,useState} from 'react';
import type {BrowseQuery} from '../shared/library-browse';
import {musicFilterDependencies,musicFilterTimeAnchor,MUSIC_FILTER_MINUTE_MS} from '../shared/music-filters';
import {MUSIC_PREVIEW_SIZE,readMusicPreviewRequest,readMusicPreviewResponse,readMusicPreviewCheck,type MusicPreviewResponse} from '../shared/music-preview';
import './music-query-preview.css';

type Result={key:string;data:MusicPreviewResponse;fresh:boolean;reason:string};
function duration(seconds:number|null):string{
 if(seconds===null)return '时长未知';
 const whole=Math.floor(seconds),minutes=Math.floor(whole/60),rest=String(whole%60).padStart(2,'0');
 return minutes>=60?`${Math.floor(minutes/60)}:${String(minutes%60).padStart(2,'0')}:${rest}`:`${minutes}:${rest}`;
}
export function MusicQueryPreview({query:rawQuery,revision,scopeLabel,validationError='',disabled=false}:{query:BrowseQuery|null;revision:number;scopeLabel:string;validationError?:string;disabled?:boolean}):React.JSX.Element{
 let query:BrowseQuery|null=null,queryError=validationError;
 try{if(rawQuery)query=readMusicPreviewRequest({query:rawQuery}).query;}catch(e){queryError=String(e instanceof Error?e.message:e);}
 const key=JSON.stringify([query,revision,queryError]),keyRef=useRef(key),queryRef=useRef(query);
 keyRef.current=key;queryRef.current=query;
 const [result,setResult]=useState<Result|null>(null),[busy,setBusy]=useState<''|'preview'|'check'>(''),[error,setError]=useState('');
 const resultRef=useRef(result);resultRef.current=result;
 const alive=useRef(true),flight=useRef(false),generation=useRef(0),disabledRef=useRef(disabled);disabledRef.current=disabled;
 const invalidateRef=useRef<(reason:string)=>void>(()=>{}),verifyRef=useRef<()=>Promise<void>>(async()=>{});
 invalidateRef.current=reason=>{
  generation.current++;
  if(flight.current)setError(reason);
  setResult(old=>old&&old.key===keyRef.current?{...old,fresh:false,reason}:old);
 };
 async function verify():Promise<void>{
  const previous=resultRef.current;
  if(!alive.current||flight.current||disabledRef.current||!previous||previous.key!==keyRef.current||previous.data.status!=='ready')return;
  flight.current=true;const g=++generation.current;setBusy('check');setError('');
  try{
   const check=readMusicPreviewCheck(await window.music.checkMusicPreview({query:previous.data.query,snapshot:previous.data.snapshot}));
   if(JSON.stringify(check.query)!==JSON.stringify(previous.data.query)||check.status==='current'&&check.snapshot!==previous.data.snapshot)throw new Error('预览核对回执与原请求不一致');
   if(!alive.current||g!==generation.current||previous.key!==keyRef.current)return;
   setResult({...previous,data:{...previous.data,asOfMs:check.asOfMs,dependencies:check.dependencies},fresh:check.status==='current',reason:check.status==='current'?'':'曲库、统计或时间范围已变化，请重新预览。'});
  }catch(e){if(alive.current&&g===generation.current&&previous.key===keyRef.current){setResult({...previous,fresh:false,reason:'预览状态暂时无法核对，请重新预览。'});setError(String(e instanceof Error?e.message:e).slice(0,512));}}
  finally{flight.current=false;if(alive.current)setBusy('');}
 }
 verifyRef.current=verify;
 useEffect(()=>{
  alive.current=true;
  const unsubscribe=window.music.onEvent(event=>{
   if(event.event==='libraryChanged'||event.event==='searchIndexChanged'){invalidateRef.current('曲库或检索索引已变化，请重新预览。');return;}
   if(event.event!=='playbackStatisticsChanged')return;
   const current=queryRef.current;if(!current)return;
   const known=resultRef.current?.key===keyRef.current?resultRef.current.data.dependencies:null;
   const dependency=known??musicFilterDependencies(current.filters),changed=event.payload as {counts?:boolean;recency?:boolean};
   if(dependency.counts&&changed.counts===true||dependency.recency&&changed.recency===true||!known&&current.view==='playlists')invalidateRef.current('播放统计已变化，请重新预览。');
  });
  const check=()=>{if(document.visibilityState==='visible')void verifyRef.current();};
  window.addEventListener('focus',check);document.addEventListener('visibilitychange',check);
  return()=>{alive.current=false;generation.current++;unsubscribe();window.removeEventListener('focus',check);document.removeEventListener('visibilitychange',check);};
 },[]);
 useEffect(()=>{generation.current++;setResult(null);setError('');},[key]);
 useEffect(()=>{
  const current=resultRef.current;if(!current||current.key!==key||!current.fresh||!current.data.dependencies.relative)return;
  const anchor=current.data.asOfMs;
  const delay=()=>Math.max(25,Math.min(MUSIC_FILTER_MINUTE_MS+25,anchor+MUSIC_FILTER_MINUTE_MS-Date.now()+25));
  let timer:ReturnType<typeof setTimeout>;
  const tick=()=>{if(musicFilterTimeAnchor()!==anchor)invalidateRef.current('相对日期范围已更新，请重新预览。');else timer=setTimeout(tick,delay());};
  timer=setTimeout(tick,delay());
  return()=>clearTimeout(timer);
 },[key,result?.fresh,result?.data.snapshot,result?.data.asOfMs]);
 async function preview():Promise<void>{
  if(flight.current||!query||queryError||disabled)return;
  const captured=query,capturedKey=key,g=++generation.current;flight.current=true;setBusy('preview');setResult(null);setError('');
  try{
   const value=readMusicPreviewResponse(await window.music.previewMusicQuery({query:captured}));
   if(JSON.stringify(value.query)!==JSON.stringify(captured))throw new Error('预览结果与筛选条件不一致');
   if(!alive.current||g!==generation.current||capturedKey!==keyRef.current)return;
   if(value.status==='stale'){setResult({key:capturedKey,data:value,fresh:false,reason:'读取过程中范围已变化，请重新预览。'});return;}
   // A queued service update can arrive after COUNT and before the UI receives it.
   const check=readMusicPreviewCheck(await window.music.checkMusicPreview({query:captured,snapshot:value.snapshot}));
   if(JSON.stringify(check.query)!==JSON.stringify(captured)||check.status==='current'&&check.snapshot!==value.snapshot)throw new Error('预览核对回执与条件不一致');
   if(!alive.current||g!==generation.current||capturedKey!==keyRef.current)return;
   setResult({key:capturedKey,data:{...value,asOfMs:check.asOfMs,dependencies:check.dependencies},fresh:check.status==='current',reason:check.status==='current'?'':'预览到达前范围已变化，请重新预览。'});
  }catch(e){if(alive.current&&g===generation.current&&capturedKey===keyRef.current)setError(String(e instanceof Error?e.message:e).slice(0,512));}
  finally{flight.current=false;if(alive.current)setBusy('');}
 }
 const visible=result?.key===key?result:null,current=visible?.fresh&&visible.data.status==='ready'&&busy==='';
 const noPlaylist=query?.view==='playlists'&&!query.value;
 return <section className="music-query-preview" aria-label="筛选结果预览">
  <div className="music-preview-heading"><strong>结果预览</strong><button type="button" disabled={!!busy||disabled||!query||!!queryError||noPlaylist} onClick={()=>void preview()}>{busy==='preview'?'正在预览…':busy==='check'?'正在核对…':visible?'重新预览':'预览匹配结果'}</button></div>
  <p>范围：{scopeLabel}。展示匹配数量及当前排序的前 {MUSIC_PREVIEW_SIZE} 首；应用条件或保存规则后内容仍会随曲库变化。</p>
  {queryError&&<p className="collection-error" role="alert">请先检查筛选条件：{queryError}</p>}{noPlaylist&&<p>请先选择一个歌单范围。</p>}{error&&<p className="collection-error" role="alert">{error}</p>}
  {busy&&<p role="status">{busy==='preview'?'正在读取并核对匹配结果…':'正在核对预览快照…'}</p>}
  {visible&&!visible.fresh&&<p className="music-preview-stale" role="status">{visible.reason}</p>}
  {current&&visible&&<><p className="music-preview-count" role="status">共 {visible.data.total} 首匹配 · 预览基准 {new Date(visible.data.asOfMs).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</p><ol className="music-preview-samples">{visible.data.items.map(item=><li key={item.entryId??item.id}><div><strong>{item.title||'未命名歌曲'}</strong><span>{item.artist||'未知艺人'} · {item.album||'未知专辑'}</span></div><small>{item.kind==='cue'?'CUE · ':''}{duration(item.durationSeconds)}{item.available?'':' · 暂不可用'}</small></li>)}</ol>{visible.data.total===0&&<p>当前范围内没有匹配歌曲，可调整条件后重新预览。</p>}</>}
 </section>;
}
