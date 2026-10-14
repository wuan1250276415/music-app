import {MetadataAlbumCreditUndoDialog} from './metadata-album-credits-dialog';
import {MetadataGroupLinkUndoDialog} from './metadata-group-link-dialog';
import React,{useEffect,useRef,useState} from 'react';
import type {ProviderId,ProviderRetention,ProviderRetentionMode,ProviderRetentionRequest,ProviderStoredChange} from '../shared/contracts';
import {trap,useFocus} from './dialog-focus';
import {MetadataIdentityUndoDialog} from './metadata-identities-dialog';
import {MetadataReleaseFieldsUndoDialog} from './metadata-release-fields-dialog';
import {MetadataUndoDialog} from './metadata-undo-dialog';

export function ProviderRetentionDialog({providerId,name,onClose}:{providerId:ProviderId;name:string;onClose:()=>void}):React.JSX.Element{
 const dialog=useRef<HTMLDivElement|null>(null),alive=useRef(true),generation=useRef(0),acting=useRef(false),attempt=useRef<ProviderRetentionRequest|null>(null);useFocus(dialog);
 const [state,setState]=useState<ProviderRetention|null>(null),[draft,setDraft]=useState<ProviderRetentionMode>('preview-only'),[confirmed,setConfirmed]=useState(false),[changes,setChanges]=useState<ProviderStoredChange[]>([]),[cursor,setCursor]=useState<string|null>(null),[reload,setReload]=useState(0),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[paging,setPaging]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[undo,setUndo]=useState<{id:string;kind?:'item'|'release'|'identity'|'group-link'|'album-credit'}|null>(null);
 useEffect(()=>{alive.current=true;const unsubscribe=window.music.onEvent(event=>{if(event.event==='providersChanged'||event.event==='libraryChanged')setReload(value=>value+1);});return()=>{alive.current=false;generation.current++;unsubscribe();};},[]);
 useEffect(()=>{
  const epoch=++generation.current;setLoading(true);setConfirmed(false);
  void Promise.all([window.music.providerRetention(providerId),window.music.providerStoredChanges(providerId)]).then(([value,page])=>{if(alive.current&&generation.current===epoch){setState(value);setDraft(value.mode);setChanges(page.items);setCursor(page.nextCursor);setLoading(false);}}).catch(e=>{if(alive.current&&generation.current===epoch){setError(e instanceof Error?e.message:String(e));setLoading(false);}});
 },[providerId,reload]);
 async function save(retry=false):Promise<void>{
  if(!state||acting.current||!retry&&(!confirmed||draft===state.mode))return;
  const request=retry?attempt.current:{commandId:crypto.randomUUID(),providerId,revision:state.revision,mode:draft};if(!request)return;
  attempt.current=request;acting.current=true;setBusy(true);setError('');setNotice('');
  try{await window.music.configureProviderRetention(request);if(alive.current){attempt.current=null;setNotice('后续在线保存设置已更新，已有值保留。');setReload(value=>value+1);}}
  catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}
  finally{acting.current=false;if(alive.current)setBusy(false);}
 }
 async function more():Promise<void>{
  if(!cursor||paging)return;const epoch=generation.current,position=cursor;setPaging(true);
  try{const page=await window.music.providerStoredChanges(providerId,position);if(alive.current&&generation.current===epoch){setChanges(values=>{const seen=new Set(values.map(value=>value.id));return [...values,...page.items.filter(value=>!seen.has(value.id))];});setCursor(page.nextCursor);}}
  catch(e){if(alive.current&&generation.current===epoch)setError(String(e));}finally{if(alive.current)setPaging(false);}
 }
 async function clearPreviews():Promise<void>{
  if(acting.current)return;acting.current=true;setBusy(true);setError('');
  try{await window.music.clearMetadataNetworkCache();if(alive.current)setNotice('候选预览已清除，已保存的曲库信息保留。');}catch(e){if(alive.current)setError(String(e));}finally{acting.current=false;if(alive.current)setBusy(false);}
 }
 return <><div className="collection-backdrop provider-retention-backdrop"><div className="collection-dialog catalog-dialog provider-dialog" ref={dialog} inert={Boolean(undo)} aria-hidden={Boolean(undo)} role="dialog" aria-modal={!undo} aria-label={`${name} 来源保存与撤销`} onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
  <header><h2>{name} · 来源保存与撤销</h2><button aria-label="关闭来源保存设置" disabled={busy} onClick={onClose}>×</button></header>
  <p className="collection-note">查询启停、清除候选和撤销已保存的修改是不同操作。下方设置控制后续在线保存，不自动删除已经确认的内容，也不修改音乐文件。</p>
  {state&&<><p className="collection-note">{state.retention}</p><div className="provider-retention-options">
   <label><input type="radio" name="provider-retention-mode" checked={draft==='reviewed'} disabled={busy||loading||!['musicbrainz','cover-art-archive'].includes(providerId)} onChange={()=>{setDraft('reviewed');setConfirmed(false);attempt.current=null;}}/>{providerId==='cover-art-archive'?'允许保存明确选定的本机封面':'允许保存明确审核后的在线修改'}</label>
   <label><input type="radio" name="provider-retention-mode" checked={draft==='preview-only'} disabled={busy||loading} onChange={()=>{setDraft('preview-only');setConfirmed(false);attempt.current=null;}}/>只查看候选，暂停新的在线保存</label>
   <label><input type="checkbox" checked={confirmed} disabled={busy||loading||draft===state.mode} onChange={event=>setConfirmed(event.target.checked)}/>已确认仅调整后续保存，既有数据保留</label>
   <div className="provider-actions"><button disabled={busy||loading||!confirmed||draft===state.mode} onClick={()=>void save()}>保存设置</button>{attempt.current&&<button disabled={busy} onClick={()=>void save(true)}>核对上次设置操作</button>}<button disabled={busy||providerId!=='musicbrainz'} onClick={()=>void clearPreviews()}>清除候选预览</button><button disabled={busy||loading} onClick={()=>{setError('');setReload(value=>value+1);}}>刷新记录</button></div>
  </div><p className="collection-note">歌曲信息修改 {state.scalarChanges} 次（{state.pendingScalarChanges} 次尚未全部撤销），发行资料修改 {state.releaseChanges} 次（{state.pendingReleaseChanges} 次尚未全部撤销），身份确认 {state.identityChanges} 次（{state.pendingIdentityChanges} 次未撤销），概念关联 {state.groupLinkChanges??0} 次（{state.pendingGroupLinkChanges??0} 次未撤销），署名修改 {state.collectionChanges} 次；已记录来源值 {state.scalarObservations+state.collectionObservations} 条。</p></>}
  {error&&<p className="collection-error" role="alert">{error}</p>}{notice&&<p className="collection-note" role="status">{notice}</p>}
  <p className="collection-note">下方可预览撤销歌曲名称、歌手、专辑及发行资料的在线修改，并撤销录音／发行身份确认。后续编辑、字段锁或独立署名造成的冲突会保留当前值；源观察和审计仍保留。这不等于彻底删除来源数据。署名与其他实体的完整来源清除仍在开发。</p>
  <div className="provider-cards" aria-busy={loading}>{changes.map(change=><section className="provider-card" key={change.id}><strong>{change.title}</strong><p>{new Date(change.createdAt).toLocaleString()} · {change.undone?'已全部撤销':'可查看字段预览'}</p><div className="provider-actions"><button disabled={busy||loading||change.undone} onClick={()=>setUndo({id:change.id,kind:change.kind})}>查看逐字段撤销预览</button></div></section>)}{loading&&<p>正在读取来源记录…</p>}{!loading&&!changes.length&&<p>没有此数据源的歌曲或发行资料修订。</p>}{cursor&&<button className="release-refresh" disabled={busy||loading||paging} onClick={()=>void more()}>{paging?'正在读取…':'更早的修订'}</button>}</div>
  <footer><button disabled={busy} onClick={onClose}>返回数据源设置</button></footer>
 </div></div>{undo&&(undo.kind==='album-credit'?<MetadataAlbumCreditUndoDialog changeId={undo.id} onClose={()=>setUndo(null)} onDone={()=>setReload(v=>v+1)}/>:undo.kind==='group-link'?<MetadataGroupLinkUndoDialog changeId={undo.id} onClose={()=>setUndo(null)} onDone={()=>setReload(value=>value+1)}/>:undo.kind==='identity'?<MetadataIdentityUndoDialog changeId={undo.id} onClose={()=>setUndo(null)} onDone={()=>setReload(value=>value+1)}/>:undo.kind==='release'?<MetadataReleaseFieldsUndoDialog changeId={undo.id} onClose={()=>setUndo(null)} onDone={()=>setReload(value=>value+1)}/>:<MetadataUndoDialog changeId={undo.id} onClose={()=>setUndo(null)} onDone={()=>setReload(value=>value+1)}/>)}</>;
}
