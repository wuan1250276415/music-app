import React,{useEffect,useRef,useState} from 'react';
import {FILTER_PRESET_LIMIT,FILTER_PRESET_PAGE_SIZE,readFilterPresetDefinition,readFilterPresetDetail,readFilterPresetMutation,readFilterPresetPage,readFilterPresetResult,type FilterPresetDetail,type FilterPresetMutation,type FilterPresetPage} from '../shared/filter-presets';
import {musicFilterCount,type MusicFilters} from '../shared/music-filters';
import './filter-presets.css';

const pendingKey='aural-filter-preset-pending-v1';
function readPending():{pending:FilterPresetMutation|null;broken:boolean}{
 try{
  const raw=localStorage.getItem(pendingKey);
  if(raw&&raw.length>32768)throw new Error('操作记录过长');
  return {pending:raw?readFilterPresetMutation(JSON.parse(raw)):null,broken:false};
 }catch{return {pending:null,broken:true};}
}
export function FilterPresets({current,onLoad}:{current:()=>MusicFilters;onLoad:(filters:MusicFilters)=>void}):React.JSX.Element{
 const [initial]=useState(readPending),[pending,setPending]=useState(initial.pending),[broken,setBroken]=useState(initial.broken);
 const [page,setPage]=useState<FilterPresetPage|null>(null),[offset,setOffset]=useState(0),[refresh,setRefresh]=useState(0),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
 const [selected,setSelected]=useState<FilterPresetDetail|null>(null),[name,setName]=useState(initial.pending&&initial.pending.action!=='delete'?initial.pending.name:''),[deleteTarget,setDeleteTarget]=useState<FilterPresetDetail|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const snapshot=useRef<string|undefined>(undefined),alive=useRef(true),flight=useRef(false);
 const locked=busy||!!pending||broken;
 function reloadList():void{snapshot.current=undefined;setOffset(0);setRefresh(value=>value+1);}
 useEffect(()=>{alive.current=true;const unsubscribe=window.music.onEvent(event=>{if(event.event==='filterPresetsChanged')reloadList();});return()=>{alive.current=false;unsubscribe();};},[]);
 useEffect(()=>{
  let active=true;setLoading(true);setPage(null);
  void window.music.filterPresets({offset,...(snapshot.current?{snapshot:snapshot.current}:{})}).then(raw=>{
   const value=readFilterPresetPage(raw);if(!active)return;
   if(value.status==='stale'){snapshot.current=undefined;setError('预设目录已变化，请刷新后继续。');return;}
   snapshot.current=value.snapshot;setPage(value);
  }).catch(e=>{if(active)setError(String(e instanceof Error?e.message:e).slice(0,512));}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[offset,refresh]);

 async function select(id:string,load:boolean):Promise<void>{
  if(flight.current||pending||broken)return;flight.current=true;setBusy(true);setError('');setNotice('');setDeleteTarget(null);
  try{
   const value=readFilterPresetDetail(await window.music.filterPreset(id));if(value.id!==id)throw new Error('读取的预设与选择不一致');
   if(!alive.current)return;setSelected(value);setName(value.name);
   if(load){onLoad(value.definition.filters);setNotice(`已载入“${value.name}”，检查后点击“应用筛选”。`);}
  }catch(e){if(alive.current)setError(String(e instanceof Error?e.message:e).slice(0,512));}
  finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 function ensureReceipt(request:FilterPresetMutation,raw:unknown):ReturnType<typeof readFilterPresetResult>{
  const result=readFilterPresetResult(raw);
  if(result.commandId!==request.commandId)throw new Error('操作回执身份不一致，请重试原操作');
  if(result.status==='saved'){
   if(request.action==='delete'){if(result.value!==null)throw new Error('删除回执不一致，请重试原操作');}
   else if(!result.value||result.value.name!==request.name||JSON.stringify(result.value.definition)!==JSON.stringify(request.definition)||request.action==='create'&&result.value.revision!==0||request.action==='update'&&(result.value.id!==request.id||result.value.revision!==request.baseRevision+1))throw new Error('保存回执不一致，请重试原操作');
  }
  return result;
 }
 async function mutate(action:'create'|'replace'|'rename'|'delete'|'retry'):Promise<void>{
  if(flight.current||broken||action!=='retry'&&pending)return;flight.current=true;setBusy(true);setError('');setNotice('');
  try{
   let request:FilterPresetMutation;
   if(action==='retry'){if(!pending)throw new Error('没有待核对操作');request=pending;}
   else if(action==='delete'){
    if(!deleteTarget)throw new Error('请先确认需要删除的预设');
    request=readFilterPresetMutation({action:'delete',commandId:crypto.randomUUID(),id:deleteTarget.id,baseRevision:deleteTarget.revision});
   }else{
    if(action!=='create'&&!selected)throw new Error('请先读取预设');
    const definition=readFilterPresetDefinition(action==='rename'?selected!.definition:{version:1,filters:current()});
    request=readFilterPresetMutation({action:action==='create'?'create':'update',commandId:crypto.randomUUID(),...(action!=='create'?{id:selected!.id,baseRevision:selected!.revision}:{}),name,definition});
   }
   const canonical=JSON.stringify(request),saved=localStorage.getItem(pendingKey);
   if(saved&&saved!==canonical)throw new Error('另一个待核对操作已存在，请关闭后重新打开预设管理');
   // Persist the exact operation before IPC; a timeout never becomes a new UUID.
   localStorage.setItem(pendingKey,canonical);setPending(request);
   const result=ensureReceipt(request,await window.music.mutateFilterPreset(request));
   if(localStorage.getItem(pendingKey)!==canonical)throw new Error('待核对操作记录已变化，请重新打开并核对');
   localStorage.removeItem(pendingKey);
   if(!alive.current)return;setPending(null);setDeleteTarget(null);reloadList();
   if(result.status==='rejected'){setError(result.error);return;}
   if(request.action==='delete'){setSelected(null);setName('');setNotice('预设已删除。');}
   else{setSelected(result.value);setName(result.value!.name);setNotice('预设已保存。当前条件需点击“应用筛选”后生效。');}
  }catch(e){if(alive.current)setError(String(e instanceof Error?e.message:e).slice(0,512));}
  finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 function clearBroken():void{
  try{localStorage.removeItem(pendingKey);setBroken(false);setError('');setNotice('无效操作记录已清除，请先核对现有预设。');}
  catch(e){setError(String(e instanceof Error?e.message:e).slice(0,512));}
 }
 return <section className="filter-preset-manager" aria-label="筛选预设管理">
  <p>预设只保存组合条件，可用于当前分类或智能歌单编辑。载入会替换本页草稿，检查后再应用。已保存预设可在“歌单 → 导入／导出音乐规则”中备份或迁移。</p>
  {broken&&<p role="alert">上次操作记录无法读取。请核对现有预设后清除无效记录。</p>}
  {pending&&<div className="filter-preset-pending"><p>上次{pending.action==='create'?'新建':pending.action==='update'?'修改':'删除'}结果待核对，先重试原操作。关闭窗口仍会保留记录。</p><button type="button" disabled={busy||broken} onClick={()=>void mutate('retry')}>{busy?'正在核对…':'重试原操作'}</button></div>}
  {error&&<p className="collection-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {loading?<p role="status">正在读取预设…</p>:<ul className="filter-preset-list">{page?.items.map(item=><li key={item.id} className={selected?.id===item.id?'selected':''}><strong>{item.name}</strong><button type="button" disabled={locked} onClick={()=>void select(item.id,true)}>载入条件</button><button type="button" disabled={locked} onClick={()=>void select(item.id,false)}>管理</button></li>)}{page?.total===0&&<li>还没有保存的筛选预设。</li>}</ul>}
  <div className="music-filter-paging"><button type="button" disabled={busy||loading} onClick={reloadList}>刷新预设</button><button type="button" disabled={busy||loading||!page||offset===0} onClick={()=>setOffset(value=>Math.max(0,value-FILTER_PRESET_PAGE_SIZE))}>上一页</button><span>{page?`${page.total} 个 · 第 ${Math.floor(offset/FILTER_PRESET_PAGE_SIZE)+1} 页`:''}</span><button type="button" disabled={busy||loading||!page||offset+FILTER_PRESET_PAGE_SIZE>=page.total} onClick={()=>setOffset(value=>value+FILTER_PRESET_PAGE_SIZE)}>下一页</button></div>
  <label>预设名称<input maxLength={120} value={name} disabled={locked} onChange={e=>setName(e.target.value)}/></label>
  {selected&&<p>正在管理“{selected.name}” · {musicFilterCount(selected.definition.filters)} 组条件 <button type="button" disabled={locked} onClick={()=>void select(selected.id,false)}>重新读取</button><button type="button" disabled={locked} onClick={()=>{setSelected(null);setDeleteTarget(null);}}>取消选择</button></p>}
  <div className="filter-preset-actions"><button type="button" disabled={locked||!name.trim()||page!==null&&page.total>=FILTER_PRESET_LIMIT} onClick={()=>void mutate('create')}>将当前草稿存为新预设</button>{selected&&<><button type="button" disabled={locked||!name.trim()} onClick={()=>void mutate('replace')}>用当前草稿替换此预设</button><button type="button" disabled={locked||!name.trim()||name.trim()===selected.name} onClick={()=>void mutate('rename')}>只重命名</button><button type="button" disabled={locked} onClick={()=>setDeleteTarget(selected)}>删除预设</button></>}{broken&&<button type="button" onClick={clearBroken}>清除无效操作记录</button>}</div>
  {deleteTarget&&!pending&&<div className="filter-preset-delete"><p>删除“{deleteTarget.name}”的保存条件？当前筛选和歌曲文件会保留。</p><button type="button" disabled={busy} onClick={()=>setDeleteTarget(null)}>取消删除</button><button type="button" className="collection-danger" disabled={busy} onClick={()=>void mutate('delete')}>确认删除预设</button></div>}
 </section>;
}
