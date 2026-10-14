import React,{useEffect,useRef,useState} from 'react';
import type {GenreDetail,GenreSummary,GenrePage,GenreFilter,GenreRef,GenreEditRequest,CatalogChangeResult} from '../shared/contracts';
import {trap,useFocus} from './dialog-focus';
import './genres.css';
const reference=(value:GenreDetail):GenreRef=>({genreId:value.genreId,revision:value.revision,fingerprint:value.fingerprint});

export function GenreNavigator({revision,disabled=false,includeArchived=false,onPick,selected=[]}:{revision:number;disabled?:boolean;includeArchived?:boolean;onPick:(genre:GenreSummary)=>void;selected?:string[]}):React.JSX.Element{
 const [query,setQuery]=useState(''),[parentId,setParentId]=useState<string|null>(null),[path,setPath]=useState<Array<{id:string;name:string}>>([]);
 const [cursors,setCursors]=useState<Array<string|undefined>>([undefined]),[page,setPage]=useState<GenrePage>({items:[],nextCursor:null}),[loading,setLoading]=useState(true),[error,setError]=useState('');
 useEffect(()=>{setCursors([undefined]);},[revision,includeArchived]);
 useEffect(()=>{
  let alive=true;setLoading(true);setError('');const timer=setTimeout(()=>{
   void Promise.all([window.music.genres({query,parentId:query.trim()?undefined:parentId,includeArchived,cursor:cursors.at(-1)}),parentId?window.music.genre(parentId):Promise.resolve(null)]).then(([value,parent])=>{if(alive){setPage(value);setPath(parent?[...parent.ancestors,{id:parent.genre.id,name:parent.genre.name}]:[]);setLoading(false);}}).catch(e=>{if(alive){setError(String(e));setLoading(false);}});
  },150);return()=>{alive=false;clearTimeout(timer);};
 },[query,parentId,includeArchived,cursors,revision]);
 function navigate(value:string|null):void{setParentId(value);setQuery('');setCursors([undefined]);setPage({items:[],nextCursor:null});}
 return <div className="genre-navigator"><input aria-label="查找风格或旧标签名称" placeholder="查找风格或旧标签名称" value={query} disabled={disabled} onChange={event=>{setQuery(event.target.value);setCursors([undefined]);}}/>
  <nav className="genre-breadcrumb" aria-label="风格层级路径"><button disabled={disabled} onClick={()=>navigate(null)}>全部根分类</button>{path.map(value=><React.Fragment key={value.id}><span>›</span><button disabled={disabled} onClick={()=>navigate(value.id)}>{value.name}</button></React.Fragment>)}</nav>
  {error&&<p role="alert" className="collection-error">{error}</p>}{loading?<p role="status">正在读取风格…</p>:<div className="genre-nodes">{page.items.length?page.items.map(value=><div key={value.id} className={`genre-node ${selected.includes(value.id)?'selected':''}`}><button className="genre-name" disabled={disabled} aria-pressed={selected.includes(value.id)} onClick={()=>onPick(value)}><strong>{value.name}{value.archived?' · 已归档':''}</strong><small>{value.count} 首直接分类{query&&value.parentName?` · 父级：${value.parentName}`:''}{value.customized?' · 已整理':''}</small></button>{value.childCount>0&&<button className="genre-children" disabled={disabled} aria-label={`浏览 ${value.name} 的子风格`} onClick={()=>navigate(value.id)}>{value.childCount} 子类 ›</button>}</div>):<p className="collection-note">这里没有风格。可以创建分类，或通过歌曲标签导入。</p>}</div>}
  <div className="catalog-pagination"><button disabled={disabled||loading||cursors.length===1} onClick={()=>setCursors(value=>value.slice(0,-1))}>上一页</button><span>第 {cursors.length} 页</span><button disabled={disabled||loading||!page.nextCursor} onClick={()=>setCursors(value=>[...value,page.nextCursor!])}>下一页</button></div>
 </div>;
}

