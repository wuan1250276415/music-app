import React,{useEffect,useRef,useState} from 'react';
import type {DesktopFileInbox,DesktopFileReview,DesktopFilePlay} from '../shared/desktop-files';
import {useFocus,trap} from './dialog-focus';
import './desktop-files.css';

const empty:DesktopFileInbox={revision:0,requests:[],message:''};
const sources={drop:'拖入文件',open:'外部打开',picker:'选择文件'};
const statuses={loading:'检查中',review:'待处理',submitting:'提交中',submitted:'已提交',unknown:'待核对'};
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
export function DesktopFileEntry({onTasks}:{onTasks:()=>void}):React.JSX.Element{
 const [inbox,setInbox]=useState(empty),[open,setOpen]=useState(false),[drag,setDrag]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),seen=useRef(new Set<string>()),depth=useRef(0),openRef=useRef(false);openRef.current=open;
 useEffect(()=>{
  alive.current=true;
  const receive=(value:DesktopFileInbox)=>{
   if(!alive.current)return;setInbox(previous=>value.revision>=previous.revision?value:previous);
   const fresh=value.requests.some(r=>!seen.current.has(r.id));for(const r of value.requests)seen.current.add(r.id);
   if(fresh&&!openRef.current&&!document.querySelector('[role="dialog"][aria-modal="true"]'))setOpen(true);
  };
  const stop=window.music.onEvent(event=>{if(event.event==='desktopFilesChanged')receive(event.payload as DesktopFileInbox);});
  void window.music.desktopFiles().then(receive).catch(e=>{if(alive.current)setError(message(e));});
  const files=(event:DragEvent)=>event.dataTransfer?.types.includes('Files');
  const enter=(event:DragEvent)=>{if(files(event)){event.preventDefault();depth.current++;setDrag(true);}};
  const over=(event:DragEvent)=>{if(files(event)){event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';setDrag(true);}};
  const leave=(event:DragEvent)=>{if(files(event)&&--depth.current<=0){depth.current=0;setDrag(false);}};
  const reset=()=>{depth.current=0;setDrag(false);};
  const drop=(event:DragEvent)=>{
   // Prevent Electron navigation for every external drop, including URL/text payloads.
   event.preventDefault();reset();if(!files(event)){setError('请从文件管理器拖入音乐文件或文件夹。');return;}
   const selected=Array.from(event.dataTransfer?.files??[]);setError('');
   void window.music.importDesktopFiles(selected).catch(e=>{if(alive.current)setError(message(e));});
  };
  document.addEventListener('dragenter',enter);document.addEventListener('dragover',over);document.addEventListener('dragleave',leave);document.addEventListener('drop',drop);document.addEventListener('dragend',reset);window.addEventListener('blur',reset);
  return()=>{alive.current=false;stop();document.removeEventListener('dragenter',enter);document.removeEventListener('dragover',over);document.removeEventListener('dragleave',leave);document.removeEventListener('drop',drop);document.removeEventListener('dragend',reset);window.removeEventListener('blur',reset);};
 },[]);
 function show():void{if(document.querySelector('[role="dialog"][aria-modal="true"]')){setError('请先关闭当前对话框，再查看待处理文件。');return;}setError('');setOpen(true);}
 return <>
  {drag&&<div className="desktop-file-drop" role="status"><strong>将音乐拖入 Aural</strong><span>先查看曲库匹配和导入范围，再选择播放或扫描。</span></div>}
  {!open&&(inbox.requests.length>0||inbox.message||error)&&<div className="desktop-file-notice" aria-live="polite"><button onClick={show}>待处理文件 · {inbox.requests.length}</button>{(error||inbox.message)&&<span role="alert">{error||inbox.message}</span>}{error&&<button aria-label="关闭文件提示" onClick={()=>setError('')}>×</button>}</div>}
  {open&&<DesktopFilesDialog inbox={inbox} onClose={()=>setOpen(false)} onTasks={()=>{setOpen(false);onTasks();}}/>}
 </>;
}
function DesktopFilesDialog({inbox,onClose,onTasks}:{inbox:DesktopFileInbox;onClose:()=>void;onTasks:()=>void}):React.JSX.Element{
 const [selected,setSelected]=useState(inbox.requests[0]?.id??''),[review,setReview]=useState<DesktopFileReview|null>(null),[folders,setFolders]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const element=useRef<HTMLDivElement|null>(null),alive=useRef(true),working=useRef(false),generation=useRef(0),playAttempt=useRef<DesktopFilePlay|null>(null);
 const brief=inbox.requests.find(r=>r.id===selected),blocked=busy||review?.status==='loading'||review?.status==='submitting',pending=review?.status==='unknown'||Boolean(playAttempt.current),closingBlocked=busy||review?.status==='submitting'||Boolean(playAttempt.current);useFocus(element);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
 useEffect(()=>{if(!brief&&!working.current){setSelected(inbox.requests[0]?.id??'');setReview(null);}},[inbox,selected]);
 useEffect(()=>{
  if(!selected||working.current)return;const gen=++generation.current;
  void window.music.desktopFileRequest(selected).then(value=>{if(alive.current&&gen===generation.current){setReview(value);setFolders(previous=>previous.filter(id=>value.folders.some(f=>f.id===id)));}}).catch(e=>{if(alive.current&&gen===generation.current)setError(message(e));});
 },[selected,brief?.revision,busy]);
 useEffect(()=>{if(blocked&&document.activeElement?.matches(':disabled'))element.current?.focus();},[blocked]);
 async function run(action:()=>Promise<void>):Promise<void>{
  if(working.current)return;working.current=true;generation.current++;setBusy(true);setError('');setNotice('');
  try{await action();}catch(e){if(alive.current)setError(message(e));}finally{working.current=false;if(alive.current)setBusy(false);}
 }
 async function refresh():Promise<void>{if(!review)return;const r=review;await run(async()=>{const value=await window.music.refreshDesktopFiles(r.id,r.revision);if(alive.current)setReview(value);});}
 async function submit():Promise<void>{
  if(!review)return;const r=review,ids=r.status==='unknown'?r.scans.map(s=>s.folderId):folders;
  await run(async()=>{const value=await window.music.submitDesktopFiles({id:r.id,baseRevision:r.revision,folderIds:ids});if(alive.current){setReview(value);setFolders([]);}});
 }
 async function play(itemId?:string):Promise<void>{
  if(!review)return;const r=review;
  await run(async()=>{
   if(!playAttempt.current){if(!itemId)return;const queue=await window.music.queue();playAttempt.current={id:r.id,baseRevision:r.revision,itemId,command:{commandId:crypto.randomUUID(),baseRevision:queue.revision}};}
   const result=await window.music.playDesktopFile(playAttempt.current);playAttempt.current=null;
   if(alive.current){if(result.status==='rejected')setError(result.message);else setNotice(result.state.state==='error'?result.state.message??'播放失败，请检查输出设置':'播放请求已处理。');}
  });
 }
 async function dismiss():Promise<void>{if(!review)return;const r=review;await run(async()=>{await window.music.dismissDesktopFiles(r.id,r.revision);if(alive.current){setReview(null);setSelected('');}});}
 function choose(id:string):void{if(blocked||pending)return;generation.current++;setSelected(id);setReview(null);setFolders([]);setError('');setNotice('');}
 return <div className="collection-backdrop"><div className="collection-dialog desktop-files-dialog" role="dialog" aria-modal="true" aria-label="打开与导入音乐" ref={element} tabIndex={-1} onKeyDown={event=>trap(event,element.current,onClose,Boolean(closingBlocked))}>
  <header><div><h2>打开与导入音乐</h2><p>先检查曲库匹配，再选择播放或扫描完整目录。</p></div><button disabled={Boolean(closingBlocked)} aria-label="关闭文件窗口" onClick={onClose}>×</button></header>
  {error&&<p className="desktop-file-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}{inbox.message&&<p role="status">{inbox.message}</p>}
  <nav aria-label="文件请求">{inbox.requests.map(r=><button key={r.id} disabled={Boolean(blocked||pending)} aria-pressed={r.id===selected} onClick={()=>choose(r.id)}>{sources[r.source]} · {r.count} 项 · {statuses[r.status]}</button>)}</nav>
  <div className="desktop-files-body">
   {!review&&<p>{selected?'正在读取文件请求…':'没有待处理文件。可选择文件，或从文件管理器拖入音乐。'}</p>}
   {review&&<>
    <p role="status">{review.message}</p>{review.truncated&&<p>匹配曲目超过 500 首，仅展示部分结果；请在曲库中搜索其余曲目。</p>}
    <section><h3>收到的文件与目录</h3>{review.entries.map(entry=><div className="desktop-file-row" key={entry.id}><strong>{entry.path.split(/[\\/]/).filter(Boolean).pop()}</strong><small className="desktop-file-path">{entry.path}</small><p className={entry.kind==='rejected'?'desktop-file-error':''}>{entry.message}</p></div>)}</section>
    <section><h3>已匹配曲目 · {review.items.length}</h3>{!review.items.length&&<p>尚未匹配曲目；扫描结束后，请刷新匹配。</p>}{review.items.map(item=><div className="desktop-file-track" key={item.id}><div><strong>{item.title}{item.kind==='cue'?' · CUE':''}</strong><small>{item.artist} · {item.album}{item.available?'':' · 文件不可用'}</small></div><button disabled={Boolean(blocked||pending||!item.available)} onClick={()=>void play(item.id)}>播放</button></div>)}<p>播放所选曲目将替换当前播放列表。</p></section>
    <section><h3>可扫描的完整目录</h3><p>勾选后会扫描所列目录的全部音乐、CUE 和子目录，并将目录保留在曲库。文件保留原位置；扫描完成后请自行选择播放。</p>
     {review.folders.map(folder=><label className="desktop-file-folder" key={folder.id}><input type="checkbox" checked={folders.includes(folder.id)} disabled={Boolean(blocked||pending||review.scans.length)} onChange={event=>setFolders(previous=>event.target.checked?[...previous,folder.id]:previous.filter(id=>id!==folder.id))}/><span><strong>{folder.existingRootId?'重新扫描已有音乐目录':'添加并扫描音乐目录'}</strong><small className="desktop-file-path">{folder.path}</small></span></label>)}
     {review.scans.map(scan=><p key={scan.commandId}>{review.folders.find(f=>f.id===scan.folderId)?.path??'原扫描目录'}：{scan.message||'等待确认'}{scan.jobId?` · 任务 ${scan.jobId.slice(0,8)}`:''}</p>)}
    </section>
   </>}
   {playAttempt.current&&<p role="alert">播放操作尚未确认。请核对原播放请求后再进行其他操作。</p>}
  </div>
  <footer>
   <button disabled={Boolean(blocked||pending||!review)} onClick={()=>void refresh()}>刷新匹配</button>
   <button disabled={Boolean(blocked||playAttempt.current||!review||(review.status!=='unknown'&&(review.scans.length>0||!folders.length)))} onClick={()=>void submit()}>{review?.status==='unknown'?'核对原扫描提交':'扫描所选完整文件夹'}</button>
   {playAttempt.current&&<button disabled={Boolean(blocked)} onClick={()=>void play()}>核对原播放请求</button>}
   <button disabled={Boolean(blocked||playAttempt.current)} onClick={onTasks}>扫描任务中心</button>
   <button disabled={Boolean(blocked||pending||!review)} onClick={()=>void dismiss()}>关闭此文件请求</button>
   <button disabled={Boolean(closingBlocked)} onClick={onClose}>稍后处理</button>
  </footer>
 </div></div>;
}
