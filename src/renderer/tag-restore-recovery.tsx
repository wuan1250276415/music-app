import {tagRestoreReprobeMode,type TagRestoreReprobeRequest,type TagRestoreReprobeCancel} from '../shared/tag-restore-reprobe';
import React,{useRef,useState} from 'react';
import type {TagWriteJob,TagWriteStageRequest} from '../shared/tag-write-ui';
import type {TagRecoveryCancelRequest} from '../shared/tag-recovery';
import type {TagRestoreRole} from '../shared/tag-restore';

const roles:Record<TagRestoreRole,string>={original:'歌曲原路径',backup:'来源备份',temporary:'写入临时文件',victim:'保留的旧文件',replacement:'恢复副本',displaced:'恢复时保留的目标文件'};
const states={running:'正在核对',completed:'核对完成',cancelled:'已停止',failed:'核对未完成',interrupted:'上次核对中断'};
const fileStates={present:'可读取',missing:'明确缺失',busy:'被其他程序占用',unreadable:'无法读取'};
export function TagRestoreRecovery({job,disabled,onError,onChange}:{job:TagWriteJob;disabled:boolean;onError:(error:string)=>void;onChange:()=>Promise<void>}):React.JSX.Element {
 const start=useRef<TagWriteStageRequest|null>(null),stop=useRef<TagRecoveryCancelRequest|null>(null),[busy,setBusy]=useState(false),view=job.nativeRestoreRecovery;
 async function inspect():Promise<void>{
  start.current??={commandId:crypto.randomUUID(),jobId:job.id,baseRevision:job.revision};setBusy(true);onError('');
  try{await window.music.tagRestoreInspect(start.current);start.current=null;await onChange();}catch(e){onError(`${String(e)}。再次点击将查询或重试原核对请求。`);}finally{setBusy(false);}
 }
 async function cancel():Promise<void>{
  if(!view)return;stop.current??={commandId:crypto.randomUUID(),inspectionId:view.id};setBusy(true);onError('');
  try{await window.music.tagRestoreInspectCancel(stop.current);stop.current=null;await onChange();}catch(e){onError(`${String(e)}。再次点击将查询或重试原停止请求。`);}finally{setBusy(false);}
 }
 return <section className="tag-recovery-result" aria-label="原文件恢复核对">
  <p>{job.nativeRestoreReprobe?.state==='completed'?'恢复来源与曲库已独立核对，原提交、恢复和核对历史继续保留。':'核对歌曲、备份及恢复过程保留的文件。核对完成后仍需重新解析和更新曲库。'}</p>
  <div className="tag-write-job-actions">
   {(start.current||job.state==='recovery_required'&&view?.state!=='running')&&<button disabled={disabled||busy||job.nativeRestoreReprobe?.state==='running'} onClick={()=>void inspect()}>{start.current?'确认原核对请求':view?'重新核对恢复文件':'核对恢复文件'}</button>}
   {(view?.state==='running'||stop.current)&&<button disabled={disabled||busy} onClick={()=>void cancel()}>{stop.current?'确认原停止请求':'停止核对'}</button>}
  </div>
  {view&&<>
   <p role="status">{states[view.state]} · {view.exitConfirmed?'核对进程已退出':'核对进程退出尚待确认'} · {new Date(view.updatedAt).toLocaleString()}</p>
   {view.state==='running'&&<div className="tag-write-progress"><span>{view.phase?roles[view.phase]:'等待读取组件退出'}</span><progress aria-label="恢复文件核对进度" max={1} value={Number(view.bytes)/Math.max(1,Number(view.total))}/></div>}
   {view.error&&<p role="alert">{view.error}</p>}
   {view.report&&<><p>{view.report.reason}</p><ul>{view.report.actual.files.map(file=><li key={file.role}>{roles[file.role]}：{fileStates[file.state]}{file.identity?` · ${(Number(file.identity.bytes)/1048576).toFixed(1)} MiB`:''}{file.state==='present'&&!file.flac?' · 尚未确认 FLAC 结构':''}</li>)}</ul><small>这是本次核对时的状态。完成来源核对、重新解析和曲库更新后才恢复歌曲使用。</small></>}
  </>}
  <TagRestoreReprobe job={job} disabled={disabled||busy} onError={onError} onChange={onChange}/>
 </section>;
}