export function GenreBrowser({revision,filter,onChange,onManage}:{revision:number;filter:GenreFilter;onChange:(value:GenreFilter)=>void;onManage:()=>void}):React.JSX.Element{
 const [labels,setLabels]=useState<Record<string,string>>({}),[error,setError]=useState('');
 useEffect(()=>{let alive=true;void Promise.all(filter.ids.map(id=>window.music.genre(id))).then(values=>{if(alive){setLabels(Object.fromEntries(values.map(value=>[value.genreId,value.genre.name])));setError('');}}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[filter.ids,revision]);
 function toggle(genre:GenreSummary):void{if(filter.ids.includes(genre.id)){onChange({...filter,ids:filter.ids.filter(id=>id!==genre.id)});return;}if(filter.ids.length>=16){setError('最多同时选择 16 个风格。');return;}onChange({...filter,ids:[...filter.ids,genre.id]});}
 return <section className="genre-browser" aria-label="风格层级与组合筛选"><div className="section-heading"><h2>风格分类</h2><button onClick={onManage}>管理风格</button></div>
  <div className="genre-filter-options"><label>组合方式<select aria-label="风格组合方式" value={filter.operator} onChange={event=>onChange({...filter,operator:event.target.value as 'any'|'all'})}><option value="any">任一风格（并集）</option><option value="all">全部风格（交集）</option></select></label><label><input type="checkbox" checked={filter.descendants} onChange={event=>onChange({...filter,descendants:event.target.checked})}/>包含子风格</label><button disabled={!filter.ids.length} onClick={()=>onChange({...filter,ids:[]})}>清除选择</button></div>
  <div className="genre-selections">{filter.ids.map(id=><button key={id} onClick={()=>onChange({...filter,ids:filter.ids.filter(value=>value!==id)})}>{labels[id]??'正在读取…'} ×</button>)}</div>{error&&<p role="alert" className="collection-error">{error}</p>}
  <GenreNavigator revision={revision} selected={filter.ids} onPick={toggle}/>
 </section>;
}

export function GenreManagerDialog({revision,onClose,onChanged}:{revision:number;onClose:()=>void;onChanged:(result:CatalogChangeResult)=>void}):React.JSX.Element{
 const dialog=useRef<HTMLDivElement|null>(null),attempt=useRef<{identity:string;commandId:string}|null>(null),readId=useRef(0);useFocus(dialog);
 const [selected,setSelected]=useState<string|null>(null),[creating,setCreating]=useState(false),[detail,setDetail]=useState<GenreDetail|null>(null),[name,setName]=useState('');
 const [parent,setParent]=useState<GenreRef|null>(null),[parentName,setParentName]=useState(''),[parentQuery,setParentQuery]=useState(''),[parents,setParents]=useState<GenrePage>({items:[],nextCursor:null}),[parentCursor,setParentCursor]=useState<string|undefined>();
 const [includeArchived,setIncludeArchived]=useState(false),[reload,setReload]=useState(0),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[choosingParent,setChoosingParent]=useState(false),[parentLoading,setParentLoading]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  if(!selected)return;let alive=true;setLoading(true);const sequence=++readId.current;
  void window.music.genre(selected).then(value=>{if(!alive||sequence!==readId.current)return;setDetail(value);setName(value.genre.name);setParent(value.parent);setParentName(value.genre.parentName??'');setLoading(false);setStale(false);setChoosingParent(false);}).catch(e=>{if(alive&&sequence===readId.current){setError(String(e));setLoading(false);}});return()=>{alive=false;};
 },[selected,reload]);
 useEffect(()=>window.music.onEvent(message=>{if(message.event==='libraryChanged'&&detail&&!busy)setStale(true);}),[detail,busy]);
 useEffect(()=>{
  if(!choosingParent)return;let alive=true;setParentLoading(true);const timer=setTimeout(()=>void window.music.genres({query:parentQuery,cursor:parentCursor}).then(value=>{if(alive){setParents(value);setParentLoading(false);}}).catch(e=>{if(alive){setError(String(e));setParentLoading(false);}}),150);return()=>{alive=false;clearTimeout(timer);};
 },[choosingParent,parentQuery,parentCursor,revision,reload]);
 function choose(genreId:string):void{readId.current++;setSelected(genreId);setCreating(false);setDetail(null);setError('');setStale(false);setReload(value=>value+1);}
 function create():void{readId.current++;setSelected(null);setCreating(true);setDetail(null);setName('');setParent(null);setParentName('');setError('');setStale(false);setLoading(false);setChoosingParent(false);}
 async function chooseParent(value:GenreSummary):Promise<void>{setParentLoading(true);setError('');try{const result=await window.music.genre(value.id);setParent(reference(result));setParentName(result.genre.name);setChoosingParent(false);}catch(e){setError(String(e));}finally{setParentLoading(false);}}
 async function save(action:'profile'|'archive'):Promise<void>{
  if(busy||loading||parentLoading||stale)return;const payload=action==='archive'&&detail?{action:'genre-archive' as const,genre:reference(detail),archived:!detail.genre.archived}:creating?{action:'genre-create' as const,name,parent}:detail?{action:'genre-profile' as const,genre:reference(detail),name,parent}:null;if(!payload)return;
  const identity=JSON.stringify(payload);if(attempt.current?.identity!==identity)attempt.current={identity,commandId:crypto.randomUUID()};setBusy(true);setError('');
  try{const result=await window.music.editGenre({...payload,commandId:attempt.current.commandId} as GenreEditRequest);onChanged(result);if(result.genreId)choose(result.genreId);}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 }
 return <div className="collection-backdrop"><div className="collection-dialog genre-manager" ref={dialog} role="dialog" aria-modal="true" aria-label="风格资料与层级管理" onKeyDown={event=>trap(event,dialog.current,onClose,busy||parentLoading)}>
  <header><h2>风格资料与层级</h2><button aria-label="关闭风格管理" disabled={busy||parentLoading} onClick={onClose}>×</button></header><p className="collection-note">整理分类名称和父子层级。歌曲的原始标签与来源记录保留，重扫仍会使用已整理的分类。</p>
  {error&&<p role="alert" className="collection-error">{error}</p>}
  <div className="genre-manager-grid"><aside><div className="genre-manager-tools"><button disabled={busy||parentLoading} onClick={create}>＋ 创建风格</button><label><input type="checkbox" disabled={busy||parentLoading} checked={includeArchived} onChange={event=>setIncludeArchived(event.target.checked)}/>显示归档</label></div><GenreNavigator revision={revision+reload} disabled={busy||parentLoading} includeArchived={includeArchived} onPick={value=>choose(value.id)} selected={selected?[selected]:[]}/></aside>
   <div className="genre-editor">{loading?<p role="status">正在读取风格资料…</p>:creating||detail?<>
    {stale&&<p className="collection-error" role="alert">曲库发生了变化，请刷新资料后重新编辑。</p>}<button className="release-refresh" disabled={busy||parentLoading} onClick={()=>{setError('');setReload(value=>value+1);}}>刷新资料</button>
    <label>风格名称<input aria-label="风格名称" value={name} disabled={busy||parentLoading||detail?.genre.archived} maxLength={240} onChange={event=>setName(event.target.value)}/></label>
    <div className="genre-parent"><span>父级：{parentName||'无（根分类）'}</span><button disabled={busy||parentLoading||detail?.genre.archived} onClick={()=>{setParentQuery('');setParentCursor(undefined);setParents({items:[],nextCursor:null});setChoosingParent(true);}}>选择父级</button><button disabled={busy||parentLoading||!parent||detail?.genre.archived} onClick={()=>{setParent(null);setParentName('');setChoosingParent(false);}}>设为根分类</button></div>
    {choosingParent&&<div className="genre-parent-picker"><input aria-label="查找父级风格" placeholder="查找父级风格" value={parentQuery} disabled={parentLoading} onChange={event=>{setParentQuery(event.target.value);setParentCursor(undefined);}}/>{parentLoading?<p role="status">正在读取…</p>:parents.items.filter(value=>value.id!==selected).map(value=><button key={value.id} onClick={()=>void chooseParent(value)}>{value.name}{value.parentName?` · ${value.parentName}`:''}</button>)}<div><button disabled={parentLoading||!parentCursor} onClick={()=>setParentCursor(undefined)}>回到第一页</button><button disabled={parentLoading||!parents.nextCursor} onClick={()=>setParentCursor(parents.nextCursor!)}>下一页</button><button disabled={parentLoading} onClick={()=>setChoosingParent(false)}>取消选择</button></div></div>}
    {detail&&<><p className="collection-note">路径：{[...detail.ancestors.map(value=>value.name),detail.genre.name].join(' › ')}<br/>{detail.genre.count} 首直接分类 · 含子分类 {detail.subtreeCount} 首 · {detail.genre.childCount} 个子风格</p><details><summary>旧标签名称（{detail.aliases.length}）</summary><p>{detail.aliases.join('、')}</p></details><p className="collection-note">归档仅允许没有曲目、发行分类或子分类的风格。今后文件标签重新使用旧名称时，会恢复同一分类。</p></>}
    <div className="genre-editor-actions"><button className="metadata-primary" disabled={busy||loading||parentLoading||stale||detail?.genre.archived||!name.trim()} onClick={()=>void save('profile')}>{busy?'正在保存…':creating?'创建风格':'保存名称与层级'}</button>{detail&&<button disabled={busy||parentLoading||stale||!detail.genre.archived&&(detail.genre.count>0||detail.genre.childCount>0)} onClick={()=>void save('archive')}>{detail.genre.archived?'恢复风格':'归档风格'}</button>}</div>
   </>:<p className="collection-note">选择一个风格，或创建新分类。</p>}</div>
  </div>
 </div></div>;
}
