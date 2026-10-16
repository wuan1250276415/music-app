import React,{useRef,useState} from 'react';
import type {TagWriteJob} from '../shared/tag-write-ui';
import type {TagCommitStart,TagCommitCancel} from '../shared/tag-commit-journal';
import type {TagRestoreStart} from '../shared/tag-restore-journal';
import {TAG_WRITE_CERTIFICATES} from '../shared/tag-write-certification';
import {TAG_RESTORE_CERTIFICATES} from '../shared/tag-restore-certification';
import {userError} from './user-error';

type Props={job:TagWriteJob;disabled:boolean;onError:(message:string)=>void;onChange:()=>Promise<void>};
export function TagCommitActions({job,disabled,onError,onChange}:Props):React.JSX.Element|null {
 const pending=useRef<TagCommitStart|null>(null),stopping=useRef<TagCommitCancel|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false);
 const certificates:ReadonlyArray<{id:string;adapter:string;filesystem:string;scheme:string}>=TAG_WRITE_CERTIFICATES;
 const certificate=certificates.find(c=>c.adapter==='aural-flac-vorbis-preserve-v1'&&c.filesystem==='local-ntfs'&&c.scheme==='exclusive-handle-rename-pair-v1');
 const eligible=job.state==='prepared'&&job.staging?.state==='staged'&&!job.nativeCommit;
 async function start():Promise<void>{
  if(!pending.current){if(!eligible||!certificate||!confirmed)return;pending.current={commandId:crypto.randomUUID(),jobId:job.id,baseRevision:job.revision,certificateId:certificate.id,confirmed:true};}
  setBusy(true);onError('');try{await window.music.tagCommitStart(pending.current);pending.current=null;setConfirmed(false);await onChange();}catch(e){onError(`${userError(e)}。再次点击将查询或重试原写入请求。`);}finally{setBusy(false);}
 }
 async function cancel():Promise<void>{if(!job.nativeCommit)return;stopping.current??={commandId:crypto.randomUUID(),operationId:job.nativeCommit.id};setBusy(true);onError('');try{await window.music.tagCommitCancel(stopping.current);stopping.current=null;await onChange();}catch(e){onError(`${userError(e)}。再次点击将查询或重试原停止请求。`);}finally{setBusy(false);}}
 if(stopping.current||job.nativeCommit&&['reserved','running'].includes(job.nativeCommit.state))return <button disabled={disabled||busy} onClick={()=>void cancel()}>{stopping.current?'确认原停止请求':'停止标签写入并保留文件'}</button>;
 if(!eligible&&!pending.current)return null;
 if(!certificate&&!pending.current)return <p>已生成备份与临时文件。当前版本尚未开放原文件标签写入。</p>;
 return <div className="tag-write-job-actions"><label><input type="checkbox" checked={confirmed} disabled={disabled||busy||Boolean(pending.current)} onChange={e=>setConfirmed(e.target.checked)}/>确认将已预览的标签写入歌曲，保留原文件和备份</label><button disabled={disabled||busy||!pending.current&&!confirmed} onClick={()=>void start()}>{pending.current?'确认原写入请求':'写入已确认的标签'}</button></div>;
}

export function TagRestoreStartActions({job,disabled,onError,onChange}:Props):React.JSX.Element|null {
 const pending=useRef<TagRestoreStart|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),inspection=job.nativeRecovery,report=inspection?.report;
 const eligible=job.state==='recovery_required'&&!job.nativeRestore&&inspection?.state==='completed'&&inspection.exitConfirmed&&Boolean(report)&&report?.journal!=='unconfirmed'&&!['binding-unavailable','journal-unconfirmed','recovery-required'].includes(report!.classification)&&job.nativeReprobe?.state!=='running';
 const certificates:ReadonlyArray<{id:string;mode:'victim'|'backup';adapter:string}>=TAG_RESTORE_CERTIFICATES;
 const options=certificates.filter(c=>c.adapter==='aural-flac-restore-v2'&&report?.actual.files[c.mode==='victim'?3:1].state==='present'&&report.actual.files[c.mode==='victim'?3:1].flac);
 async function start(option:typeof options[number]):Promise<void>{
  if(!pending.current){if(!eligible||!inspection||!confirmed)return;pending.current={commandId:crypto.randomUUID(),jobId:job.id,baseRevision:job.revision,inspectionId:inspection.id,certificateId:option.id,mode:option.mode,confirmed:true};}
  setBusy(true);onError('');try{await window.music.tagRestoreStart(pending.current);pending.current=null;setConfirmed(false);await onChange();}catch(e){onError(`${userError(e)}。再次点击将查询或重试原恢复请求。`);}finally{setBusy(false);}
 }
 if(!eligible&&!pending.current)return null;
 if(!options.length&&!pending.current)return <p>当前版本尚未开放文件恢复。原文件、备份与核对记录继续保留。</p>;
 const choices=pending.current?[{id:pending.current.certificateId,mode:pending.current.mode,adapter:'aural-flac-restore-v2'}]:options;
 return <div className="tag-write-job-actions"><label><input type="checkbox" checked={confirmed} disabled={disabled||busy||Boolean(pending.current)} onChange={e=>setConfirmed(e.target.checked)}/>确认恢复原标签，并保留当前目标文件及已有备份</label>{choices.map(option=><button key={option.id} disabled={disabled||busy||!pending.current&&!confirmed} onClick={()=>void start(option)}>{pending.current?'确认原恢复请求':option.mode==='victim'?'使用旧文件恢复原标签':'使用备份恢复原标签'}</button>)}</div>;
}
