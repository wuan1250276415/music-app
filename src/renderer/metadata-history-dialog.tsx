import React,{useEffect,useRef,useState} from 'react';
import type {CatalogChangeResult,MetadataObservation,MetadataObservationPage,MetadataSelectionChange,MetadataSelectionRequest,MetadataSourceEntity} from '../shared/contracts';
import {trap,useFocus} from './dialog-focus';

const valueText=(value:string|number|null)=>value===null||value===''?'空值':String(value);
const modeText=(page:MetadataObservationPage)=>!page.explicit?'默认来源优先级':page.mode==='clear'?'用户明确清空':page.mode==='observation'?'保留指定来源':'采用最新本地扫描';
export function MetadataHistoryDialog({entity,field,onClose,onChanged}:{entity:MetadataSourceEntity;field:string;onClose:()=>void;onChanged:(result:CatalogChangeResult)=>void}):React.JSX.Element{
 const dialog=useRef<HTMLDivElement|null>(null),attempt=useRef<{identity:string;request:MetadataSelectionRequest}|null>(null);useFocus(dialog);
 const [page,setPage]=useState<MetadataObservationPage|null>(null),[choice,setChoice]=useState(''),[reload,setReload]=useState(0);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[paging,setPaging]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const current=page?.entity.fields.find(value=>value.field===field),selected=page?.items.find(value=>value.id===choice);
 const automatic=choice==='automatic',clear=choice==='clear',nextValue=automatic?page?.automatic?.value:clear?(entity.kind==='playable_item'||entity.kind==='artist'&&field==='disambiguation'?'':null):selected?.value;
 const canSave=!!page&&!!choice&&!stale&&!loading&&!paging&&!busy&&(automatic?!!page.automatic?.usable&&!current?.locked:clear?page.canClear:!!selected?.usable);
 useEffect(()=>{
  let alive=true;setLoading(true);setError('');setChoice('');setStale(false);
  void window.music.metadataHistory(entity.kind,entity.entityId,field).then(value=>{if(alive){setPage(value);setLoading(false);}}).catch(e=>{if(alive){setPage(null);setError(String(e));setLoading(false);}});
  return()=>{alive=false;};
 },[entity.kind,entity.entityId,field,reload]);
 async function more():Promise<void>{
  if(!page?.nextCursor||paging)return;const before=page;setPaging(true);setError('');
  try{const next=await window.music.metadataHistory(entity.kind,entity.entityId,field,before.nextCursor!);
   if(next.entity.fingerprint!==before.entity.fingerprint){setStale(true);setError('字段或关联对象已变化，请刷新来源历史后重新选择。');return;}
   setPage({...before,items:[...before.items,...next.items.filter(value=>!before.items.some(old=>old.id===value.id))],total:next.total,nextCursor:next.nextCursor});
  }catch(e){setError(String(e));}finally{setPaging(false);}
 }
 async function save():Promise<void>{
  if(!canSave||!page)return;
  const change:MetadataSelectionChange=automatic?{field,mode:'automatic'}:clear?{field,mode:'clear'}:{field,mode:'observation',observationId:choice};
  const operation={entity:{kind:page.entity.kind,entityId:page.entity.entityId,revision:page.entity.revision,fingerprint:page.entity.fingerprint},changes:[change]},identity=JSON.stringify(operation);
  if(attempt.current?.identity!==identity)attempt.current={identity,request:{...operation,commandId:crypto.randomUUID()}};
  setBusy(true);setError('');
  try{const result=await window.music.selectMetadataSources(attempt.current.request);onChanged(result);setNotice('来源选择已保存，可在曲库修订记录中撤销。');setReload(value=>value+1);}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 }
 function observation(value:MetadataObservation):React.JSX.Element{return <div className="metadata-history-row" key={value.id}>
  <label><input type="radio" name="metadata-history-choice" checked={choice===value.id} disabled={busy||paging||stale||!value.usable} onChange={()=>{setChoice(value.id);setNotice('');}}/><span><strong>{value.usable?valueText(value.value):'该来源暂不可采用'}</strong><small>{value.source}{value.selected?' · 当前采用':''}</small><small>首次记录 {new Date(value.recordedAt).toLocaleString()} · {value.rights}</small></span></label>
  {value.sourceUrl&&<button className="metadata-link" disabled={busy||paging} onClick={()=>void window.music.openMetadataSource(value.sourceUrl!).catch(e=>setError(String(e)))}>查看来源</button>}
 </div>;}
 return <div className="collection-backdrop"><div className="collection-dialog catalog-dialog metadata-sources-dialog metadata-history-dialog" role="dialog" aria-modal="true" aria-label="字段来源历史与选择" ref={dialog} onKeyDown={event=>trap(event,dialog.current,onClose,busy||paging)}>
  <header><h2>{current?.label??entity.fields.find(value=>value.field===field)?.label??field} · 来源历史</h2><button aria-label="返回字段来源" disabled={busy||paging} onClick={onClose}>×</button></header>
  <p className="collection-note">{entity.title}。选定历史来源后保留该值，后续扫描仍会记录新来源；歌曲原始文件不会被修改。重复出现的相同来源值合并展示。</p>
  <button className="release-refresh" disabled={busy||paging||loading} onClick={()=>setReload(value=>value+1)}>刷新来源历史</button>
  {loading?<p>正在读取来源历史…</p>:page&&current?<>
   <div className="metadata-history-current"><strong>当前值：{valueText(current.value)}</strong><p>{modeText(page)} · {current.source}{current.locked?' · 已锁定':''}</p></div>
   <div className="metadata-history-options">
    <label><input type="radio" name="metadata-history-choice" checked={automatic} disabled={busy||paging||stale||current.locked||!page.automatic?.usable} onChange={()=>{setChoice('automatic');setNotice('');}}/><span>恢复自动来源<small>{page.automatic?`${page.automatic.source} · ${page.automatic.usable?valueText(page.automatic.value):'当前值不可采用'}`:'尚无明确扫描来源，请先重新扫描目录'}{current.locked?'；请先返回解除字段锁':''}</small></span></label>
    {page.canClear&&<label><input type="radio" name="metadata-history-choice" checked={clear} disabled={busy||paging||stale} onChange={()=>{setChoice('clear');setNotice('');}}/><span>明确清空此字段<small>保留清空决定，避免重扫重新填入；区别于文件未提供值。</small></span></label>}
   </div>
   <h3>已记录来源（{page.items.length} / {page.total}）</h3>
   <div className="metadata-history-list">{page.items.map(observation)}{!page.items.length&&<p>旧曲库没有已记录来源，可先重扫或在资料编辑中补充。</p>}</div>
   {page.nextCursor&&<button disabled={busy||paging||stale} onClick={()=>void more()}>{paging?'正在加载…':'加载更早来源'}</button>}
   {choice&&nextValue!==undefined&&<p className="metadata-history-preview" aria-live="polite">确认后：{valueText(current.value)} → {clear?'用户明确清空':valueText(nextValue)}{current.locked?'（保留字段锁）':''}</p>}
  </>:null}
  {error&&<p className="collection-error" role="alert">{error}</p>}{notice&&<p className="collection-note" role="status">{notice}</p>}
  <footer><button disabled={busy||paging} onClick={onClose}>返回字段来源</button><button className="primary-button" disabled={!canSave} onClick={()=>void save()}>{busy?'正在保存…':'确认来源选择'}</button></footer>
 </div></div>;
}
