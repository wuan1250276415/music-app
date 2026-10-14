import React,{useEffect,useRef,useState} from 'react';
import {readSearchIndexState,type SearchIndexState} from '../shared/search-index';
import './search-index-notice.css';
export function SearchIndexNotice():React.JSX.Element|null{
 const [state,setState]=useState<SearchIndexState|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const alive=useRef(true),flight=useRef(false),confirmed=useRef<SearchIndexState|null>(null);
 const adopt=(value:unknown)=>{const current=readSearchIndexState(value),old=confirmed.current;if(old&&old.algorithm===current.algorithm&&old.revision>current.revision)return;confirmed.current=current;if(alive.current){setState(current);setError('');}};
 async function read(retry=false):Promise<void>{
  if(flight.current)return;flight.current=true;if(alive.current)setBusy(true);
  try{adopt(await (retry?window.music.retrySearchIndex():window.music.searchIndexState()));}
  catch(e){if(alive.current)setError(String(e instanceof Error?e.message:e).slice(0,256));}
  finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 useEffect(()=>{alive.current=true;void read();const unbind=window.music.onEvent(event=>{if(event.event==='searchIndexChanged'||event.event==='libraryChanged')void read();});const timer=setInterval(()=>{if(!confirmed.current||confirmed.current.status==='building')void read();},2000);return()=>{alive.current=false;unbind();clearInterval(timer);};},[]);
 if(!error&&state?.status==='ready')return null;
 return <aside className="search-index-notice" role={error||state?.status==='error'?'alert':'status'} aria-label="检索准备状态"><span>{error?`检索状态未能读取：${error}`:!state?'正在读取检索准备状态…':state.status==='error'?`检索与排序准备已暂停：${state.message}`:`正在准备拼音、首字母、英文错拼检索及排序，已检查 ${state.processed.toLocaleString()} 个条目。`}</span><small>歌曲原文检索仍可使用；准备完成前，拼音与英文错拼结果可能不完整，排序会在派生键补齐后稳定。</small><button disabled={busy} onClick={()=>void read()} >重新读取状态</button>{(error||state?.status==='error')&&<button disabled={busy} onClick={()=>void read(true)}>继续准备</button>}</aside>;
}
