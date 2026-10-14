import React,{useEffect,useRef,useState} from 'react';
import type {CatalogChangeResult,LibraryItem,ReleaseDetail,ReleaseEditRequest,ReleaseRef,ReleaseSummary} from '../shared/contracts';
import {trap,useFocus} from './dialog-focus';
import {ReleaseProfileForm} from './release-profile-form';
type Mapping={releaseId:string;sourceDisc:number;targetDisc:number};
const ref=(r:ReleaseSummary):ReleaseRef=>({releaseId:r.releaseId,revision:r.revision,fingerprint:r.fingerprint});
function Summary({release}:{release:ReleaseSummary}):React.JSX.Element{
  return <><strong>{release.title} · {release.albumArtist||'艺人未知'}</strong><small>{[release.date,release.country,release.edition].filter(Boolean).join(' · ')||'未填写发行信息'} · {release.trackCount} 首 / {release.fileCount} 个文件</small><small className="catalog-path">{release.context}</small></>;
}
export function ReleaseDialog({item,onClose,onDone}:{item:LibraryItem;onClose:()=>void;onDone:(result:CatalogChangeResult)=>void}):React.JSX.Element{
  const dialog=useRef<HTMLDivElement|null>(null),attempt=useRef<{identity:string;commandId:string}|null>(null),frozen=useRef<ReleaseSummary|null>(null);useFocus(dialog);
  const [mode,setMode]=useState<'release-merge'|'release-split'|'release-profile'>('release-merge'),[detail,setDetail]=useState<ReleaseDetail|null>(null);
  const [page,setPage]=useState(0),[reload,setReload]=useState(0),[selected,setSelected]=useState(new Set<string>());
  const [query,setQuery]=useState(item.catalog?.releaseTitle??item.album),[candidatePage,setCandidatePage]=useState(0),[candidates,setCandidates]=useState<{items:ReleaseSummary[];total:number}>({items:[],total:0});
  const [target,setTarget]=useState<ReleaseSummary|null>(null),[mapping,setMapping]=useState<Mapping[]>([]);
  const [fields,setFields]=useState({title:item.catalog?.releaseTitle??item.album,date:item.catalog?.releaseDate??'',country:item.catalog?.country??'',edition:item.catalog?.edition??''});
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[searching,setSearching]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    let alive=true;setLoading(true);
    void window.music.releaseDetail(item.catalog!.releaseId,50,page*50).then(value=>{
      if(!alive)return;
      if(frozen.current&&frozen.current.fingerprint!==value.release.fingerprint){setStale(true);setError('发行成员已变化，请刷新预览后重新选择。');}
      else{frozen.current??=value.release;setDetail(value);}setLoading(false);
    }).catch(e=>{if(alive){setError(String(e));setLoading(false);}});
    return()=>{alive=false;};
  },[item.id,page,reload]);
  useEffect(()=>{
    let alive=true;setSearching(true);const timer=setTimeout(()=>void window.music.releaseCandidates(query,50,candidatePage*50).then(value=>{if(alive){setCandidates(value);setSearching(false);}}).catch(e=>{if(alive){setError(String(e));setSearching(false);}}),200);
    return()=>{alive=false;clearTimeout(timer);};
  },[query,candidatePage,reload]);
  function choose(value:ReleaseSummary):void{
    setTarget(value);const source=frozen.current!;const max=Math.max(...value.media.map(m=>m.discNumber),0);
    setMapping([...value.media.map(m=>({releaseId:value.releaseId,sourceDisc:m.discNumber,targetDisc:m.discNumber})),
      ...source.media.map((m,index)=>({releaseId:source.releaseId,sourceDisc:m.discNumber,targetDisc:max+index+1}))]);
  }
  function refresh():void{frozen.current=null;setDetail(null);setTarget(null);setMapping([]);setSelected(new Set());setStale(false);setError('');setPage(0);setReload(v=>v+1);}
  async function save():Promise<void>{
    if(mode==='release-profile')return;
    const source=frozen.current;if(!source||stale)return;
    let operation:Omit<Extract<ReleaseEditRequest,{action:'release-merge'}>,'commandId'>|Omit<Extract<ReleaseEditRequest,{action:'release-split'}>,'commandId'>;
    if(mode==='release-merge'){if(!target)return;operation={action:mode,sources:[ref(source)],target:ref(target),discMap:mapping};}
    else operation={action:mode,source:ref(source),trackIds:[...selected],fields};
    const identity=JSON.stringify(operation);if(attempt.current?.identity!==identity)attempt.current={identity,commandId:crypto.randomUUID()};
    setBusy(true);setError('');try{onDone(await window.music.editReleases({...operation,commandId:attempt.current.commandId} as ReleaseEditRequest));}
    catch(e){setError(e instanceof Error?e.message:String(e));setBusy(false);}
  }
  return <div className="collection-backdrop"><div className="collection-dialog catalog-dialog release-dialog" role="dialog" aria-modal="true" aria-label="整理发行版" ref={dialog} onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
    <header><h2>整理发行版</h2><button aria-label="关闭发行整理" disabled={busy} onClick={onClose}>×</button></header>
    <p className="collection-note">保留文件、原始标签、收藏、歌单和录音身份。同一曲目的文件版本一起移动；不同曲目不会因同名或同轨号自动合并。可在修订记录中撤销。</p>
    {error&&<p className="collection-error" role="alert">{error}</p>}
    <button className="release-refresh" disabled={busy} onClick={refresh}>刷新发行预览</button>
    {detail&&<div className="catalog-song"><Summary release={detail.release}/></div>}
    <label>整理方式<select aria-label="发行整理方式" disabled={busy} value={mode} onChange={event=>setMode(event.target.value as typeof mode)}><option value="release-merge">将整个发行版合并到所选目标</option><option value="release-split">将部分曲目拆成新发行版</option><option value="release-profile">编辑发行资料与专辑署名</option></select></label>
    {mode==='release-profile'&&detail&&<ReleaseProfileForm key={detail.release.fingerprint} release={detail.release} disabled={loading||stale} onBusy={setBusy} onDone={onDone}/>}
    {mode!=='release-profile'&&<>
    {mode==='release-merge'?<>
      <label>查找目标发行版<input aria-label="查找目标发行版" value={query} disabled={busy} onChange={event=>{setQuery(event.target.value);setCandidatePage(0);}}/></label>
      <div className="catalog-candidates">{searching?<p>正在查找…</p>:candidates.items.filter(r=>r.releaseId!==item.catalog?.releaseId).map(r=><button disabled={busy||loading||stale} key={r.releaseId} data-release-id={r.releaseId} aria-pressed={target?.releaseId===r.releaseId} onClick={()=>choose(r)}><Summary release={r}/></button>)}</div>
      <div className="catalog-pagination"><button disabled={busy||searching||!candidatePage} onClick={()=>setCandidatePage(p=>p-1)}>上一页发行</button><span>{candidatePage+1} / {Math.max(1,Math.ceil(candidates.total/50))}</span><button disabled={busy||searching||(candidatePage+1)*50>=candidates.total} onClick={()=>setCandidatePage(p=>p+1)}>下一页发行</button></div>
      {target&&<><div className="catalog-selected"><span>使用目标发行信息</span><Summary release={target}/></div><div className="release-mapping" aria-label="碟号映射">{mapping.map((m,index)=><label key={`${m.releaseId}:${m.sourceDisc}`}>{m.releaseId===target.releaseId?'目标':'来源'} CD {m.sourceDisc}<span> → CD </span><input type="number" min={1} max={9999} aria-label={`目标碟号 ${index+1}`} disabled={busy} value={m.targetDisc} onChange={event=>setMapping(rows=>rows.map((row,i)=>i===index?{...row,targetDisc:Number(event.target.value)}:row))}/></label>)}</div></>}
    </>:<>
      <div className="release-fields">{(['title','date','country','edition'] as const).map((key,index)=><label key={key}>{['新发行名称','发行日期','国家／地区','版本说明'][index]}<input aria-label={['新发行名称','发行日期','国家／地区','版本说明'][index]} maxLength={240} value={fields[key]} disabled={busy} onChange={event=>setFields(value=>({...value,[key]:event.target.value}))}/></label>)}</div>
      <p className="collection-note">按发行曲目选择，已选 {selected.size} / {detail?.total??0} 首。至少保留一首在原发行版中。</p>
    </>}
    <div className="release-tracks" aria-label="发行曲目预览">{loading?<p>正在读取…</p>:detail?.items.map(song=><div key={song.catalog!.releaseTrackId} data-release-track-id={song.catalog!.releaseTrackId}>
      {mode==='release-split'&&<input type="checkbox" aria-label={`拆分曲目 ${song.title}`} disabled={busy||stale} checked={selected.has(song.catalog!.releaseTrackId)} onChange={event=>setSelected(old=>{const next=new Set(old);if(event.target.checked)next.add(song.catalog!.releaseTrackId);else next.delete(song.catalog!.releaseTrackId);return next;})}/>}
      <div><strong>CD {song.catalog!.mediumDiscNumber} · {song.catalog!.printedNumber??song.trackNumber??'—'} · {song.title}</strong><small>{song.artist} · {song.versionCount} 个文件版本{!song.available?' · 当前文件不可用':''}</small><small className="catalog-path">{song.path}</small></div>
    </div>)}</div>
    <div className="catalog-pagination"><button disabled={busy||loading||!page} onClick={()=>setPage(p=>p-1)}>上一页曲目</button><span>{page+1} / {Math.max(1,Math.ceil((detail?.total??0)/50))}</span><button disabled={busy||loading||(page+1)*50>=(detail?.total??0)} onClick={()=>setPage(p=>p+1)}>下一页曲目</button></div>
    <footer><button disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy||loading||stale||!detail||(mode==='release-merge'?!target||mapping.some(m=>!Number.isInteger(m.targetDisc)||m.targetDisc<1||m.targetDisc>9999):!fields.title.trim()||!selected.size||selected.size>=detail.total)} onClick={()=>void save()}>{busy?'正在保存…':mode==='release-merge'?'确认合并发行版':'确认拆分发行版'}</button></footer></>}
  </div></div>;
}
