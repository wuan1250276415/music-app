import React,{useEffect,useRef,useState} from 'react';
import {readLibraryWatchState,WATCH_PERIODS,type LibraryWatchState,type LibraryWatchRequest,type LibraryWatchRoot} from '../shared/library-watch';
import {useFocus,trap} from './dialog-focus';
import './scan-tasks.css';

const labels={disabled:'已关闭',starting:'准备中',watching:'监听中',pending:'等待核对',scanning:'扫描中',waiting:'等待已有任务',offline:'目录或监听不可用',error:'监听降级',paused:'已暂停',capacity:'超过同时监听数量'};
export function LibraryWatchDialog({onClose,onTasks}:{onClose:()=>void;onTasks:()=>void}):React.JSX.Element{
 const [state,setState]=useState<LibraryWatchState|null>(null),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[periods,setPeriods]=useState<Record<string,number>>({});
 const dialog=useRef<HTMLDivElement|null>(null),alive=useRef(false),flight=useRef(false),attempt=useRef<LibraryWatchRequest|null>(null),queued=useRef<LibraryWatchRequest|null>(null),latest=useRef<LibraryWatchState|null>(null);
 useFocus(dialog);const disabled=busy||pending;
 function accept(value:unknown):void{const next=readLibraryWatchState(value),old=latest.current;if(old?.session===next.session&&next.revision<old.revision)return;latest.current=next;setState(next);}
 async function read(manual=false):Promise<void>{if(flight.current)return;flight.current=true;const foreground=manual||!latest.current;if(foreground)setBusy(true);try{const value=await window.music.libraryWatchState();if(alive.current){accept(value);if(!attempt.current)setError('');}}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}finally{flight.current=false;if(alive.current){if(foreground)setBusy(false);const next=queued.current;queued.current=null;if(next)void submit(next);}}}
 useEffect(()=>{alive.current=true;void read();const timer=setInterval(()=>void read(),3000);const stop=window.music.onEvent(event=>{if(event.event==='libraryWatchChanged'&&!flight.current)void read();});return()=>{alive.current=false;clearInterval(timer);stop();};},[]);
 async function submit(request?:LibraryWatchRequest):Promise<void>{
  const intent=request??attempt.current;if(!intent)return;if(flight.current){if(request&&!attempt.current&&!queued.current){queued.current=request;setBusy(true);}return;}flight.current=true;attempt.current=intent;setBusy(true);setPending(true);setError('');
  try{const result=await window.music.libraryWatchCommand(intent);if(!alive.current)return;accept(result.state);attempt.current=null;setPending(false);if(result.status==='rejected')setError(result.error);else setPeriods(old=>{const next={...old};delete next[intent.rootId];return next;});}
  catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}
  finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 function action(root:LibraryWatchRoot,action:LibraryWatchRequest['action']):void{if(disabled)return;void submit({commandId:crypto.randomUUID(),rootId:root.rootId,revision:root.revision,action,periodicMinutes:periods[root.rootId]??root.periodicMinutes});}
 return <div className="collection-backdrop"><div className="collection-dialog scan-tasks-dialog library-watch-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="音乐目录自动更新" onKeyDown={event=>trap(event,dialog.current,onClose,disabled)}>
  <header><div><h2>音乐目录自动更新</h2><p>目录变化合并后核对音乐、CUE、封面与歌词。周期对账补查遗漏；取消扫描会暂停该目录的自动更新。</p></div><button disabled={disabled} aria-label="关闭自动更新设置" onClick={onClose}>×</button></header>
  {error&&<p className="scan-task-error" role="alert">{error}</p>}{state?.error&&<p className="scan-task-error" role="alert">{state.error}</p>}{pending&&<p role="status">操作结果尚未确认，请核对原操作后再更改设置。</p>}
  <div className="scan-task-body">{!state?<p>正在读取自动更新状态…</p>:!state.roots.length?<p>添加音乐目录后可在这里管理自动更新。</p>:state.roots.map(root=><section className="library-watch-root" key={root.rootId}>
   <h3>{root.path.split(/[\\/]/).filter(Boolean).pop()} · {labels[root.status]}</h3><p className="scan-task-path">{root.path}</p><p role="status">{root.message}{root.pending?' · 有待核对的变化':''}</p><small>最近完整核对：{root.lastSuccessAt?new Date(root.lastSuccessAt).toLocaleString():'尚未完成自动核对'}</small>
   <label>周期对账<select aria-label={`周期对账 ${root.path}`} disabled={disabled} value={periods[root.rootId]??root.periodicMinutes} onChange={event=>setPeriods(old=>({...old,[root.rootId]:Number(event.target.value)}))}>{WATCH_PERIODS.map(minutes=><option key={minutes} value={minutes}>{minutes?`每 ${minutes} 分钟`:'关闭周期对账'}</option>)}</select></label>
   <div className="scan-task-actions"><button disabled={disabled} onClick={()=>action(root,'enable')}>{root.enabled?'保存并启动自动更新':'开启自动更新'}</button><button disabled={disabled||!root.enabled} onClick={()=>action(root,'disable')}>关闭自动更新</button><button disabled={disabled} onClick={()=>action(root,'retry')}>恢复并核对</button><button disabled={disabled} onClick={()=>action(root,'confirm')}>重新确认目录</button></div>
  </section>)}</div>
  <p className="library-watch-note">同时监听最多 {state?.capacity??64} 个目录。监听失效时周期对账仍可工作；关闭周期对账后，漏掉的变化需手动扫描。关闭自动更新不取消已有扫描。</p>
  <footer><button disabled={busy} onClick={()=>void read(true)}>重新读取状态</button>{pending&&<button disabled={busy} onClick={()=>void submit()}>核对上次操作</button>}<button disabled={disabled} onClick={onTasks}>查看扫描任务</button><button disabled={disabled} onClick={onClose}>关闭</button></footer>
 </div></div>;
}
