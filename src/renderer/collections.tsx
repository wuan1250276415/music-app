import React, { useEffect, useRef, useState } from 'react';
import type { LibraryItem, PlaylistSummary } from '../shared/contracts';

export type PlaylistDialogState = {kind:'create'|'add'|'rename'|'delete';item?:LibraryItem;playlist?:PlaylistSummary};
export function PlaylistDialog({state,playlists,onClose,onDone}:{state:PlaylistDialogState;playlists:PlaylistSummary[];onClose:()=>void;onDone:(playlist:PlaylistSummary|null,message:string)=>void}):React.JSX.Element {
  const [name,setName]=useState(state.playlist?.name??'');
  const [targetId,setTargetId]=useState(playlists[0]?.id??'');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const dialog=useRef<HTMLDivElement|null>(null);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    dialog.current?.querySelector<HTMLElement>('input,select,button')?.focus();
    return ()=>previous?.focus();
  },[]);
  async function run(action:()=>Promise<PlaylistSummary|null>,message:string):Promise<void>{
    setError('');setBusy(true);
    try{onDone(await action(),message);}catch(e){setError(e instanceof Error?e.message:String(e));setBusy(false);}
  }
  const title=state.kind==='create'?'创建歌单':state.kind==='add'?'加入歌单':state.kind==='rename'?'重命名歌单':'删除歌单';
  async function create():Promise<PlaylistSummary>{
    return window.music.createPlaylist(name,crypto.randomUUID(),state.item?[state.item.id]:[]);
  }
  return <div className="collection-backdrop"><div className="collection-dialog" ref={dialog} role="dialog" aria-modal="true" aria-label={title} onKeyDown={event=>{
    if(event.key==='Escape'){event.stopPropagation();if(!busy)onClose();}
    if(event.key==='Tab'){
      const controls=[...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')??[])];
      const first=controls[0],last=controls[controls.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  }}><header><h2>{title}</h2><button aria-label="关闭歌单编辑" disabled={busy} onClick={onClose}>×</button></header>
    {error&&<p className="collection-error" role="alert">{error}</p>}
    {state.item&&<p className="collection-note">{state.item.title} · {state.item.artist}<br/>同一歌曲可以重复加入，每次拥有独立条目。</p>}
    {state.kind==='add'&&playlists.length>0&&<div className="collection-existing"><label>选择歌单<select aria-label="目标歌单" value={targetId} disabled={busy} onChange={event=>setTargetId(event.target.value)}>{playlists.map(playlist=><option key={playlist.id} value={playlist.id}>{playlist.name} · {playlist.count} 首</option>)}</select></label><button className="primary-button" disabled={busy||!targetId} onClick={()=>{
      const target=playlists.find(playlist=>playlist.id===targetId);
      if(target&&state.item)void run(()=>window.music.editPlaylist({action:'add',playlistId:target.id,itemIds:[state.item!.id],baseRevision:target.revision,commandId:crypto.randomUUID()}),'已加入歌单');
    }}>加入所选歌单</button></div>}
    {state.kind==='delete'?<><p className="collection-note">删除“{state.playlist?.name}”及其歌单条目，音乐文件和收藏会继续保留。</p><button className="collection-danger" disabled={busy} onClick={()=>void run(()=>window.music.editPlaylist({action:'delete',playlistId:state.playlist!.id,baseRevision:state.playlist!.revision,commandId:crypto.randomUUID()}),'歌单已删除')}>确认删除歌单</button></>:
    <form onSubmit={event=>{event.preventDefault();void run(state.kind==='rename'?()=>window.music.editPlaylist({action:'rename',playlistId:state.playlist!.id,name,baseRevision:state.playlist!.revision,commandId:crypto.randomUUID()}):create,state.kind==='rename'?'歌单已重命名':state.item?'已创建歌单并添加歌曲':'歌单已创建');}}>
      <label>{state.kind==='add'?'或创建新歌单':'歌单名称'}<input aria-label="歌单名称" maxLength={120} value={name} disabled={busy} onChange={event=>setName(event.target.value)} placeholder="给这一组音乐起个名字"/></label>
      <button className="primary-button" disabled={busy||!name.trim()} type="submit">{busy?'正在保存…':state.kind==='rename'?'保存名称':state.item?'创建并添加':'创建歌单'}</button>
    </form>}
  </div></div>;
}
