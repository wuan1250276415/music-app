import React,{useEffect,useRef,useState} from 'react';
import type {MetadataCandidate} from '../shared/contracts';
import type {MetadataEditionsPage} from '../shared/metadata-editions';
export function MetadataEditionsPanel({itemId,fingerprint,candidate,networkEnabled,onSelect}:{itemId:string;fingerprint:string;candidate:MetadataCandidate;networkEnabled:boolean;onSelect:(candidate:MetadataCandidate)=>void}):React.JSX.Element{
 const [page,setPage]=useState<MetadataEditionsPage|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[history,setHistory]=useState<Array<string|undefined>>([]),[cursor,setCursor]=useState<string|undefined>();
 const alive=useRef(false),generation=useRef(0),pending=useRef<string|null>(null);
 const expired=Boolean(candidate.expiresAt&&Date.parse(candidate.expiresAt)<=Date.now());
 function cancel():void{generation.current++;const id=pending.current;pending.current=null;if(id)void window.music.cancelMetadataMatch(id).catch(()=>{});if(alive.current)setBusy(false);}
 useEffect(()=>{alive.current=true;setPage(null);setHistory([]);setCursor(undefined);setError('');return()=>{alive.current=false;cancel();};},[itemId,fingerprint,candidate.recordingId]);
 useEffect(()=>{if(!networkEnabled){cancel();setPage(null);setHistory([]);setCursor(undefined);}},[networkEnabled]);
 async function load(next?:string,direction:'first'|'next'|'previous'='first'):Promise<void>{
  if(pending.current||!networkEnabled||expired)return;const requestId=crypto.randomUUID(),epoch=++generation.current;pending.current=requestId;setBusy(true);setError('');
  try{const value=await window.music.metadataEditions({itemId,token:candidate.token,fingerprint,requestId,...(next?{cursor:next}:{}),fresh:false});
   if(!alive.current||generation.current!==epoch||pending.current!==requestId)return;
   if(value.itemId!==itemId||value.fingerprint!==fingerprint||value.token!==candidate.token||value.requestId!==requestId||value.recordingId!==candidate.recordingId||!Array.isArray(value.candidates)||value.candidates.length>25||value.candidates.some(v=>v.recordingId!==candidate.recordingId||!v.releaseId)||!Number.isSafeInteger(value.offset)||!Number.isSafeInteger(value.total)||value.offset<0||value.total<0||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.now())throw new Error('发行版回执不属于当前录音或已过期');
   setPage(value);setCursor(next);setHistory(previous=>direction==='next'?[...previous,cursor].slice(-128):direction==='previous'?previous.slice(0,-1):[]);
  }catch(e){if(alive.current&&generation.current===epoch)setError(e instanceof Error?e.message:String(e));}
  finally{if(alive.current&&generation.current===epoch){pending.current=null;setBusy(false);}}
 }
 return <section className="metadata-editions-panel" aria-label="录音发行版"><button className="metadata-link" disabled={busy||!networkEnabled||expired} onClick={()=>void load()}>查看其他发行版</button>
  {busy&&<p className="metadata-note" role="status">正在读取发行版…</p>}{error&&<p className="collection-error" role="alert">{error}</p>}
  {page&&<><p className="metadata-note" role="status">{page.candidates.length?`发行版 ${page.offset+1}–${page.offset+page.candidates.length} / ${page.total}`:'该录音暂无发行版'}{page.cacheHit?' · 短期缓存':''}</p><p className="metadata-note">选择实际发行版；相同录音可能出现在不同地区、介质和再版中。</p>
   <ul className="cover-art-source-entries">{page.candidates.map(value=><li className="edition-card" key={value.token}><strong>{value.album}</strong><small>{[value.date,value.edition?.country,value.edition?.format,value.edition?.disambiguation,value.edition?.status].filter(Boolean).join(' · ')}</small>{value.edition?.barcode&&<small>条码 {value.edition.barcode}</small>}<button className="metadata-link" disabled={busy||!networkEnabled||expired||Date.parse(value.expiresAt??'')<=Date.now()} onClick={()=>onSelect(value)}>选择此发行版</button></li>)}</ul>
   <div className="cover-art-source-actions"><button className="metadata-link" disabled={busy||!history.length||!networkEnabled||expired} onClick={()=>void load(history.at(-1),'previous')}>上一页发行版</button><button className="metadata-link" disabled={busy||!page.nextCursor||!networkEnabled||expired} onClick={()=>void load(page.nextCursor!,'next')}>下一页发行版</button></div>
  </>}
 </section>;
}
