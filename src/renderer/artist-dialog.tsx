import React,{useEffect,useRef,useState} from 'react';
import type {ArtistCandidate,ArtistEditRequest,ArtistRole,LibraryItem,CatalogChangeResult} from '../shared/contracts';
import {useFocus,trap} from './dialog-focus';
type Member={artistId:string;artistRevision:number;name:string;role:ArtistRole;joinPhrase:string;creditedName?:string|null};
const roles:Record<ArtistRole,string>={performer:'曲目歌手',album_artist:'专辑艺人',composer:'作曲',conductor:'指挥',orchestra:'乐团'};
type WithoutCommand<T>=T extends unknown?Omit<T,'commandId'>:never;
function cleanLast(members:Member[]):Member[]{return members;}
export function ArtistDialog({item,onClose,onDone,onManage}:{item:LibraryItem;onClose:()=>void;onDone:(result:CatalogChangeResult)=>void;onManage?:()=>void}):React.JSX.Element{
  const [mode,setMode]=useState<'credit'|'identity'>('credit'),[select,setSelect]=useState<'source'|'target'>('source');
  const [source,setSource]=useState<ArtistCandidate|null>(null),[target,setTarget]=useState<ArtistCandidate|null>(null);
  const [members,setMembers]=useState<Member[]>(()=>cleanLast((item.catalog?.artists??[]).map(member=>({artistId:member.sourceArtistId??member.id,artistRevision:member.artistRevision??0,name:member.name,role:member.role,joinPhrase:member.joinPhrase??'',...(member.creditedName?{creditedName:member.creditedName}:{})}))));
  const [query,setQuery]=useState(''),[page,setPage]=useState(0),[result,setResult]=useState<{items:ArtistCandidate[];total:number}>({items:[],total:0});
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const dialog=useRef<HTMLDivElement|null>(null),attempt=useRef<{identity:string;commandId:string}|null>(null);useFocus(dialog);
  useEffect(()=>{
    let alive=true;setLoading(true);
    const timer=setTimeout(()=>void window.music.artistCandidates(query,50,page*50).then(value=>{if(alive){setResult(value);setLoading(false);}}).catch(e=>{if(alive){setError(String(e));setLoading(false);}}),200);
    return()=>{alive=false;clearTimeout(timer);};
  },[query,page]);
  async function submit(request:WithoutCommand<ArtistEditRequest>):Promise<void>{
    const identity=JSON.stringify(request);
    if(attempt.current?.identity!==identity)attempt.current={identity,commandId:crypto.randomUUID()};
    setBusy(true);setError('');
    try{onDone(await window.music.editArtists({...request,commandId:attempt.current.commandId} as ArtistEditRequest));}
    catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  function choose(candidate:ArtistCandidate):void{
    if(mode==='identity'){if(select==='source')setSource(candidate);else setTarget(candidate);return;}
    setMembers(previous=>{
      if(previous.some(member=>member.artistId===candidate.id&&member.role==='performer'))return previous;
      const next=previous.map(member=>({...member}));
      const last=next.map((member,index)=>member.role==='performer'?index:-1).filter(index=>index>=0).at(-1)??-1;if(last>=0&&!next[last].joinPhrase)next[last].joinPhrase='、';
      return [...next,{artistId:candidate.id,artistRevision:candidate.revision,name:candidate.identityName,role:'performer',joinPhrase:''}];
    });
  }
  function update(index:number,change:Partial<Member>):void{setMembers(previous=>previous.map((member,i)=>i===index?{...member,...change}:member));}
  function move(index:number,direction:-1|1):void{
    setMembers(previous=>{const next=[...previous];[next[index],next[index+direction]]=[next[index+direction],next[index]];return next;});
  }
  return <div className="collection-backdrop"><div className="collection-dialog catalog-dialog artist-dialog" role="dialog" aria-modal="true" aria-labelledby="artist-dialog-title" ref={dialog} onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
    <header><h2 id="artist-dialog-title">整理艺人与署名</h2><button disabled={busy} aria-label="关闭艺人整理" onClick={onClose}>×</button></header>
    <p className="collection-note">{item.title} · {item.artist}<br/>人工确认保存在曲库，重新扫描后保留。</p>
    {onManage&&<button className="release-refresh" disabled={busy} onClick={onManage}>创建或管理艺人资料</button>}
    <fieldset disabled={busy} className="artist-mode"><legend>整理内容</legend><label><input type="radio" checked={mode==='credit'} onChange={()=>setMode('credit')}/>此曲署名</label><label><input type="radio" checked={mode==='identity'} onChange={()=>setMode('identity')}/>跨目录艺人身份</label></fieldset>
    {mode==='credit'?<><p className="collection-note">按顺序编辑歌手及参与角色。连接词显示在此歌手之后，例如 “ feat. ”。可保留实际尾部连接文本；专辑艺人保留发行版署名。</p>
      <div className="artist-members">{members.map((member,index)=><div key={`${member.artistId}:${index}`}>
        <strong>{member.name}</strong><input aria-label={`当次署名 ${index+1}`} placeholder="跟随艺人资料" maxLength={240} disabled={busy} value={member.creditedName??''} onChange={event=>update(index,{creditedName:event.target.value||undefined})}/><select aria-label={`署名角色 ${index+1}`} disabled={busy} value={member.role} onChange={event=>update(index,{role:event.target.value as ArtistRole})}>{Object.entries(roles).filter(([role])=>role!=='album_artist').map(([role,label])=><option key={role} value={role}>{label}</option>)}</select>
        <input aria-label={`连接词 ${index+1}`} value={member.joinPhrase} maxLength={80} disabled={busy} onChange={event=>update(index,{joinPhrase:event.target.value})}/>
        <button aria-label={`上移署名 ${index+1}`} disabled={busy||index===0} onClick={()=>move(index,-1)}>↑</button><button aria-label={`下移署名 ${index+1}`} disabled={busy||index===members.length-1} onClick={()=>move(index,1)}>↓</button>
        <button aria-label={`移除署名 ${index+1}`} disabled={busy} onClick={()=>setMembers(previous=>cleanLast(previous.filter((_,i)=>i!==index)))}>×</button>
      </div>)}</div><p className="artist-preview">显示预览：{members.filter(member=>member.role==='performer').map(member=>(member.creditedName??member.name)+member.joinPhrase).join('')||'请添加曲目歌手'}</p></>:
      <><p className="collection-note">关联会影响使用这些候选身份的所有曲目和专辑艺人。相同姓名不会自动关联；确认前请核对目录与来源。已确认身份可作为目标。</p>
        <label>当前选择<select aria-label="艺人选择位置" disabled={busy} value={select} onChange={event=>setSelect(event.target.value as 'source'|'target')}><option value="source">来源候选</option><option value="target">目标身份</option></select></label>
        <div className="artist-selection"><p>来源：{source?`${source.name} · ${source.context}`:'请选择来源候选'}</p><p>目标：{target?`${target.identityName} · ${target.context}`:'请选择目标身份'}</p></div></>}
    <label>查找艺人<input aria-label="查找艺人候选" value={query} maxLength={256} disabled={busy} onChange={event=>{setQuery(event.target.value);setPage(0);}}/></label>
    <div className="catalog-candidates artist-candidates" aria-busy={loading}>{result.items.map(candidate=><button key={candidate.id} data-artist-id={candidate.id} disabled={busy||mode==='identity'&&select==='source'&&candidate.confirmed} onClick={()=>choose(candidate)}>
      <strong>{candidate.name}{candidate.identityId!==candidate.id?` → ${candidate.identityName}`:''}</strong><small>{candidate.confirmed?'人工确认身份':'本地标签候选'} · {candidate.count} 首关联曲目</small><small className="catalog-path">{candidate.context}</small>
      {candidate.disambiguation&&!['local-tag-candidate','user-confirmed'].includes(candidate.disambiguation)&&<small>{candidate.disambiguation}</small>}
    </button>)}{!loading&&!result.items.length&&<p>没有找到艺人候选。</p>}</div>
    <div className="catalog-pagination"><button disabled={busy||page===0} onClick={()=>setPage(value=>value-1)}>上一页</button><span>{page+1} / {Math.max(1,Math.ceil(result.total/50))}</span><button disabled={busy||(page+1)*50>=result.total} onClick={()=>setPage(value=>value+1)}>下一页</button></div>
    {error&&<p role="alert" className="collection-error">{error}</p>}
    <footer>{mode==='credit'?<><button disabled={busy||!item.catalog?.creditConfirmed} onClick={()=>void submit({action:'credit-reset',itemId:item.id,revision:item.catalog!.revision})}>恢复本地署名</button><button disabled={busy||!members.length} onClick={()=>void submit({action:'artist-credit',itemId:item.id,revision:item.catalog!.revision,members:members.map(({name,...member})=>member)})}>确认保存署名</button></>:
      <><button disabled={busy||!source||source.identityId===source.id} onClick={()=>source&&void submit({action:'artist-reset',sources:[{artistId:source.id,revision:source.revision}]})}>解除来源关联</button><button disabled={busy||!source||!target||source.id===target.id} onClick={()=>source&&target&&void submit({action:'artist-link',sources:[{artistId:source.id,revision:source.revision}],target:{artistId:target.id,revision:target.revision}})}>确认艺人身份</button></>}</footer>
  </div></div>;
}
