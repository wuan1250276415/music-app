import React,{useRef,useState} from 'react';
import type {TagWriteJob,TagWriteStageRequest} from '../shared/tag-write-ui';
import type {TagRecoveryCancelRequest} from '../shared/tag-recovery';
import type {TagCommitArtifactRole} from '../shared/tag-commit-recovery';
import {tagCommitReprobeMode,type TagCommitReprobeRequest,type TagCommitReprobeCancel} from '../shared/tag-commit-reprobe';
import {TagRestoreStartActions} from './tag-file-actions';

const roles:Record<TagCommitArtifactRole,string>={original:'歌曲原路径',backup:'来源备份',temporary:'待写入临时文件',victim:'保留的旧文件'};
const states={running:'正在核对',completed:'核对完成',cancelled:'已停止',failed:'核对未完成',interrupted:'上次核对中断'};
const fileStates={present:'可读取',missing:'明确缺失',busy:'被其他程序占用',unreadable:'无法读取'};
export function TagCommitRecovery({job,disabled,onError,onChange}:{job:TagWriteJob;disabled:boolean;onError:(error:string)=>void;onChange:()=>Promise<void>}):React.JSX.Element {
 const start=useRef<TagWriteStageRequest|null>(null),stop=useRef<TagRecoveryCancelRequest|null>(null),[busy,setBusy]=useState(false),view=job.nativeRecovery,resolved=job.nativeReprobe?.state==='completed';
 async function inspect():Promise<void>{
  start.current??={commandId:crypto.randomUUID(),jobId:job.id,baseRevision:job.revision};setBusy(true);onError('');
  try{await window.music.tagCommitInspect(start.current);start.current=null;await onChange();}catch(e){onError(`${String(e)}。再次点击将查询或重试原四工件核对请求。`);}finally{setBusy(false);}
 }
 async function cancel():Promise<void>{
  if(!view)return;stop.current??={commandId:crypto.randomUUID(),inspectionId:view.id};setBusy(true);onError('');
  try{await window.music.tagCommitInspectCancel(stop.current);stop.current=null;await onChange();}catch(e){onError(`${String(e)}。再次点击将查询或重试原停止请求。`);}finally{setBusy(false);}
 }
 return <section className="tag-recovery-result" aria-label="原生提交恢复核对">
  <p>{resolved?'文件标签与曲库已更新，备份及旧文件已保留。':'先核对歌曲、备份、临时文件和保留的旧文件，再选择更新曲库或恢复原标签。'}</p>
  <div className="tag-write-job-actions">
   {(start.current||job.state==='recovery_required'&&view?.state!=='running')&&<button disabled={disabled||busy||job.nativeReprobe?.state==='running'} onClick={()=>void inspect()}>{start.current?'确认原四工件核对请求':view?'重新核对四个文件':'核对四个文件'}</button>}
   {(view?.state==='running'||stop.current)&&<button disabled={disabled||busy} onClick={()=>void cancel()}>{stop.current?'确认原停止请求':'停止四工件核对'}</button>}
  </div>
  {view&&<>
   {!resolved&&<p role="status">{states[view.state]} · {view.exitConfirmed?'核对进程已退出':'核对进程退出尚待确认'} · {new Date(view.updatedAt).toLocaleString()}</p>}
   {view.state==='running'&&<div className="tag-write-progress"><span>{view.phase?roles[view.phase]:'等待读取组件退出'}</span><progress aria-label="四工件核对进度" max={1} value={Number(view.bytes)/Math.max(1,Number(view.total))}/></div>}
   {view.error&&<p role="alert">{view.error}</p>}
   {view.report&&<details open={!resolved}><summary>查看上次文件核对记录</summary><p>{view.report.reason}</p><ul>{view.report.actual.files.map(file=><li key={file.role}>{roles[file.role]}：{fileStates[file.state]}{file.identity?` · ${(Number(file.identity.bytes)/1048576).toFixed(1)} MiB`:''}{file.state==='present'&&!file.flac?' · 尚未确认 FLAC 结构':''}</li>)}</ul><small>这是核对当时的记录，当前处理结果见下方状态。</small></details>}
  </>}
  <TagRestoreStartActions job={job} disabled={disabled||busy} onError={onError} onChange={onChange}/>
  <TagCommitReprobe job={job} disabled={disabled||busy} onError={onError} onChange={onChange}/>
 </section>;
}

