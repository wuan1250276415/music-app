import React,{useEffect,useRef,useState} from 'react';
import type {ArtistCandidate,CatalogChangeResult,ReleaseProfileFields,ReleaseSummary} from '../shared/contracts';
type Member=ReleaseProfileFields['albumArtists'][number]&{name:string};
const labels={title:'发行名称',date:'发行日期',country:'国家／地区',label:'发行公司',catalogNumber:'目录编号',barcode:'条码',edition:'版本说明'};
function clean(rows:Member[]):Member[]{return rows;}

export function ReleaseProfileForm({release,disabled,onBusy,onDone}:{release:ReleaseSummary;disabled:boolean;onBusy:(value:boolean)=>void;onDone:(result:CatalogChangeResult)=>void}):React.JSX.Element{
 const [fields,setFields]=useState(()=>({title:release.title,date:release.date??'',country:release.country??'',label:release.label??'',catalogNumber:release.catalogNumber??'',barcode:release.barcode??'',edition:release.edition??''}));
 const [members,setMembers]=useState<Member[]>(()=>release.albumArtists.map(member=>({artistId:member.sourceArtistId??member.id,artistRevision:member.artistRevision??0,joinPhrase:member.joinPhrase??'',...(member.creditedName?{creditedName:member.creditedName}:{}),name:member.name})));
 const [query,setQuery]=useState(''),[page,setPage]=useState(0),[result,setResult]=useState<{items:ArtistCandidate[];total:number}>({items:[],total:0});
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const attempt=useRef<{identity:string;commandId:string}|null>(null);
 useEffect(()=>{let alive=true;setLoading(true);const timer=setTimeout(()=>void window.music.artistCandidates(query,50,page*50).then(value=>{if(alive){setResult(value);setLoading(false);}}).catch(e=>{if(alive){setError(String(e));setLoading(false);}}),200);return()=>{alive=false;clearTimeout(timer);};},[query,page]);
 function choose(candidate:ArtistCandidate):void{
  if(members.some(m=>m.artistId===candidate.id)||members.length>=64)return;
  setMembers(rows=>[...rows.map((row,index)=>index===rows.length-1?{...row,joinPhrase:'、'}:row),{artistId:candidate.id,artistRevision:candidate.revision,joinPhrase:'',name:candidate.identityName}]);
 }
 function move(index:number,direction:number):void{setMembers(rows=>{const next=[...rows];[next[index],next[index+direction]]=[next[index+direction],next[index]];return clean(next);});}
 async function save():Promise<void>{
  const operation={release:{releaseId:release.releaseId,revision:release.revision,fingerprint:release.fingerprint},fields:{...fields,albumArtists:members.map(({name,...member})=>member)}};
  const identity=JSON.stringify(operation);if(attempt.current?.identity!==identity)attempt.current={identity,commandId:crypto.randomUUID()};setBusy(true);onBusy(true);setError('');
  try{onDone(await window.music.editReleaseProfile({...operation,commandId:attempt.current.commandId}));}
  catch(e){setError(e instanceof Error?e.message:String(e));setBusy(false);onBusy(false);}
 }
 return <section aria-label="发行资料编辑">
  <p className="collection-note">这些资料保存在曲库中，适用于此发行版的全部文件版本。日期可填年、年月或完整日期，如 2026、2026-09、2026-09-30。专辑艺人可留空，曲目歌手独立保留。</p>
  <div className="release-fields">{(Object.keys(labels) as Array<keyof typeof labels>).map(key=><label key={key}>{labels[key]}<input aria-label={`资料${labels[key]}`} disabled={busy||disabled} maxLength={240} value={fields[key]} onChange={event=>setFields(value=>({...value,[key]:event.target.value}))}/></label>)}</div>
  <h3>专辑艺人署名</h3>
  <div className="artist-members">{members.map((member,index)=><div key={member.artistId}>
   <strong>{member.name}</strong><input aria-label={`专辑当次署名 ${index+1}`} placeholder="跟随艺人资料" maxLength={240} disabled={busy||disabled} value={member.creditedName??''} onChange={event=>setMembers(rows=>rows.map((row,i)=>i===index?{...row,creditedName:event.target.value||undefined}:row))}/><input aria-label={`专辑连接词 ${index+1}`} value={member.joinPhrase} maxLength={80} disabled={busy||disabled} onChange={event=>setMembers(rows=>rows.map((row,i)=>i===index?{...row,joinPhrase:event.target.value}:row))}/>
   <button aria-label={`上移专辑署名 ${index+1}`} disabled={busy||disabled||index===0} onClick={()=>move(index,-1)}>↑</button><button aria-label={`下移专辑署名 ${index+1}`} disabled={busy||disabled} onClick={()=>move(index,1)}>↓</button>
   <button aria-label={`移除专辑署名 ${index+1}`} disabled={busy||disabled} onClick={()=>setMembers(rows=>clean(rows.filter((_,i)=>i!==index)))}>×</button>
  </div>)}</div>
  <p className="artist-preview">专辑署名预览：{members.map(member=>(member.creditedName??member.name)+member.joinPhrase).join('')||'未指定专辑艺人'}</p>
  <label>查找专辑艺人<input aria-label="查找专辑艺人" value={query} maxLength={256} disabled={busy||disabled} onChange={event=>{setQuery(event.target.value);setPage(0);}}/></label>
  <div className="catalog-candidates artist-candidates">{loading?<p>正在查找…</p>:result.items.map(candidate=><button data-album-artist-id={candidate.id} key={candidate.id} disabled={busy||disabled||members.length>=64||members.some(m=>m.artistId===candidate.id)} onClick={()=>choose(candidate)}><strong>{candidate.identityName}</strong><small>{candidate.disambiguation} · {candidate.context}</small></button>)}</div>
  <div className="catalog-pagination"><button disabled={busy||loading||!page} onClick={()=>setPage(p=>p-1)}>上一页专辑艺人</button><span>{page+1} / {Math.max(1,Math.ceil(result.total/50))}</span><button disabled={busy||loading||(page+1)*50>=result.total} onClick={()=>setPage(p=>p+1)}>下一页专辑艺人</button></div>
  {error&&<p className="collection-error" role="alert">{error}</p>}
  <footer><button className="primary-button" disabled={busy||disabled||!fields.title.trim()} onClick={()=>void save()}>{busy?'正在保存…':'确认保存发行资料'}</button></footer>
 </section>;
}
