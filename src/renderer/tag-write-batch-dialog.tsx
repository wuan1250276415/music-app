import React,{useEffect,useRef,useState} from 'react';
import {TAG_FIELD_LABELS,type TagWritePreview,type TagWritePrepareRequest} from '../shared/tag-write-ui';
import type {TagWriteField} from '../shared/tag-write';
import {trap,useFocus} from './dialog-focus';
import {TagWriteDialog} from './tag-write-dialog';
import {userError} from './user-error';
import './tag-write.css';

type Edit={enabled:boolean;origin:'manual'|'library';text:string;clear:boolean};
type State='pending'|'previewing'|'ready'|'unchanged'|'ineligible'|'error'|'saving'|'unknown'|'saved';
interface Row {id:string;title:string;state:State;reason:string;preview?:TagWritePreview;reviewed?:boolean;jobId?:string}
const labels:Record<State,string>={pending:'待预览',previewing:'正在预览',ready:'待核对',unchanged:'无变化',ineligible:'不支持',error:'预览失败',saving:'正在保存',unknown:'保存结果待确认',saved:'任务已保存'};
const PAGE_SIZE=10;

export function TagWriteBatchDialog({items,onClose}:{items:Array<{id:string;title:string}>;onClose:()=>void}):React.JSX.Element {
 const dialog=useRef<HTMLDivElement|null>(null);useFocus(dialog);
 const [rows,setRows]=useState<Row[]>(()=>[...new Map(items.slice(0,100).map(item=>[item.id,item])).values()].map(item=>({...item,state:'pending',reason:''})));
 const rowsRef=useRef(rows);rowsRef.current=rows;
 const [edits,setEdits]=useState<Partial<Record<TagWriteField,Edit>>>({}),[manualConfirmed,setManualConfirmed]=useState(false),[page,setPage]=useState(0),[busy,setBusy]=useState(false),[stale,setStale]=useState(false),[notice,setNotice]=useState(''),[now,setNow]=useState(Date.now()),[tasks,setTasks]=useState(false);
 const running=useRef(false),stop=useRef(false),alive=useRef(true),epoch=useRef(0),activePreview=useRef<string|null>(null),requests=useRef(new Map<string,string>()),attempts=useRef(new Map<string,TagWritePrepareRequest>());
 function update(id:string,patch:Partial<Row>):void {if(!alive.current)return;setRows(old=>{const next=old.map(row=>row.id===id?{...row,...patch}:row);rowsRef.current=next;return next;});}
 async function release(id:string):Promise<void>{const request=requests.current.get(id);if(request){await window.music.tagWritePreviewCancel(request).catch(()=>{});if(requests.current.get(id)===request)requests.current.delete(id);}}
 useEffect(()=>{alive.current=true;const timer=setInterval(()=>setNow(Date.now()),1000);const unlisten=window.music.onEvent(message=>{if(['libraryChanged','providersChanged'].includes(message.event)){epoch.current++;stop.current=true;setStale(true);setRows(old=>old.map(row=>row.state==='ready'?{...row,reviewed:false}:row));}});return()=>{alive.current=false;stop.current=true;clearInterval(timer);unlisten();for(const request of requests.current.values())void window.music.tagWritePreviewCancel(request).catch(()=>{});};},[]);
 const visible=rows.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE),selected=(Object.keys(TAG_FIELD_LABELS) as TagWriteField[]).filter(field=>edits[field]?.enabled),hasManual=selected.some(field=>edits[field]?.origin==='manual');
 const unresolved=rows.some(row=>row.state==='unknown'),frozen=rows.some(row=>row.state==='saved')||unresolved;
 function change(field:TagWriteField,patch:Partial<Edit>):void {
  if(running.current||frozen)return;
  for(const id of requests.current.keys())void release(id);setRows(old=>old.map(row=>({...row,state:'pending',preview:undefined,reviewed:false,reason:''})));
  setEdits(old=>({...old,[field]:{enabled:false,origin:'manual',text:'',clear:false,...old[field],...patch}}));setManualConfirmed(false);setNotice('');
 }
 async function previewPage():Promise<void>{
  if(running.current||unresolved||!selected.length||hasManual&&!manualConfirmed)return;
  running.current=true;stop.current=false;setBusy(true);setStale(false);setNotice('');const marker=epoch.current;
  try{for(const row of visible){
   if(stop.current||marker!==epoch.current)break;if(row.state==='saved')continue;await release(row.id);if(stop.current)break;
   update(row.id,{state:'previewing',preview:undefined,reviewed:false,reason:''});
   try{const context=await window.music.tagWriteContext(row.id);if(stop.current||marker!==epoch.current){update(row.id,{state:'pending'});break;}
    if(!context.eligible){update(row.id,{state:'ineligible',reason:context.reason});continue;}
    const fields=selected.map(field=>{const edit=edits[field]!,source=context.fields.find(value=>value.field===field);if(edit.origin==='library'&&!source?.libraryAllowed)throw new Error(`${TAG_FIELD_LABELS[field]}：${source?.reason??'当前曲库值不可写回'}`);return {field,origin:edit.origin,values:edit.origin==='library'?[...source!.values]:edit.clear?[]:edit.text.split('\n')};});
    const requestId=crypto.randomUUID();requests.current.set(row.id,requestId);activePreview.current=row.id;
    const preview=await window.music.tagWritePreview({requestId,itemId:row.id,fingerprint:context.fingerprint,fields,manualConfirmed});
    activePreview.current=null;
    if(stop.current||marker!==epoch.current){await release(row.id);update(row.id,{state:'pending'});break;}
    update(row.id,{title:context.title,state:preview.preview.changed?'ready':'unchanged',preview,reason:preview.preview.changed?'':'所选标签与文件原值一致'});
   }catch(error){activePreview.current=null;await release(row.id);update(row.id,{state:stop.current?'pending':'error',reason:stop.current?'':userError(error)});}
  }}finally{running.current=false;if(alive.current){setBusy(false);setNotice(stop.current?'已停止预览，已完成的结果保留。':'本页预览完成，请逐首核对原值和拟写入值。');}}
 }
 async function savePage():Promise<void>{
  if(running.current)return;const retry=visible.find(row=>row.state==='unknown');if(!retry&&stale)return;
  const eligible=retry?[retry]:visible.filter(row=>row.state==='ready'&&row.reviewed&&row.preview&&row.preview.expiresAt>Date.now());if(!eligible.length)return;
  running.current=true;stop.current=false;setBusy(true);setNotice('');const marker=epoch.current;
  try{for(const row of eligible){
   if(stop.current||marker!==epoch.current)break;
   const request=attempts.current.get(row.id)??{commandId:crypto.randomUUID(),token:row.preview!.token};attempts.current.set(row.id,request);update(row.id,{state:'saving',reason:''});
   try{const job=await window.music.tagWritePrepare(request);attempts.current.delete(row.id);update(row.id,{state:'saved',jobId:job.id,preview:undefined,reviewed:false,reason:'已保存独立任务，尚未生成备份或修改音乐文件。'});await release(row.id);}
   catch(error){update(row.id,{state:'unknown',reason:`${userError(error)}。请确认原保存结果；将复用原请求，不创建新的保存命令。`});break;}
  }}finally{running.current=false;if(alive.current){setBusy(false);setNotice(stop.current?'已停止后续保存；已经保存的任务保留。':'保存处理结束；已保存任务可在标签任务中心继续。');}}
 }
 async function navigate(next:number):Promise<void>{
  if(running.current||unresolved)return;
  running.current=true;setBusy(true);
  try{for(const row of visible){await release(row.id);if(row.state!=='saved')update(row.id,{state:row.state==='ready'?'pending':row.state,preview:undefined,reviewed:false,reason:row.state==='ready'?'':row.reason});}if(alive.current){setPage(next);setNotice('');}}
  finally{running.current=false;if(alive.current)setBusy(false);}
 }
 function stopWork():void{stop.current=true;const request=activePreview.current?requests.current.get(activePreview.current):null;if(request)void window.music.tagWritePreviewCancel(request).catch(()=>{});setNotice('正在停止后续处理；等待当前请求结束。');}
 if(tasks)return <TagWriteDialog onClose={()=>setTasks(false)}/>;
 const ready=visible.filter(row=>row.state==='ready'&&row.preview&&row.preview.expiresAt>now),canSave=visible.some(row=>row.state==='unknown')||!stale&&ready.some(row=>row.reviewed);
 return <div className="collection-backdrop"><div ref={dialog} className="catalog-dialog collection-dialog tag-write-dialog tag-write-batch-dialog" role="dialog" aria-modal="true" aria-label="批量文件标签预览" onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
  <header><h2>批量文件标签预览</h2><button disabled={busy} aria-label="关闭批量文件标签预览" onClick={onClose}>×</button></header>
  <p className="collection-note">每页核对 10 首，逐首保存独立任务。支持独立 FLAC；先保存任务，再到标签任务中心生成备份和确认写入。关闭前未保存的预览不会保留，已保存任务会保留。</p>
  <p className="tag-batch-summary" role="status">共 {rows.length} 首 · 已保存 {rows.filter(row=>row.state==='saved').length} · 无变化 {rows.filter(row=>row.state==='unchanged').length} · 不支持 {rows.filter(row=>row.state==='ineligible').length} · 预览失败 {rows.filter(row=>row.state==='error').length} · 保存待确认 {rows.filter(row=>row.state==='unknown').length}</p>
  <details className="tag-batch-settings" open={!frozen}><summary>选择批量修改的字段</summary><p className="collection-note">手工值用于本次所选歌曲；曲库值分别读取每首歌曲的值与写回权限。首次保存后字段设置固定，其他修改请重新打开一批。</p>
   <div className="tag-write-fields">{(Object.keys(TAG_FIELD_LABELS) as TagWriteField[]).map(field=>{const edit=edits[field]??{enabled:false,origin:'manual',text:'',clear:false};return <section key={field}><label className="tag-write-field-toggle"><input type="checkbox" aria-label={`批量修改${TAG_FIELD_LABELS[field]}`} checked={edit.enabled} disabled={busy||frozen} onChange={event=>change(field,{enabled:event.target.checked})}/><strong>{TAG_FIELD_LABELS[field]}</strong></label>{edit.enabled&&<><label>输入方式<select aria-label={`${TAG_FIELD_LABELS[field]}输入方式`} disabled={busy||frozen} value={edit.origin} onChange={event=>change(field,{origin:event.target.value as Edit['origin'],clear:false})}><option value="manual">手工输入相同值</option><option value="library">每首歌曲的曲库值</option></select></label>{edit.origin==='manual'&&<><label><input type="checkbox" disabled={busy||frozen} checked={edit.clear} onChange={event=>change(field,{clear:event.target.checked})}/>清空此标签</label><label className="tag-write-text-label">{TAG_FIELD_LABELS[field]}拟写入值<textarea aria-label={`${TAG_FIELD_LABELS[field]}拟写入值`} value={edit.text} disabled={busy||frozen||edit.clear} rows={2} maxLength={24576} placeholder="每行一个值；保留原有空格" onChange={event=>change(field,{text:event.target.value})}/></label></>}</>}</section>;})}</div>
   {hasManual&&<label className="tag-write-confirm"><input type="checkbox" checked={manualConfirmed} disabled={busy||frozen} onChange={event=>{for(const id of requests.current.keys())void release(id);setRows(old=>old.map(row=>({...row,state:'pending',preview:undefined,reviewed:false,reason:''})));setManualConfirmed(event.target.checked);}}/>我确认手工输入内容可用于本批本地文件标签</label>}
  </details>
  {stale&&<p role="alert" className="collection-error">歌曲资料或来源设置已变化，请重新预览本页；保存待确认项仍可核对原结果。</p>}
  <div className="tag-batch-toolbar"><span>第 {page+1} / {Math.max(1,Math.ceil(rows.length/PAGE_SIZE))} 页</span><button disabled={busy||unresolved||page===0} onClick={()=>void navigate(page-1)}>上一页</button><button disabled={busy||unresolved||(page+1)*PAGE_SIZE>=rows.length} onClick={()=>void navigate(page+1)}>下一页</button><button disabled={busy||unresolved||!selected.length||hasManual&&!manualConfirmed} onClick={()=>void previewPage()}>预览本页标签差异</button></div>
  <section className="tag-batch-rows">{visible.map(row=><article key={row.id} data-tag-batch-item={row.id}><h3>{row.title} <small>{labels[row.state]}</small></h3>{row.reason&&<p className={['error','unknown','ineligible'].includes(row.state)?'collection-error':'collection-note'}>{row.reason}</p>}{row.preview&&<>{row.preview.preview.fields.map(field=><div className="tag-write-difference" key={field.field}><strong>{TAG_FIELD_LABELS[field.field]}{field.changed?'':'（无变化）'}</strong><div><span>原值</span><pre>{field.before.length?field.before.join('\n'):'无标签'}</pre></div><div><span>拟写入</span><pre>{field.values.length?field.values.join('\n'):'清空标签'}</pre></div></div>)}{row.state==='ready'&&<><label className="tag-write-confirm"><input type="checkbox" aria-label={`已核对 ${row.title}`} checked={Boolean(row.reviewed)} disabled={busy||stale||row.preview.expiresAt<=now} onChange={event=>update(row.id,{reviewed:event.target.checked})}/>已核对此首差异，保存待写入任务</label>{row.preview.expiresAt<=now&&<p className="collection-error">此预览已过期，请重新预览本页。</p>}</>}</>}</article>)}</section>
  {ready.length>0&&<label className="tag-write-confirm"><input type="checkbox" checked={ready.every(row=>row.reviewed)} disabled={busy||stale||unresolved} onChange={event=>{for(const row of ready)update(row.id,{reviewed:event.target.checked});}}/>已核对本页所有差异</label>}
  {notice&&<p role="status">{notice}</p>}
  <footer><button disabled={busy} onClick={onClose}>关闭</button><button disabled={!busy} onClick={stopWork}>停止处理</button><button disabled={busy} onClick={()=>setTasks(true)}>查看标签任务</button><button className="primary-button" disabled={busy||!canSave} onClick={()=>void savePage()}>{unresolved?'确认原保存结果':'保存本页已核对任务'}</button></footer>
 </div></div>;
}
