import {MetadataSourcesDialog} from './metadata-sources-dialog';
import React,{useEffect,useRef,useState} from 'react';
import type {ArtistProfile,ArtistProfileDetail,ArtistProfileFields,ArtistProfileRef,ArtistProfileRequest,CatalogChangeResult} from '../shared/contracts';
import {trap,useFocus} from './dialog-focus';
const empty=():ArtistProfileFields=>({name:'',sortName:'',disambiguation:'',references:[]});
const ref=(artist:ArtistProfile):ArtistProfileRef=>({artistId:artist.artistId,revision:artist.revision,fingerprint:artist.fingerprint});
export function ArtistManagerDialog({onClose,onChanged}:{onClose:()=>void;onChanged:(result:CatalogChangeResult)=>void}):React.JSX.Element{
  const dialog=useRef<HTMLDivElement|null>(null),frozen=useRef<ArtistProfile|null>(null),attempt=useRef<{identity:string;commandId:string}|null>(null);useFocus(dialog);
  const [sourceArtist,setSourceArtist]=useState<string|null>(null);
  useEffect(()=>{if(!sourceArtist)dialog.current?.querySelector<HTMLElement>('button')?.focus();},[sourceArtist]);
  const [query,setQuery]=useState(''),[page,setPage]=useState(0),[reload,setReload]=useState(0),[profiles,setProfiles]=useState<{items:ArtistProfile[];total:number}>({items:[],total:0});
  const [selected,setSelected]=useState<string|null>(null),[creating,setCreating]=useState(false),[detail,setDetail]=useState<ArtistProfileDetail|null>(null),[itemPage,setItemPage]=useState(0);
  const [fields,setFields]=useState(empty),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[searching,setSearching]=useState(true),[stale,setStale]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let alive=true;setSearching(true);const timer=setTimeout(()=>void window.music.artistProfiles(query,50,page*50).then(value=>{if(alive){setProfiles(value);setSearching(false);}}).catch(e=>{if(alive){setError(String(e));setSearching(false);}}),200);return()=>{alive=false;clearTimeout(timer);};},[query,page,reload]);
  useEffect(()=>{
    if(!selected)return;let alive=true;setLoading(true);
    void window.music.artistProfile(selected,50,itemPage*50).then(value=>{
      if(!alive)return;
      if(frozen.current&&frozen.current.fingerprint!==value.artist.fingerprint){setStale(true);setError('艺人或成员已变化，请刷新预览后重新编辑。');}
      else{if(!frozen.current){frozen.current=value.artist;setFields({name:value.artist.name,sortName:value.artist.sortName,disambiguation:value.artist.disambiguation,references:value.artist.references});}setDetail(value);}setLoading(false);
    }).catch(e=>{if(alive){setError(String(e));setLoading(false);}});return()=>{alive=false;};
  },[selected,itemPage,reload]);
  function choose(artistId:string):void{frozen.current=null;setSelected(artistId);setCreating(false);setDetail(null);setItemPage(0);setStale(false);setError('');setReload(n=>n+1);}
  function create():void{frozen.current=null;setSelected(null);setCreating(true);setDetail(null);setFields(empty());setStale(false);setError('');setLoading(false);}
  async function submit(action:'artist-create'|'artist-profile'|'artist-archive'):Promise<void>{
    let operation:Omit<Extract<ArtistProfileRequest,{action:'artist-create'}>,'commandId'>|Omit<Extract<ArtistProfileRequest,{action:'artist-profile'}>,'commandId'>|Omit<Extract<ArtistProfileRequest,{action:'artist-archive'}>,'commandId'>;
    if(action==='artist-create')operation={action,fields};else{if(!frozen.current||stale)return;operation=action==='artist-archive'?{action,artist:ref(frozen.current)}:{action,artist:ref(frozen.current),fields};}
    const identity=JSON.stringify(operation);if(attempt.current?.identity!==identity)attempt.current={identity,commandId:crypto.randomUUID()};setBusy(true);setError('');
    try{const result=await window.music.editArtistProfile({...operation,commandId:attempt.current.commandId} as ArtistProfileRequest);onChanged(result);
      if(action==='artist-archive'){setSelected(null);setDetail(null);frozen.current=null;setCreating(false);setReload(n=>n+1);}else{setQuery(fields.name);setPage(0);choose(result.artistId!);}}
    catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  if(sourceArtist)return <MetadataSourcesDialog target={{kind:'artist',entityId:sourceArtist}} onClose={()=>{setSourceArtist(null);setReload(value=>value+1);}} onChanged={onChanged}/>;
  return <div className="collection-backdrop"><div className="collection-dialog catalog-dialog artist-manager" role="dialog" aria-modal="true" aria-label="艺人资料管理" ref={dialog} onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
    <header><h2>艺人资料管理</h2><button aria-label="关闭艺人资料" disabled={busy} onClick={onClose}>×</button></header>
    <p className="collection-note">创建独立身份后，可在“整理艺人与署名”中选择它。同名艺人允许分别保存，区分说明用于辨认。扫描标签与复合署名原文保留。</p>
    {error&&<p className="collection-error" role="alert">{error}</p>}
    <div className="artist-manager-tools"><button disabled={busy||loading||!detail} onClick={()=>detail&&setSourceArtist(detail.artist.artistId)}>来源与字段锁</button><button disabled={busy} onClick={create}>创建独立艺人</button><button disabled={busy} onClick={()=>{if(selected)choose(selected);else setReload(n=>n+1);}}>刷新艺人预览</button></div>
    <label>查找已确认身份<input aria-label="查找艺人资料" value={query} maxLength={500} disabled={busy} onChange={event=>{setQuery(event.target.value);setPage(0);}}/></label>
    <div className="catalog-candidates artist-profile-list" aria-busy={searching}>{profiles.items.map(artist=><button key={artist.artistId} data-profile-id={artist.artistId} aria-pressed={selected===artist.artistId} disabled={busy} onClick={()=>choose(artist.artistId)}><strong>{artist.name}</strong><small>{artist.disambiguation||'未填写区分说明'} · {artist.itemCount} 首 / {artist.aliasCount} 个来源候选</small></button>)}{!searching&&!profiles.items.length&&<p>没有已确认的艺人身份，可以创建一个。</p>}</div>
    <div className="catalog-pagination"><button disabled={busy||searching||!page} onClick={()=>setPage(p=>p-1)}>上一页艺人</button><span>{page+1} / {Math.max(1,Math.ceil(profiles.total/50))}</span><button disabled={busy||searching||(page+1)*50>=profiles.total} onClick={()=>setPage(p=>p+1)}>下一页艺人</button></div>
    {(creating||detail)&&<>
      <h3>{creating?'创建独立艺人':'编辑艺人资料'}</h3>
      <div className="artist-profile-fields"><label>艺人名称<input aria-label="艺人资料名称" maxLength={240} value={fields.name} disabled={busy||loading||detail?.artist.archived} onChange={event=>setFields(value=>({...value,name:event.target.value}))}/></label><label>排序名称<input aria-label="艺人排序名称" maxLength={240} value={fields.sortName} disabled={busy||loading} onChange={event=>setFields(value=>({...value,sortName:event.target.value}))}/></label><label className="artist-profile-disambiguation">区分说明<input aria-label="艺人区分说明" maxLength={240} value={fields.disambiguation} disabled={busy||loading} placeholder="例如：古典吉他演奏家" onChange={event=>setFields(value=>({...value,disambiguation:event.target.value}))}/></label></div>
      <h3>外部来源引用</h3><p className="collection-note">保存来源标识、实体 ID 与可选 HTTPS 链接。MusicBrainz 使用艺人 MBID，链接留空会自动生成；这些人工引用尚未经过联网核验。</p>
      <div className="artist-profile-refs">{fields.references.map((reference,index)=><div key={index}><label>来源<input aria-label={`引用来源 ${index+1}`} maxLength={48} disabled={busy||loading} value={reference.provider} onChange={event=>setFields(value=>({...value,references:value.references.map((r,i)=>i===index?{...r,provider:event.target.value}:r)}))}/></label><label>实体 ID<input aria-label={`引用 ID ${index+1}`} maxLength={512} disabled={busy||loading} value={reference.externalId} onChange={event=>setFields(value=>({...value,references:value.references.map((r,i)=>i===index?{...r,externalId:event.target.value}:r)}))}/></label><label className="artist-profile-url">来源链接<input aria-label={`引用链接 ${index+1}`} maxLength={2048} disabled={busy||loading} value={reference.url??''} onChange={event=>setFields(value=>({...value,references:value.references.map((r,i)=>i===index?{...r,url:event.target.value||null}:r)}))}/></label><button aria-label={`移除引用 ${index+1}`} disabled={busy||loading} onClick={()=>setFields(value=>({...value,references:value.references.filter((_,i)=>i!==index)}))}>移除</button></div>)}</div>
      <button className="release-refresh" disabled={busy||loading||fields.references.length>=32} onClick={()=>setFields(value=>({...value,references:[...value.references,{provider:'musicbrainz',externalId:'',url:null}]}))}>添加外部引用</button>
      {detail&&<>
        <p className="collection-note">关联 {detail.artist.itemCount} 首曲目 / {detail.artist.aliasCount} 个来源候选，修改将同步这些引用。</p>
        {!detail.artist.itemCount&&!detail.artist.aliasCount&&<p className="collection-note">归档会移出艺人选择列表并释放外部引用，可在修订记录中恢复。</p>}
        <div className="artist-saved-references">{detail.artist.references.filter(r=>r.url).map(r=><button key={`${r.provider}:${r.externalId}`} disabled={busy||loading||stale||detail.artist.archived} onClick={()=>void window.music.openArtistReference(ref(detail.artist),r.provider,r.externalId).catch(e=>setError(String(e)))}>打开 {r.provider} · {r.externalId}</button>)}</div>
        <div className="artist-aliases">{detail.aliases.map(alias=><p key={alias.artistId}>{alias.name}<small>{alias.context}</small></p>)}{detail.artist.aliasCount>50&&<p>当前显示前 50 个来源候选。</p>}</div>
        <div className="release-tracks" aria-label="艺人关联曲目">{loading?<p>正在读取…</p>:detail.items.map(song=><div key={song.id}><div><strong>{song.title} · {song.artist}</strong><small>{song.catalog?.releaseTitle??song.album}{!song.available?' · 文件不可用':''}</small><small className="catalog-path">{song.path}</small></div></div>)}</div>
        <div className="catalog-pagination"><button disabled={busy||loading||!itemPage} onClick={()=>setItemPage(p=>p-1)}>上一页曲目</button><span>{itemPage+1} / {Math.max(1,Math.ceil(detail.total/50))}</span><button disabled={busy||loading||(itemPage+1)*50>=detail.total} onClick={()=>setItemPage(p=>p+1)}>下一页曲目</button></div>
      </>}
    </>}
    <footer><button disabled={busy||loading||stale||!detail||detail.artist.archived||!!detail.artist.itemCount||!!detail.artist.aliasCount} title="仅可归档未被曲目或来源候选使用的身份；可在修订记录撤销" onClick={()=>void submit('artist-archive')}>归档未使用艺人</button><button className="primary-button" disabled={busy||loading||stale||!fields.name.trim()||!creating&&!detail||detail?.artist.archived} onClick={()=>void submit(creating?'artist-create':'artist-profile')}>{busy?'正在保存…':creating?'确认创建艺人':'确认保存资料'}</button></footer>
  </div></div>;
}
