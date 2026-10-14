import React,{useEffect,useRef,useState} from 'react';
import './metadata.css';
import type {CoverArtImagePreview} from '../shared/contracts';
import type {OnlineArtworkCommand,OnlineArtworkMode,OnlineArtworkState} from '../shared/online-artwork';

export function OnlineArtworkControls({itemId,preview,onSaved}:{itemId:string;preview?:CoverArtImagePreview|null;onSaved?:()=>void}):React.JSX.Element{
 const alive=useRef(false),identity=useRef(itemId);identity.current=itemId;
 const [state,setState]=useState<OnlineArtworkState|null>(null),[allowed,setAllowed]=useState(false),[mode,setMode]=useState<OnlineArtworkMode>('fallback'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[attempt,setAttempt]=useState<OnlineArtworkCommand|null>(null);
 const refreshRef=useRef<()=>void>(()=>{});
 useEffect(()=>{
  alive.current=true;setState(null);setAttempt(null);setError('');let generation=0;
  const refresh=()=>{const epoch=++generation;void Promise.all([window.music.onlineArtwork(itemId),window.music.providerRetention('cover-art-archive')]).then(([value,retention])=>{if(alive.current&&identity.current===itemId&&generation===epoch){setState(previous=>previous?.itemId===itemId&&previous.revision>value.revision?previous:value);setAllowed(retention.mode==='reviewed');}}).catch(e=>{if(alive.current&&identity.current===itemId&&generation===epoch)setError(e instanceof Error?e.message:String(e));});};
  refreshRef.current=refresh;refresh();const unsubscribe=window.music.onEvent(event=>{if(['libraryChanged','providersChanged'].includes(event.event))refresh();});
  return()=>{alive.current=false;generation++;unsubscribe();};
 },[itemId]);
 useEffect(()=>setMode('fallback'),[preview?.url]);
 async function perform(request:OnlineArtworkCommand):Promise<void>{
  if(busy)return;setBusy(true);setError('');setNotice('');setAttempt(request);
  try{const result=await window.music.onlineArtworkCommand(request);
   if(alive.current&&identity.current===request.itemId){setState(previous=>previous&&previous.revision>result.state.revision?previous:result.state);setAttempt(null);setNotice(result.replayed?'已核对此前保存的封面操作。':request.action==='apply'?'封面已保存到本机曲库。':request.action==='clear'?'已恢复本地封面的选择顺序。':request.action==='mode'?'已更新已保存封面的使用顺序。':'已撤销该次封面修改。');if(request.action==='apply')onSaved?.();}
  }catch(e){if(alive.current&&identity.current===request.itemId)setError(e instanceof Error?e.message:String(e));}
  finally{if(alive.current&&identity.current===request.itemId)setBusy(false);}
 }
 const command=(action:'clear'|'undo',changeId?:string)=>{if(!state)return;const base={commandId:crypto.randomUUID(),itemId,baseRevision:state.revision};void perform(action==='undo'?{...base,action,changeId:changeId!}:{...base,action});};
 return <section className="online-artwork-controls" aria-label="已保存在线封面">
  <h3>曲库封面</h3>
  {state?<p className="metadata-note">{state.source?`${state.mode==='preferred'?'首选在线封面':'内嵌和同目录封面优先，在线封面补缺'} · 图片 ${state.source.imageId}`:'内嵌和同目录封面优先，尚未保存在线封面'}</p>:<p className="metadata-note">正在读取封面选择…</p>}
  {preview&&<><div className="cover-art-source-actions"><label><input type="radio" name={`cover-mode-${itemId}`} checked={mode==='fallback'} disabled={busy} onChange={()=>setMode('fallback')}/>本地封面缺失时使用</label><label><input type="radio" name={`cover-mode-${itemId}`} checked={mode==='preferred'} disabled={busy} onChange={()=>setMode('preferred')}/>使用这张图片作为首选</label></div>
   {!allowed&&<p className="metadata-note">请在数据源的“来源保存与撤销”中允许保存明确选定的本机封面。</p>}
   <button className="metadata-primary" disabled={busy||!allowed||!state||Boolean(attempt)} onClick={()=>state&&void perform({action:'apply',commandId:crypto.randomUUID(),itemId,baseRevision:state.revision,previewUrl:preview.url,mode})}>确认保存这张封面</button>
  </>}
  {(preview||state?.source)&&<p className="metadata-note">保存在本机曲库，不修改音乐文件。图片授权状态未核实，未开放图片导出。</p>}
  {state?.source&&<div className="cover-art-source-actions"><button className="metadata-link" disabled={busy} onClick={()=>void window.music.openMetadataSource(state.source!.sourceUrl).catch(e=>setError(String(e)))}>查看已保存图片来源</button><button className="metadata-link" disabled={busy||Boolean(attempt)} onClick={()=>void perform({action:'mode',commandId:crypto.randomUUID(),itemId,baseRevision:state.revision,mode:state.mode==='fallback'?'preferred':'fallback'})}>{state.mode==='fallback'?'将已保存图片设为首选':'仅在本地封面缺失时使用'}</button><button className="metadata-link" disabled={busy||Boolean(attempt)} onClick={()=>command('clear')}>恢复本地封面优先</button></div>}
  {state&&state.changes.length>0&&<details><summary>封面修改记录</summary><ul className="cover-art-source-entries">{state.changes.map(change=><li key={change.id}><span>{new Date(change.createdAt).toLocaleString()} · {change.action==='apply'?'保存封面':change.action==='clear'?'恢复本地选择':change.action==='mode'?'调整封面顺序':'撤销封面修改'}</span>{change.canUndo&&<button className="metadata-link" disabled={busy||Boolean(attempt)} onClick={()=>command('undo',change.id)}>撤销这次封面修改</button>}</li>)}</ul></details>}
  {error&&<p className="collection-error" role="alert">{error}</p>}{notice&&<p className="metadata-note" role="status">{notice}</p>}
  {attempt&&<button className="metadata-link" disabled={busy} onClick={()=>void perform(attempt)}>核对上次封面操作</button>}
  <button className="metadata-link" disabled={busy} onClick={()=>{setAttempt(null);setError('');refreshRef.current();}}>刷新封面状态</button>
 </section>;
}
