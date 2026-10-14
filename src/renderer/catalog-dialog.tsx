import React,{useEffect,useRef,useState} from 'react';
import type {CatalogChangeResult,CatalogLinkRequest,LibraryItem,ListResponse,CatalogChangeSummary} from '../shared/contracts';
type WithoutCommand<T>=T extends unknown?Omit<T,'commandId'>:never;

function Description({item}:{item:LibraryItem}):React.JSX.Element{
  return <><strong>{item.title} · {item.artist}</strong><small>{item.catalog?.releaseTitle??item.album}{item.catalog?.releaseDate?` · ${item.catalog.releaseDate}`:''}</small>
    <small>{item.codec} · {item.sampleRate?`${item.sampleRate/1000} kHz`:'采样率未知'}{item.bitsPerSample?` · ${item.bitsPerSample} bit`:''} · {item.durationSeconds===null?'时长未知':`${Math.round(item.durationSeconds)} 秒`}</small><small className="catalog-path">{item.path}</small></>;
}
export {useFocus,trap} from './dialog-focus';
import {useFocus,trap} from './dialog-focus';

export function CatalogDialog({item,onClose,onDone,onArtists,onReleases,onReferences,onRecording,onSources}:{item:LibraryItem;onClose:()=>void;onDone:(result:CatalogChangeResult)=>void;onArtists?:()=>void;onReleases?:()=>void;onReferences?:()=>void;onRecording?:()=>void;onSources?:()=>void}):React.JSX.Element{
  const [action,setAction]=useState<'recording'|'version'|'group'|'reset'>('version');
  const [query,setQuery]=useState(item.title),[page,setPage]=useState(0),[result,setResult]=useState<ListResponse>({items:[],total:0});
  const [target,setTarget]=useState<LibraryItem|null>(null),[title,setTitle]=useState(item.catalog?.releaseTitle??item.album);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const dialog=useRef<HTMLDivElement|null>(null),attempt=useRef<{identity:string;commandId:string}|null>(null);useFocus(dialog);
  useEffect(()=>{
    let alive=true;setLoading(true);
    const timer=setTimeout(()=>void window.music.list({view:'all',query,limit:50,offset:page*50}).then(value=>{if(alive){setResult(value);setLoading(false);}}).catch(e=>{if(alive){setError(String(e));setLoading(false);}}),200);
    return()=>{alive=false;clearTimeout(timer);};
  },[query,page]);
  async function confirm():Promise<void>{
    if(!item.catalog)return;
    const source={itemId:item.id,revision:item.catalog.revision};
    let operation:WithoutCommand<CatalogLinkRequest>;
    if(action==='reset')operation={action,items:[source]};
    else{
      if(!target?.catalog)return;
      const destination={itemId:target.id,revision:target.catalog.revision};
      operation=action==='group'?{action,title,items:[source,destination],releases:[
        {releaseId:item.catalog.releaseId,revision:item.catalog.releaseRevision},
        {releaseId:target.catalog.releaseId,revision:target.catalog.releaseRevision}]}:
        {action,items:[source],target:destination};
    }
    const identity=JSON.stringify(operation);
    if(attempt.current?.identity!==identity)attempt.current={identity,commandId:crypto.randomUUID()};
    setBusy(true);setError('');
    try{onDone(await window.music.linkCatalog({...operation,commandId:attempt.current.commandId} as CatalogLinkRequest));}
    catch(e){setError(e instanceof Error?e.message:String(e));setBusy(false);}
  }
  return <div className="collection-backdrop"><div className="collection-dialog catalog-dialog" role="dialog" aria-modal="true" aria-label="整理曲库关联" ref={dialog} onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
    <header><h2>整理曲库关联</h2><button disabled={busy} aria-label="关闭曲库关联" onClick={onClose}>×</button></header>
    {error&&<p className="collection-error" role="alert">{error}</p>}
    <div className="catalog-song"><Description item={item}/></div>
    {onArtists&&<button disabled={busy} onClick={onArtists}>整理艺人与署名</button>}
    {onReleases&&<button disabled={busy} onClick={onReleases}>整理发行版</button>}
    {onRecording&&<button disabled={busy} onClick={onRecording}>编辑录音资料</button>}
    {onSources&&<button disabled={busy} onClick={onSources}>查看来源与字段锁</button>}
    {onReferences&&<button disabled={busy} onClick={onReferences}>管理外部引用</button>}
    <label>关联方式<select aria-label="关联方式" value={action} disabled={busy} onChange={event=>setAction(event.target.value as typeof action)}>
      <option value="version">同一发行曲目的不同文件版本</option><option value="recording">同一录音，保留各自发行版</option>
      <option value="group">同一专辑概念的不同发行版</option><option value="reset">恢复本地候选关联</option>
    </select></label>
    <p className="collection-note">请核对曲名、演出版本、发行信息和文件路径。人工关联会保留音乐文件、标签、收藏及歌单，每次确认都可以从修订记录撤销。</p>
    {action==='reset'?<p className="collection-note">恢复这首曲目的本地扫描候选。其他文件的关联保持不变。</p>:<>
      {action==='group'&&<label>专辑概念名称<input aria-label="专辑概念名称" maxLength={240} disabled={busy} value={title} onChange={event=>setTitle(event.target.value)}/></label>}
      <label>查找关联目标<input aria-label="查找关联目标" value={query} disabled={busy} onChange={event=>{setQuery(event.target.value);setPage(0);setTarget(null);}}/></label>
      <div className="catalog-candidates" aria-label="关联候选">{loading?<p>正在查找…</p>:result.items.filter(candidate=>candidate.id!==item.id).map(candidate=><button disabled={busy} aria-pressed={candidate.id===target?.id} key={candidate.id} onClick={()=>setTarget(candidate)}><Description item={candidate}/></button>)}</div>
      <div className="catalog-pagination"><button disabled={busy||loading||page===0} onClick={()=>setPage(value=>value-1)}>上一页</button><span>{page+1} / {Math.max(1,Math.ceil(result.total/50))}</span><button disabled={busy||loading||(page+1)*50>=result.total} onClick={()=>setPage(value=>value+1)}>下一页</button></div>
      {target&&<div className="catalog-selected"><span>已选择目标</span><Description item={target}/></div>}
    </>}
    <button className="primary-button" disabled={busy||!item.catalog||(action==='reset'?!item.catalog.confirmed:!target)||(action==='group'&&(!title.trim()||target?.catalog?.releaseId===item.catalog?.releaseId))} onClick={()=>void confirm()}>{busy?'正在保存…':action==='reset'?'确认恢复候选':'确认关联'}</button>
  </div></div>;
}