const reprobePhases:Record<string,string>={waiting:'等待读取组件退出',original:'核对实际目标文件',backup:'核对来源备份',temporary:'核对临时路径',victim:'核对保留的旧文件',fields:'读取实际目标标签',tags:'重新解析曲库资料',library:'提交曲库资料'};
function TagCommitReprobe({job,disabled,onError,onChange}:{job:TagWriteJob;disabled:boolean;onError:(error:string)=>void;onChange:()=>Promise<void>}):React.JSX.Element {
 const request=useRef<TagCommitReprobeRequest|null>(null),stop=useRef<TagCommitReprobeCancel|null>(null),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false),view=job.nativeReprobe,report=job.nativeRecovery?.report;
 const mode=job.nativeCommit&&report?tagCommitReprobeMode(job.nativeCommit.state,job.nativeCommit.exitConfirmed,report):null;
 const eligible=job.state==='recovery_required'&&Boolean(mode)&&job.nativeRecovery?.state==='completed'&&job.nativeRecovery.exitConfirmed&&view?.state!=='running';
 async function start():Promise<void>{
  if(!request.current){if(!eligible||!confirmed||!job.nativeRecovery)return;request.current={commandId:crypto.randomUUID(),jobId:job.id,baseRevision:job.revision,inspectionId:job.nativeRecovery.id,confirmed:true};}
  setBusy(true);onError('');try{await window.music.tagCommitReprobe(request.current);request.current=null;setConfirmed(false);await onChange();}catch(e){onError(`${String(e)}。再次点击将查询或重试原曲库提交请求。`);}finally{setBusy(false);}
 }
 async function cancel():Promise<void>{
  if(!view)return;stop.current??={commandId:crypto.randomUUID(),reprobeId:view.id};setBusy(true);onError('');
  try{await window.music.tagCommitReprobeCancel(stop.current);stop.current=null;await onChange();}catch(e){onError(`${String(e)}。再次点击将查询或重试原停止请求。`);}finally{setBusy(false);}
 }
 return <>
  {(eligible||request.current)&&<div className="tag-write-job-actions"><label><input type="checkbox" checked={confirmed} disabled={disabled||busy||Boolean(request.current)} onChange={e=>setConfirmed(e.target.checked)}/>确认重新读取此文件的实际标签并更新曲库，保留备份和旧文件</label><button disabled={disabled||busy||!request.current&&!confirmed} onClick={()=>void start()}>{request.current?'确认原曲库提交请求':mode==='interrupted-target'?'重新核对并恢复曲库':'重新解析并更新曲库'}</button></div>}
  {(view?.state==='running'||stop.current)&&<button disabled={disabled||busy} onClick={()=>void cancel()}>{stop.current?'确认原停止请求':'停止重新解析'}</button>}
  {view&&<div aria-label="曲库提交状态"><p role="status">{view.state==='completed'?`${view.mode==='interrupted-target'?'曲库已恢复':'曲库已更新'}，${view.fileReady?'文件可用':view.releaseConfirmed?'当前文件仍待重新扫描':'正在完成最后处理'}`:states[view.state]} · {new Date(view.updatedAt).toLocaleString()}</p><p>{view.state==='completed'?(view.mode==='interrupted-target'?'实际目标已独立复核。原提交中断记录、来源备份和旧文件继续保留。':'备份和旧文件已保留，可供后续恢复使用。'):view.reason}</p>{view.state==='running'&&<div className="tag-write-progress"><span>{reprobePhases[view.phase]??'正在核对'}</span><progress aria-label="曲库提交核对进度" max={1} value={Number(view.bytes)/Math.max(1,Number(view.total))}/></div>}</div>}
 </>;
}
