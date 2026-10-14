import React,{useEffect,useRef,useState} from 'react';
import type {FilePolicyView,FilePolicyPage,FilePolicyRequest} from '../shared/file-policy';
import {useFocus,trap} from './dialog-focus';
import './scan-tasks.css';
const labels={active:'曲库中',removed:'已移出曲库',ignored:'已忽略'};
export function FilePolicyDialog({fileId,onClose,onTasks}:{fileId:string|null;onClose:()=>void;onTasks:()=>void}):React.JSX.Element{
 const [page,setPage]=useState<FilePolicyPage|null>(null),[selected,setSelected]=useState<FilePolicyView|null>(null),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[stale,setStale]=useState(false);
 const dialog=useRef<HTMLDivElement|null>(null),alive=useRef(false),working=useRef(false),attempt=useRef<FilePolicyRequest|null>(null),selectedId=useRef<string|null>(fileId);
 useFocus(dialog);const disabled=busy||pending;
 async function read(cursor?:string):Promise<void>{const p=await window.music.filePolicies(cursor);if(alive.current)setPage(p);if(selectedId.current){const v=await window.music.filePolicy(selectedId.current);if(alive.current)setSelected(v);}if(alive.current)setStale(false);}
 async function reading(action:()=>Promise<void>):Promise<void>{if(working.current)return;working.current=true;setBusy(true);setError('');try{await action();}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}finally{working.current=false;if(alive.current)setBusy(false);}}
 useEffect(()=>{alive.current=true;void reading(()=>read());const stop=window.music.onEvent(event=>{if(event.event==='libraryChanged')setStale(true);});return()=>{alive.current=false;stop();};},[]);
 async function choose(id:string|null):Promise<void>{selectedId.current=id;setSelected(null);if(id){const v=await window.music.filePolicy(id);if(alive.current)setSelected(v);}}
 async function submit(action?:FilePolicyRequest['action']):Promise<void>{
  if(working.current)return;const request=action&&selected?{commandId:crypto.randomUUID(),fileId:selected.fileId,baseRevision:selected.revision,action,observation:selected.observation}:attempt.current;if(!request)return;
  attempt.current=request;working.current=true;setBusy(true);setPending(true);setError('');setNotice('');
  try{const result=await window.music.configureFilePolicy(request);if(!alive.current)return;attempt.current=null;setPending(false);if(result.view)setSelected(result.view);if(result.status==='rejected')setError(result.error);else setNotice(request.action==='restore'?'恢复已保存，将等待已有扫描结束后重新核对；成功读取前暂不可播放。':'文件管理状态已保存，原文件和个人引用保留。');await read();}
  catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 return <div className="collection-backdrop"><div className="collection-dialog scan-tasks-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="音乐文件管理" onKeyDown={event=>trap(event,dialog.current,onClose,disabled)}>
  <header><div><h2>音乐文件管理</h2><p>管理曲库收录状态，原音乐文件保留。</p></div><button disabled={disabled} onClick={onClose} aria-label="关闭文件管理">×</button></header>
  {error&&<p className="scan-task-error" role="alert">{error}</p>}{page?.error&&<p className="scan-task-error" role="alert">恢复扫描未启动：{page.error}</p>}{notice&&<p role="status">{notice}</p>}{stale&&<p role="status">曲库已变化，可重新读取当前状态。</p>}{pending&&<p role="status">提交结果尚未确认，请核对原操作后再更改状态。</p>}
  <div className="scan-task-body">{selected?<section className="scan-task-detail"><h3>{selected.title} · {labels[selected.state]}</h3><p>{selected.artist}</p><p className="scan-task-path">{selected.rootPath} / {selected.relativePath}</p>
   <p>此操作覆盖同一个音乐文件的 {selected.itemCount} 个曲目记录，其中 {selected.cueCount} 个 CUE 分轨。关联收藏 {selected.favoriteCount} 项、歌单引用 {selected.playlistCount} 项均保留。</p>
   <p>移出曲库后不再出现在普通分类和搜索，扫描仍核对资料；忽略后扫描跳过该文件路径。相同路径替换文件仍沿用这个状态。恢复后会重新扫描。</p>
   <p>若该文件正在播放或有同源 CUE 预备轨，提交前会停止它；播放列表中的引用保留。</p>{selected.restorePending&&<p role="status">等待重新读取；可在扫描任务中查看进度。失败或中断后请处理任务，或明确再次恢复并扫描。</p>}
   <div className="scan-task-actions"><button disabled={disabled||selected.state==='removed'} onClick={()=>void submit('remove')}>移出曲库</button><button disabled={disabled||selected.state==='ignored'} onClick={()=>void submit('ignore')}>忽略文件</button><button disabled={disabled||selected.state==='active'&&!selected.restorePending} onClick={()=>void submit('restore')}>恢复并扫描</button><button disabled={disabled} onClick={()=>void reading(()=>choose(null))}>返回管理列表</button></div>
  </section>:<><p>已移出、忽略或等待恢复扫描的文件</p>{!page?<p>正在读取…</p>:!page.items.length?<p>没有待管理的文件。可从曲目旁的“文件”入口移出或忽略音乐。</p>:page.items.map(file=><section key={file.fileId} className="scan-task-detail"><button disabled={disabled} onClick={()=>void reading(()=>choose(file.fileId))}>{file.title} · {labels[file.state]}{file.restorePending?' · 等待扫描':''}</button><p className="scan-task-path">{file.rootPath} / {file.relativePath}</p></section>)}{page?.nextCursor&&<button disabled={disabled} onClick={()=>void reading(()=>read(page.nextCursor!))}>下一页</button>}</>}
  </div><footer><button disabled={busy} onClick={()=>void reading(()=>read())}>重新读取状态／第一页</button>{pending&&<button disabled={busy} onClick={()=>void submit()}>核对上次操作</button>}<button disabled={disabled} onClick={onTasks}>扫描任务</button><button disabled={disabled} onClick={onClose}>关闭</button></footer>
 </div></div>;
}
