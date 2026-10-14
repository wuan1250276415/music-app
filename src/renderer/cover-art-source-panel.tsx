import React,{useEffect,useRef,useState} from 'react';
import type {CoverArtSourceIndex,CoverArtImagePreview,MetadataCandidate} from '../shared/contracts';
import {OnlineArtworkControls} from './online-artwork-controls';

export function CoverArtSourcePanel({itemId,fingerprint,candidate,networkEnabled,onProviders}:{
 itemId:string;fingerprint:string;candidate:MetadataCandidate;networkEnabled:boolean;onProviders:()=>void;
}):React.JSX.Element{
 const request=useRef<string|null>(null),generation=useRef(0),alive=useRef(false);
 const [enabled,setEnabled]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[index,setIndex]=useState<CoverArtSourceIndex|null>(null),[error,setError]=useState(''),[now,setNow]=useState(Date.now());
 const [preview,setPreview]=useState<CoverArtImagePreview|null>(null);
 useEffect(()=>()=>{if(preview)void window.music.releaseCoverArtImagePreview(preview.url).catch(()=>{});},[preview?.url]);
 const expired=Boolean(candidate.expiresAt&&Date.parse(candidate.expiresAt)<=now);
 function cancel():void{const id=request.current;request.current=null;generation.current++;if(id)void window.music.cancelMetadataMatch(id).catch(()=>{});if(alive.current)setBusy(false);}
 useEffect(()=>{
  alive.current=true;setIndex(null);setPreview(null);setError('');let settingsGeneration=0,reviewGeneration=0;
  const refresh=()=>{const epoch=++settingsGeneration;void window.music.providerEnabled('cover-art-archive').then(value=>{if(alive.current&&settingsGeneration===epoch)setEnabled(value===true);}).catch(e=>{if(alive.current&&settingsGeneration===epoch){setEnabled(false);setError(e instanceof Error?e.message:String(e));}});};
  refresh();const unsubscribe=window.music.onEvent(event=>{
   if(event.event==='libraryChanged'&&(event.payload as {reason?:string})?.reason==='online-artwork-changed'){
    if((event.payload as {itemId?:string}).itemId===itemId){cancel();setPreview(null);}
    return;
   }
   if(event.event==='libraryChanged'){
    const review=++reviewGeneration;
    const invalidate=()=>{if(alive.current&&review===reviewGeneration){cancel();setIndex(null);setPreview(null);setError('歌曲资料已变化，请重新匹配。');}};
    void window.music.metadataReviewState(itemId).then(state=>{if(state.itemId!==itemId||state.fingerprint!==fingerprint)invalidate();}).catch(invalidate);return;
   }
   if(event.event==='providersChanged'||event.event==='metadataNetwork'&&(event.payload as {enabled:boolean}).enabled===false){cancel();setIndex(null);setPreview(null);if(event.event==='providersChanged')refresh();}
  });
  const timer=setInterval(()=>setNow(Date.now()),1000);
  return()=>{alive.current=false;settingsGeneration++;reviewGeneration++;clearInterval(timer);unsubscribe();cancel();};
 },[itemId,fingerprint,candidate.token]);
 useEffect(()=>{if(!networkEnabled||expired){cancel();setIndex(null);setPreview(null);}},[networkEnabled,expired]);
 async function query(fresh=false):Promise<void>{
  if(request.current||!enabled||!networkEnabled||expired||!candidate.releaseId)return;
  const id=crypto.randomUUID(),epoch=++generation.current;request.current=id;setBusy(true);setIndex(null);setPreview(null);setError('');
  try{const value=await window.music.coverArtSourceIndex({itemId,fingerprint,token:candidate.token,requestId:id,fresh});
   if(!alive.current||generation.current!==epoch||request.current!==id)return;
   if(value.itemId!==itemId||value.token!==candidate.token||value.fingerprint!==fingerprint||value.releaseId!==candidate.releaseId.toLowerCase())throw new Error('封面来源不属于当前候选，请重新匹配');
   setIndex(value);
  }catch(e){if(alive.current&&generation.current===epoch)setError(e instanceof Error?e.message:String(e));}
  finally{if(alive.current&&generation.current===epoch){request.current=null;setBusy(false);}}
 }
 async function viewImage(imageId:string):Promise<void>{
  if(request.current||!enabled||!networkEnabled||expired||!index||Date.parse(index.expiresAt)<=Date.now())return;
  const id=crypto.randomUUID(),epoch=++generation.current;request.current=id;setBusy(true);setPreview(null);setError('');
  try{const value=await window.music.coverArtImagePreview({itemId,fingerprint,token:candidate.token,requestId:id,imageId});
   if(!alive.current||generation.current!==epoch||request.current!==id){void window.music.releaseCoverArtImagePreview(value.url).catch(()=>{});return;}
   if(value.itemId!==itemId||value.candidateToken!==candidate.token||value.fingerprint!==fingerprint||value.releaseId!==candidate.releaseId?.toLowerCase()||value.imageId!==imageId||!/^aural-artwork:\/\/preview\/[0-9a-f]{64}\.jpg$/.test(value.url)||!/^[0-9a-f]{64}$/.test(value.token)||!Number.isSafeInteger(value.width)||value.width<1||value.width>1024||!Number.isSafeInteger(value.height)||value.height<1||value.height>1024||value.rights?.persist!==false||value.rights?.export!==false){void window.music.releaseCoverArtImagePreview(value.url).catch(()=>{});throw new Error('图片预览回执不属于当前候选或格式无效');}
   setPreview(value);
  }catch(e){if(alive.current&&generation.current===epoch)setError(e instanceof Error?e.message:String(e));}
  finally{if(alive.current&&generation.current===epoch){request.current=null;setBusy(false);}}
 }
 const visible=index&&Date.parse(index.expiresAt)>now?index:null;
 return <section className="cover-art-source-panel" aria-label="封面来源条目">
  <h3>在线封面来源</h3>
  <p className="metadata-note">查询您选定的专辑发行版，预览时发送发行与图片编号。选定图片后可确认保存到本机曲库。</p>
  {!candidate.releaseId?<p className="metadata-note">此候选没有关联发行版，请选择其他专辑候选。</p>:<>
   <p className="metadata-note">发行版：{candidate.album??candidate.releaseId}{candidate.edition&&` · ${[candidate.date,candidate.edition.country,candidate.edition.format,candidate.edition.disambiguation].filter(Boolean).join(' · ')}`}</p>
   {enabled===false&&<p className="metadata-note">请在数据源设置中启用 Cover Art Archive。</p>}
   <div className="cover-art-source-actions"><button className="metadata-link" onClick={onProviders}>数据源设置</button><button className="metadata-primary" disabled={busy||!enabled||!networkEnabled||expired} onClick={()=>void query()}>查询封面来源</button><button className="metadata-link" disabled={busy||!enabled||!networkEnabled||expired} onClick={()=>void query(true)}>重新查询来源</button>{busy&&<button className="metadata-link" onClick={cancel}>取消封面查询</button>}</div>
  </>}
  {busy&&<p className="metadata-note" role="status">正在查询封面来源…</p>}{expired&&<p className="metadata-note">候选已过期，请重新匹配。</p>}
  {error&&<p className="collection-error" role="alert">{error}</p>}
  {visible&&<><p className="metadata-note" role="status">{visible.entries.length?`找到 ${visible.entries.length} 个封面条目`:'该发行版暂无封面条目'}{visible.cacheHit?' · 短期缓存':''}</p>
   <ul className="cover-art-source-entries">{visible.entries.map(entry=><li key={entry.imageId}><strong>{entry.front?'正面封面':entry.back?'背面封面':entry.types.join('、')||'其他图片'}</strong><small>条目 {entry.imageId} · {entry.editorialApproved?'社区编辑已确认':'社区编辑待确认'}</small>{entry.comment&&<p>{entry.comment}</p>}<button className="metadata-link" disabled={busy||!enabled||!networkEnabled||expired} onClick={()=>void viewImage(entry.imageId)} aria-label={`预览图片 ${entry.imageId}`}>预览图片</button></li>)}</ul>
   {preview&&Date.parse(preview.expiresAt)>now&&<div className="cover-art-image-preview"><img src={preview.url} width={preview.width} height={preview.height} alt={`来源图片 ${preview.imageId}`} /><p className="metadata-note">来源未提供逐图片开放许可；可选择是否保留为本机曲库封面。</p><button className="metadata-link" onClick={()=>setPreview(null)}>关闭图片预览</button></div>}
   <p className="metadata-note">社区编辑确认表示来源整理状态，不代表图片使用许可。</p><button className="metadata-link" onClick={()=>void window.music.openMetadataSource(visible.sourceUrl).catch(e=>setError(e instanceof Error?e.message:String(e)))}>查看该发行版的封面来源</button>
  </>}
  <OnlineArtworkControls key={itemId} itemId={itemId} preview={preview&&Date.parse(preview.expiresAt)>now?preview:null} onSaved={()=>setPreview(null)}/>
 </section>;
}