const reprobePhases:Record<string,string>={waiting:'等待读取组件退出',original:'核对实际原来源文件',backup:'核对来源备份',temporary:'核对临时路径',victim:'核对保留的旧文件',replacement:'核对恢复副本',displaced:'核对恢复时保留的目标',fields:'读取实际目标标签',tags:'重新解析曲库资料',library:'提交曲库资料'};
function TagRestoreReprobe({job,disabled,onError,onChange}:{job:TagWriteJob;disabled:boolean;onError:(error:string)=>void;onChange:()=>Promise<void>}):React.JSX.Element {
 const request=useRef<TagRestoreReprobeRequest|null>(null),stop=useRef<TagRestoreReprobeCancel|null>(null),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false),view=job.nativeRestoreReprobe,report=job.nativeRestoreRecovery?.report;
 const mode=job.nativeRestore&&report?tagRestoreReprobeMode(job.nativeRestore.state,job.nativeRestore.exitConfirmed,report):null;
 const eligible=job.state==='recovery_required'&&Boolean(mode)&&job.nativeRestoreRecovery?.state==='completed'&&job.nativeRestoreRecovery.exitConfirmed&&view?.state!=='running';
 async function start():Promise<void>{
  if(!request.current){if(!eligible||!confirmed||!job.nativeRestoreRecovery)return;request.current={commandId:crypto.randomUUID(),jobId:job.id,baseRevision:job.revision,inspectionId:job.nativeRestoreRecovery.id,confirmed:true};}
  setBusy(true);onError('');try{await window.music.tagRestoreReprobe(request.current);request.current=null;setConfirmed(false);await onChange();}catch(e){onError(`${String(e)}。再次点击将查询或重试原曲库提交请求。`);}finally{setBusy(false);}
 }
 async function cancel():Promise<void>{
  if(!view)return;stop.current??={commandId:crypto.randomUUID(),reprobeId:view.id};setBusy(true);onError('');
  try{await window.music.tagRestoreReprobeCancel(stop.current);stop.current=null;await onChange();}catch(e){onError(`${String(e)}。再次点击将查询或重试原停止请求。`);}finally{setBusy(false);}
 }
 return <>
  {(eligible||request.current)&&<div className="tag-write-job-actions"><label><input type="checkbox" checked={confirmed} disabled={disabled||busy||Boolean(request.current)} onChange={e=>setConfirmed(e.target.checked)}/>确认读取已恢复的原来源标签并恢复曲库，保留已有文件及手工资料</label><button disabled={disabled||busy||!request.current&&!confirmed} onClick={()=>void start()}>{request.current?'确认原曲库提交请求':'重新解析原来源并恢复曲库'}</button></div>}
  {(view?.state==='running'||stop.current)&&<button disabled={disabled||busy} onClick={()=>void cancel()}>{stop.current?'确认原停止请求':'停止重新解析'}</button>}
  {view&&<div aria-label="曲库提交状态"><p role="status">{view.state==='completed'?`曲库已恢复，${view.fileReady?'文件可用':view.releaseConfirmed?'当前文件仍待重新扫描':'等待读取组件释放'}`:states[view.state]} · {new Date(view.updatedAt).toLocaleString()}</p><p>{view.state==='completed'?(view.mode==='interrupted-source'?'实际原来源已独立复核。原提交与恢复过程的中断记录、备份及全部工件继续保留。':'保留来源备份和旧文件工件，可供后续恢复使用。'):view.reason}</p>{view.state==='running'&&<div className="tag-write-progress"><span>{reprobePhases[view.phase]??'正在核对'}</span><progress aria-label="曲库提交核对进度" max={1} value={Number(view.bytes)/Math.max(1,Number(view.total))}/></div>}</div>}
 </>;
}
