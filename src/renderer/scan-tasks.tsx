import React,{useEffect,useRef,useState} from 'react';
import type {ScanJob,ScanJobPage,ScanJobCommand,ScanIssuePage} from '../shared/contracts';
import {useFocus,trap} from './dialog-focus';
import './scan-tasks.css';
import {MetadataWorkflowDialog} from './metadata-workflow-dialog';

const status={queued:'等待中',running:'扫描中',cancelling:'等待取消确认',succeeded:'完成',failed:'失败',cancelled:'已取消',interrupted:'进程中断'};
const phases={enumerating:'枚举目录',media:'检查音乐文件',cue:'协调 CUE',finalizing:'完成对账'};
export function ScanTasksDialog({onClose,onWatch,onFiles,onCues}:{onClose:()=>void;onWatch:()=>void;onFiles:()=>void;onCues:()=>void}):React.JSX.Element{
 const [page,setPage]=useState<ScanJobPage|null>(null),[selected,setSelected]=useState<ScanJob|null>(null),[issues,setIssues]=useState<ScanIssuePage|null>(null);
 const [busy,setBusy]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[stale,setStale]=useState(false);
 const dialog=useRef<HTMLDivElement|null>(null),alive=useRef(true),working=useRef(false),attempt=useRef<ScanJobCommand|null>(null),selectedId=useRef<string|null>(null),generation=useRef(0);
 const [metadataTasks,setMetadataTasks]=useState(false);
 const disabled=busy||pending;useFocus(dialog);
 useEffect(()=>{if(busy&&document.activeElement?.matches(':disabled'))dialog.current?.focus();},[busy]);
 async function refresh():Promise<void>{
  const request=++generation.current,value=await window.music.scanJobs();if(!alive.current||request!==generation.current)return;setPage(value);
  if(selectedId.current){const current=await window.music.scanJob(selectedId.current);if(alive.current&&request===generation.current){setSelected(current);setStale(false);}}
 }
 async function reading(action:()=>Promise<void>):Promise<void>{
  if(working.current||attempt.current)return;working.current=true;setBusy(true);setError('');
  try{await action();}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}finally{working.current=false;if(alive.current)setBusy(false);}
 }
 useEffect(()=>{
  alive.current=true;void reading(refresh);let timer:ReturnType<typeof setTimeout>|null=null;
  const stop=window.music.onEvent(event=>{if(event.event!=='scanJobsChanged')return;setStale(true);if(timer)return;timer=setTimeout(()=>{timer=null;if(!working.current&&!attempt.current)void reading(refresh);},500);});
  return()=>{alive.current=false;generation.current++;if(timer)clearTimeout(timer);stop();};
 },[]);
 async function inspect(id:string):Promise<void>{await reading(async()=>{const value=await window.music.scanJob(id);if(!alive.current)return;selectedId.current=id;setSelected(value);setIssues(null);setNotice('');setStale(false);});}
 async function more():Promise<void>{if(!page?.nextCursor)return;const cursor=page.nextCursor;await reading(async()=>{const value=await window.music.scanJobs(cursor);if(alive.current)setPage(previous=>previous?{...value,items:[...previous.items,...value.items]}:value);});}
 async function readIssues(cursor?:string):Promise<void>{if(!selected)return;const id=selected.id;await reading(async()=>{const value=await window.music.scanIssues(id,cursor);if(alive.current&&selectedId.current===id)setIssues(previous=>cursor&&previous?{...value,items:[...previous.items,...value.items]}:value);});}
 async function submit(value?:ScanJobCommand):Promise<void>{
  if(working.current)return;const intent=value??attempt.current;if(!intent)return;attempt.current=intent;working.current=true;setBusy(true);setPending(true);setError('');setNotice('');
  try{
   const result=await window.music.scanCommand(intent);if(!alive.current)return;attempt.current=null;setPending(false);setStale(true);
   if(result.status==='rejected'){setError(result.error);return;}
   selectedId.current=result.job?.id??selectedId.current;setNotice(intent.action==='cancel'?'取消请求已保存；实际停止以任务状态确认为准。':'继续请求已保存，任务将按检查点处理并完成对账。');await refresh();
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}finally{working.current=false;if(alive.current)setBusy(false);}
 }
 function action(value:'cancel'|'resume'):void{if(disabled||!selected)return;void submit({commandId:crypto.randomUUID(),action:value,jobId:selected.id,baseRevision:selected.revision});}
 if(metadataTasks)return <MetadataWorkflowDialog onClose={()=>setMetadataTasks(false)}/>;
 return <div className="collection-backdrop"><div className="collection-dialog catalog-dialog scan-tasks-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="扫描任务中心" onKeyDown={event=>trap(event,dialog.current,onClose,disabled)}>
  <header><div><h2>扫描任务中心</h2><p>查看扫描进度、取消或继续任务，并检查异常文件。</p></div><button aria-label="关闭任务中心" disabled={disabled} onClick={onClose}>×</button></header>
  {error&&<p className="scan-task-error" role="alert">{error}</p>}{notice&&<p className="scan-task-notice" role="status">{notice}</p>}{pending&&<p role="status">操作结果尚未确认，请核对原操作后再继续。</p>}{stale&&<p role="status">任务已变化，正在等待重新读取。</p>}
  <div className="scan-task-body">
   {!page?.items.length&&<p>{busy?'正在读取任务…':'暂无扫描任务。添加音乐目录后会自动创建扫描任务。'}</p>}
   {page?.items.map(job=><div className="scan-task-row" key={job.id}><div><strong>{job.path.split(/[\\/]/).filter(Boolean).pop()} · {status[job.status]}</strong><small>{job.pass>=1?'完成前对账 · ':''}{phases[job.phase]} · 检查 {job.scanned.toLocaleString()} 次 · 更新 {job.imported.toLocaleString()} 个文件／轨目 · 异常 {job.errors}</small><small>{new Date(job.updatedAt).toLocaleString()}</small></div><button disabled={disabled} onClick={()=>void inspect(job.id)}>查看</button></div>)}
   {page?.nextCursor&&<button disabled={disabled} onClick={()=>void more()}>更多任务</button>}
   {selected&&<section className="scan-task-detail"><h3>{status[selected.status]} · {phases[selected.phase]}</h3><p className="scan-task-path">{selected.path}</p><p>尝试 {selected.attempts} 次 · 目录检查 {selected.directories} 次 · 本轮待处理 {selected.pending.toLocaleString()} 项{selected.pass>=1?' · 正在完成前对账':''}</p><p>{selected.message||'任务进度已保存在本地。'}</p>
    <div className="scan-task-actions"><button disabled={disabled||!['queued','running','interrupted'].includes(selected.status)} onClick={()=>action('cancel')}>取消扫描</button><button disabled={disabled||!selected.canResume} onClick={()=>action('resume')}>继续检查点</button><button disabled={disabled} onClick={()=>void reading(refresh)}>重新读取</button><button disabled={disabled} onClick={()=>void readIssues()}>查看异常记录</button></div>
    {!selected.canResume&&['cancelled','failed','interrupted'].includes(selected.status)&&<p>若原扫描已被新任务替代，请从音乐目录发起新的扫描。</p>}
    <p>取消只停止后续扫描，不移除已导入音乐。续跑后会重新对账；范围读取不完整时保留旧记录，不判定文件缺失。</p>
    {issues&&<section className="scan-task-issues"><h4>异常记录</h4>{!issues.items.length&&<p>没有记录到异常。</p>}{issues.items.map(issue=><div key={issue.id}><strong>{issue.path||'根目录'}</strong><small>{issue.pass>=1?'对账':'初次检查'} · {issue.kind==='directory'?'目录':issue.kind==='cue'?'CUE':'音乐文件'}{issue.unsafe?' · 本轮不执行缺失清理':''}</small><p>{issue.message}</p></div>)}{issues.nextCursor&&<button disabled={disabled} onClick={()=>void readIssues(issues.nextCursor!)}>更多异常</button>}</section>}
   </section>}
  </div><footer><button disabled={disabled} onClick={()=>void reading(refresh)}>刷新任务</button>{pending&&<button disabled={busy} onClick={()=>void submit()}>核对上次操作结果</button>}<button disabled={disabled} onClick={()=>setMetadataTasks(true)}>整库元数据任务</button><button disabled={disabled} onClick={onWatch}>目录自动更新</button><button disabled={disabled} onClick={onFiles}>音乐文件管理</button><button disabled={disabled} onClick={onCues}>CUE 原文与编码</button><button disabled={disabled} onClick={onClose}>关闭</button></footer>
 </div></div>;
}
