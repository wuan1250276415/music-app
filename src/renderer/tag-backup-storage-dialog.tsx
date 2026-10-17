import {TagBackupCleanupDialog} from './tag-backup-cleanup-dialog';
import React,{useEffect,useRef,useState} from 'react';
import {trap,useFocus} from './dialog-focus';
import {userError} from './user-error';
import type {TagBackupPolicy,TagBackupPolicyRequest,TagBackupStoragePage,TagBackupFilter} from '../shared/tag-backup-storage';
import './tag-write.css';

const GiB=1073741824n;
const caps=['0',...['1','5','10','25','50','100','250','500'].map(v=>String(BigInt(v)*GiB))];
function bytes(v:string|null):string{
 if(v===null)return '暂不可用';const n=BigInt(v);
 if(n>=GiB)return `${Number(n*100n/GiB)/100} GiB`;
 if(n>=1048576n)return `${Number(n*100n/1048576n)/100} MiB`;
 if(n>=1024n)return `${Number(n*100n/1024n)/100} KiB`;return `${n} B`;
}
const labels={candidate:'达到保留期，待核对',protected:'保留',unmanaged:'未关联',unreadable:'无法读取'};
export function TagBackupStorageDialog({onClose}:{onClose:()=>void}):React.JSX.Element{
 const dialog=useRef<HTMLDivElement|null>(null);useFocus(dialog);
 const alive=useRef(true),epoch=useRef(0),pending=useRef<TagBackupPolicyRequest|null>(null);
 const [cleanup,setCleanup]=useState<{jobId?:string}|null>(null);
 const [policy,setPolicy]=useState<TagBackupPolicy|null>(null),[days,setDays]=useState('30'),[cap,setCap]=useState('10737418240');
 const [page,setPage]=useState<TagBackupStoragePage|null>(null),[offset,setOffset]=useState(0),[filter,setFilter]=useState<TagBackupFilter>('all');
 const [reading,setReading]=useState(false),[saving,setSaving]=useState(false),[uncertain,setUncertain]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 function install(value:TagBackupPolicy):void{setPolicy(value);setDays(String(value.keepDays));setCap(value.maxBytes);}
 async function load(selected:TagBackupFilter=filter,next=0,id?:string):Promise<void>{
  const marker=++epoch.current;setReading(true);setError('');
  try{const value=await window.music.tagBackupStorage({filter:selected,offset:next,...(id?{snapshotId:id}:{})});if(alive.current&&marker===epoch.current){setPage(value);setOffset(next);setFilter(selected);setStale(false);}}
  catch(e){if(alive.current&&marker===epoch.current)setError(userError(e));}
  finally{if(alive.current&&marker===epoch.current)setReading(false);}
 }
 useEffect(()=>{
  alive.current=true;
  void window.music.tagBackupPolicy().then(value=>{if(alive.current)install(value);}).catch(e=>{if(alive.current)setError(userError(e));});
  void load('all');
  const unlisten=window.music.onEvent(message=>{if(['tagBackupStorageChanged','tagWriteJobsChanged','tagStageBatchChanged','tagCommitBatchChanged'].includes(message.event))setStale(true);});
  return()=>{alive.current=false;epoch.current++;unlisten();};
 },[]);
 async function save():Promise<void>{
  if(!policy||saving)return;setError('');setNotice('');
  if(!pending.current){const keepDays=Number(days);if(!/^\d+$/.test(days)||!Number.isSafeInteger(keepDays)||keepDays<1||keepDays>36500){setError('保留天数须为 1 至 36500 的整数');return;}pending.current={commandId:crypto.randomUUID(),baseRevision:policy.revision,keepDays,maxBytes:cap};}
  setSaving(true);
  try{
   const result=await window.music.tagBackupPolicyConfigure(pending.current);pending.current=null;
   if(!alive.current)return;setUncertain(false);
   if(result.status==='conflict'){setPolicy(result.policy);setError(result.message+'；当前输入仍保留，请核对后再次保存。');return;}
   const current=await window.music.tagBackupPolicy();if(!alive.current)return;install(current);
   setNotice(current.revision===result.policy.revision?'保留设置已保存。此操作不会删除文件。':'原设置已保存；其他窗口随后又更新了设置，现显示最新值。');
   await load(filter);
  }catch(e){if(alive.current){setUncertain(Boolean(pending.current));setError(`${userError(e)}${pending.current?'。请核对原保存结果，将复用原操作。':''}`);}}
  finally{if(alive.current)setSaving(false);}
 }
 if(cleanup)return <TagBackupCleanupDialog jobId={cleanup.jobId} onClose={()=>{setCleanup(null);void load(filter);}}/>;
 return <div className="collection-backdrop"><div ref={dialog} className="catalog-dialog collection-dialog tag-write-dialog tag-backup-storage-dialog" role="dialog" aria-modal="true" aria-label="标签备份空间" onKeyDown={event=>trap(event,dialog.current,onClose,false)}>
  <header><h2>标签备份与空间</h2><button aria-label="关闭标签备份空间" onClick={onClose}>×</button></header>
  <p className="collection-note">这里统计标签写入前保存的来源备份。任务未结束、仍需恢复或仍被批次使用的备份会保留。达到保留期的备份须先独立核对，再逐份确认清理；保存设置和核对空间本身不会删除文件。</p>
  {error&&<p role="alert" className="collection-error">{error}</p>}
  <section className="tag-backup-policy"><h3>保留设置</h3>
   <label>任务结束后保留天数<input type="number" aria-label="备份保留天数" min={1} max={36500} step={1} value={days} disabled={!policy||saving||uncertain} onChange={event=>setDays(event.target.value)}/></label>
   <label>备份空间目标<select aria-label="备份空间目标" value={cap} disabled={!policy||saving||uncertain} onChange={event=>setCap(event.target.value)}>{!caps.includes(cap)&&<option value={cap}>自定义（{bytes(cap)}）</option>}{caps.map(value=><option key={value} value={value}>{value==='0'?'不设空间目标':bytes(value)}</option>)}</select></label>
   <p className="collection-note">默认保留 30 天，空间目标为 10 GiB。超过目标也不会绕过保留期或恢复保护。空间目标不包含未关联文件。</p>
   <button disabled={!policy||saving} onClick={()=>void save()}>{saving?'正在保存…':uncertain?'核对原保存结果':'保存保留设置'}</button>
  </section>
  {page&&<>
   <section className="tag-backup-summary" aria-label="备份空间概况"><p>已关联备份 {page.summary.knownBackups} 项 · 已核对文件大小 {bytes(page.summary.knownBytes)} · 达到保留期 {page.summary.candidates} 项 · 需保留 {page.summary.protected} 项</p><p>未关联 {page.summary.unmanaged} 项 · 无法读取 {page.summary.unreadable} 项 · 未关联文件大小 {bytes(page.summary.otherFileBytes)}</p><p>超过空间目标 {bytes(page.summary.overBudgetBytes)} · 所在磁盘可用空间 {bytes(page.summary.availableBytes)}</p></section>
   <p className={page.complete?'collection-note':'collection-error'} role="status">{page.message}{!page.complete?' 本次清单不完整。':''}</p>
   {stale&&<p role="status" className="collection-note">任务或设置有更新，请重新核对空间。</p>}
   <label>显示范围<select aria-label="备份空间显示范围" value={filter} disabled={reading} onChange={event=>void load(event.target.value as TagBackupFilter,0,page.snapshotId)}><option value="all">全部</option><option value="candidates">达到保留期</option><option value="protected">需保留</option><option value="unmanaged">未关联或无法读取</option></select></label>
   <section className="tag-backup-entries">{page.items.map(item=><article key={item.name} data-tag-backup-item={item.name}><h3>{item.title} <small>{labels[item.disposition]}</small></h3><p>{bytes(item.bytes)}{item.modifiedAt!==null?` · ${new Date(item.modifiedAt).toLocaleString()}`:''}</p><p className="collection-note">{item.reason}</p>{item.jobId&&<p className="collection-note tag-backup-file-name">{item.name}</p>}{item.jobId&&page.cleanupReady&&item.disposition==='candidate'&&<button disabled={reading} onClick={()=>setCleanup({jobId:item.jobId!})}>核对备份后清理</button>}</article>)}{!page.items.length&&<p>当前范围没有备份文件。</p>}</section>
   <div className="tag-backup-pagination"><button disabled={reading||offset===0} onClick={()=>void load(filter,Math.max(0,offset-20),page.snapshotId)}>上一页</button><span>第 {Math.floor(offset/20)+1} 页</span><button disabled={reading||page.nextOffset===null} onClick={()=>void load(filter,page.nextOffset!,page.snapshotId)}>下一页</button></div>
  </>}
  {notice&&<p role="status">{notice}</p>}
  <footer><button onClick={()=>setCleanup({})}>查看清理记录</button><button onClick={onClose}>关闭</button><button disabled={reading} onClick={()=>void load(filter)}>{reading?'正在核对空间…':'重新核对空间'}</button></footer>
 </div></div>;
}