export function CatalogHistoryDialog({onClose,onDone,onMetadataUndo}:{onMetadataUndo?:(id:string)=>void;onClose:()=>void;onDone:(result:CatalogChangeResult)=>void}):React.JSX.Element{
  const dialog=useRef<HTMLDivElement|null>(null),attempts=useRef(new Map<string,string>());useFocus(dialog);
  const [page,setPage]=useState(0),[result,setResult]=useState<{items:CatalogChangeSummary[];total:number}>({items:[],total:0}),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const labels={recording:'录音关联',version:'文件版本关联',reset:'恢复候选',group:'专辑概念关联',undo:'撤销修订',
    'artist-link':'艺人身份关联','artist-reset':'恢复艺人候选','artist-credit':'编辑曲目署名','credit-reset':'恢复曲目署名','release-merge':'合并发行版','release-split':'拆分发行版','artist-create':'创建艺人','artist-profile':'编辑艺人资料','artist-archive':'归档艺人','release-profile':'编辑发行资料','entity-references':'编辑实体外部引用','recording-profile':'编辑录音资料','metadata-lock':'字段锁定','metadata-select':'选择字段来源','metadata-collection':'编辑集合来源与锁','genre-create':'创建风格','genre-profile':'编辑风格层级','genre-archive':'归档或恢复风格','metadata-online':'确认在线元数据'};
  useEffect(()=>{let alive=true;void window.music.catalogChanges(50,page*50).then(value=>{if(alive)setResult(value);}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[page]);
  async function undo(changeId:string):Promise<void>{
    if(!attempts.current.has(changeId))attempts.current.set(changeId,crypto.randomUUID());
    setError('');setBusy(true);
    try{onDone(await window.music.undoCatalog(changeId,attempts.current.get(changeId)!));}
    catch(e){setError(e instanceof Error?e.message:String(e));setBusy(false);}
  }
  return <div className="collection-backdrop"><div className="collection-dialog catalog-dialog" role="dialog" aria-modal="true" aria-label="曲库修订记录" ref={dialog} onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
    <header><h2>曲库修订记录</h2><button disabled={busy} aria-label="关闭修订记录" onClick={onClose}>×</button></header>
    <p className="collection-note">撤销前会检查后续修改。重扫或再次编辑导致冲突时，请重新整理关联。</p>{error&&<p className="collection-error" role="alert">{error}</p>}
    <div className="catalog-history">{result.items.length?result.items.map(change=><div key={change.id} data-change-id={change.id}><strong>{labels[change.action]} · {change.title}</strong><small>{new Date(change.createdAt).toLocaleString()} · {change.itemCount} 首{change.undone?' · 已撤销':change.partial?' · 部分已撤销':''}</small>{!change.undone&&change.action!=='undo'&&<button disabled={busy} onClick={()=>change.action==='metadata-online'&&onMetadataUndo?onMetadataUndo(change.id):void undo(change.id)}>{change.action==='metadata-online'?'预览字段撤销':'撤销此修订'}</button>}</div>):<p>还没有曲库关联修订。</p>}</div>
    <div className="catalog-pagination"><button disabled={busy||page===0} onClick={()=>setPage(value=>value-1)}>上一页</button><span>{page+1} / {Math.max(1,Math.ceil(result.total/50))}</span><button disabled={busy||(page+1)*50>=result.total} onClick={()=>setPage(value=>value+1)}>下一页</button></div>
  </div></div>;
}

export function VersionsDialog({item,onClose,onPlay}:{item:LibraryItem;onClose:()=>void;onPlay:(item:LibraryItem)=>void}):React.JSX.Element{
  const dialog=useRef<HTMLDivElement|null>(null);useFocus(dialog);
  const [page,setPage]=useState(0),[result,setResult]=useState<ListResponse>({items:[],total:0}),[error,setError]=useState('');
  useEffect(()=>{let alive=true;void window.music.versions(item.id,50,page*50).then(value=>{if(alive)setResult(value);}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[item.id,page]);
  return <div className="collection-backdrop"><div className="collection-dialog catalog-dialog" role="dialog" aria-modal="true" aria-label="选择音乐版本" ref={dialog} onKeyDown={event=>trap(event,dialog.current,onClose)}>
    <header><h2>选择音乐版本</h2><button aria-label="关闭版本选择" onClick={onClose}>×</button></header>
    <p className="collection-note">同一发行曲目的文件版本。选择要播放的文件。</p>{error&&<p role="alert">{error}</p>}
    <div className="catalog-candidates">{result.items.map(version=><button key={version.id} disabled={!version.available} aria-label={`播放版本 ${version.title} ${version.codec}`} onClick={()=>onPlay(version)}><Description item={version}/>{!version.available&&<small>文件不可用</small>}</button>)}</div>
    <div className="catalog-pagination"><button disabled={page===0} onClick={()=>setPage(value=>value-1)}>上一页</button><span>{page+1} / {Math.max(1,Math.ceil(result.total/50))}</span><button disabled={(page+1)*50>=result.total} onClick={()=>setPage(value=>value+1)}>下一页</button></div>
  </div></div>;
}
