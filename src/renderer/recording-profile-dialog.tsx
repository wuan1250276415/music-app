import React,{useEffect,useRef,useState} from 'react';
import type {ArtistCandidate,CatalogChangeResult,LibraryItem,RecordingProfile,RecordingProfileFields} from '../shared/contracts';
import {trap,useFocus} from './dialog-focus';
type Member=RecordingProfileFields['artists'][number]&{name:string};
const roles={performer:'演唱／演奏',composer:'作曲',conductor:'指挥',orchestra:'乐团'};
function clean(rows:Member[]):Member[]{return rows;}
function seconds(value:number|null):string{if(value===null)return '';const whole=Math.trunc(value/1000000),fraction=String(value%1000000).padStart(6,'0').replace(/0+$/,'');return fraction?`${whole}.${fraction}`:String(whole);}
function micros(value:string):number|null{
 if(!value.trim())return null;const match=/^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());if(!match||match[1].length>16)throw new Error('参考时长填写非负秒数，最多六位小数，或留空');
 const result=BigInt(match[1])*1000000n+BigInt((match[2]??'').padEnd(6,'0'));if(result>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('参考时长超出支持范围');return Number(result);
}
export function RecordingProfileDialog({item,onClose,onDone}:{item:LibraryItem;onClose:()=>void;onDone:(result:CatalogChangeResult)=>void}):React.JSX.Element{
 const dialog=useRef<HTMLDivElement|null>(null);useFocus(dialog);const attempt=useRef<{identity:string;commandId:string}|null>(null);
 const [profile,setProfile]=useState<RecordingProfile|null>(null),[reload,setReload]=useState(0),[title,setTitle]=useState(''),[versionLabel,setVersionLabel]=useState(''),[duration,setDuration]=useState(''),[members,setMembers]=useState<Member[]>([]);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState(''),[page,setPage]=useState(0),[searching,setSearching]=useState(true),[candidates,setCandidates]=useState<{items:ArtistCandidate[];total:number}>({items:[],total:0});
 useEffect(()=>{let alive=true;setLoading(true);setError('');setProfile(null);void window.music.recordingProfile(item.catalog!.recordingId).then(p=>{if(alive){setProfile(p);setTitle(p.title);setVersionLabel(p.versionLabel);setDuration(seconds(p.durationUs));setMembers(p.artists.filter(m=>m.role!=='album_artist').map(m=>({artistId:m.sourceArtistId??m.id,artistRevision:m.artistRevision??0,role:m.role as Member['role'],joinPhrase:m.joinPhrase??'',...(m.creditedName?{creditedName:m.creditedName}:{}),name:m.name})));setLoading(false);}}).catch(e=>{if(alive){setError(String(e));setLoading(false);}});return()=>{alive=false;};},[item.id,reload]);
 useEffect(()=>{let alive=true;setSearching(true);const timer=setTimeout(()=>void window.music.artistCandidates(query,50,page*50).then(value=>{if(alive){setCandidates(value);setSearching(false);}}).catch(e=>{if(alive){setError(String(e));setSearching(false);}}),200);return()=>{alive=false;clearTimeout(timer);};},[query,page]);
 function choose(candidate:ArtistCandidate):void{
  if(members.length>=64||members.some(m=>m.artistId===candidate.id&&m.role==='performer'))return;
  setMembers(rows=>{let last=-1;rows.forEach((member,index)=>{if(member.role==='performer')last=index;});return [...rows.map((row,i)=>i===last?{...row,joinPhrase:'、'}:row),{artistId:candidate.id,artistRevision:candidate.revision,role:'performer',joinPhrase:'',name:candidate.identityName}];});
 }
 function move(index:number,direction:number):void{setMembers(rows=>{const next=[...rows];[next[index],next[index+direction]]=[next[index+direction],next[index]];return clean(next);});}
 async function save():Promise<void>{
  if(!profile)return;setError('');
  try{const operation={recording:{recordingId:profile.recordingId,revision:profile.revision,fingerprint:profile.fingerprint},fields:{title,versionLabel,durationUs:micros(duration),artists:members.map(({name,...member})=>member)}};
   const identity=JSON.stringify(operation);if(attempt.current?.identity!==identity)attempt.current={identity,commandId:crypto.randomUUID()};setBusy(true);
   onDone(await window.music.editRecordingProfile({...operation,commandId:attempt.current.commandId}));
  }catch(e){setError(e instanceof Error?e.message:String(e));setBusy(false);}
 }
 return <div className="collection-backdrop"><div className="collection-dialog catalog-dialog artist-manager" role="dialog" aria-label="录音资料编辑" aria-modal="true" ref={dialog} onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
  <header><h2>编辑录音资料</h2><button aria-label="关闭录音资料" disabled={busy} onClick={onClose}>×</button></header>
  <p className="collection-note">同一录音可出现在多个发行版中；这里保存录音名称、版本和署名，发行曲目的名称与歌手分别保留。参考时长只用于资料展示，播放仍以音乐文件和曲目范围为准。</p>
  <button className="release-refresh" disabled={busy} onClick={()=>setReload(r=>r+1)}>刷新录音预览</button>
  {loading?<p>正在读取…</p>:profile?<>
   <div className="catalog-song"><strong>{profile.title}</strong><small>{profile.itemCount} 个文件 · {profile.releaseCount} 个发行版 · {profile.confirmed?'已确认录音资料':'本地录音候选'}</small></div>
   <div className="release-fields"><label>录音名称<input aria-label="录音名称" maxLength={240} disabled={busy} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>录音版本说明<input aria-label="录音版本说明" maxLength={240} disabled={busy} value={versionLabel} placeholder="如现场、混音、剪辑版" onChange={e=>setVersionLabel(e.target.value)}/></label><label>参考时长（秒）<input aria-label="录音参考时长" maxLength={24} inputMode="decimal" disabled={busy} value={duration} onChange={e=>setDuration(e.target.value)}/></label></div>
   <h3>录音署名</h3><div className="artist-members">{members.map((member,index)=><div key={`${member.artistId}:${index}`}>
    <strong>{member.name}</strong><input aria-label={`录音当次署名 ${index+1}`} placeholder="跟随艺人资料" maxLength={240} disabled={busy} value={member.creditedName??''} onChange={e=>setMembers(rows=>rows.map((row,i)=>i===index?{...row,creditedName:e.target.value||undefined}:row))}/><select aria-label={`录音角色 ${index+1}`} disabled={busy} value={member.role} onChange={e=>setMembers(rows=>clean(rows.map((row,i)=>i===index?{...row,role:e.target.value as Member['role']}:row)))}>{Object.entries(roles).map(([role,label])=><option key={role} value={role}>{label}</option>)}</select>
    <input aria-label={`录音连接词 ${index+1}`} maxLength={80} disabled={busy} value={member.joinPhrase} onChange={e=>setMembers(rows=>rows.map((row,i)=>i===index?{...row,joinPhrase:e.target.value}:row))}/>
    <button aria-label={`上移录音署名 ${index+1}`} disabled={busy||index===0} onClick={()=>move(index,-1)}>↑</button><button aria-label={`下移录音署名 ${index+1}`} disabled={busy||index===members.length-1} onClick={()=>move(index,1)}>↓</button><button aria-label={`移除录音署名 ${index+1}`} disabled={busy} onClick={()=>setMembers(rows=>clean(rows.filter((_,i)=>i!==index)))}>×</button>
   </div>)}</div>
   <p className="artist-preview">录音演出署名：{members.filter(m=>m.role==='performer').map(m=>(m.creditedName??m.name)+m.joinPhrase).join('')||'未指定'}</p>
   <label>查找录音艺人<input aria-label="查找录音艺人" maxLength={256} disabled={busy} value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/></label>
   <div className="catalog-candidates artist-candidates">{searching?<p>正在查找…</p>:candidates.items.map(candidate=><button key={candidate.id} disabled={busy||members.length>=64||members.some(m=>m.artistId===candidate.id&&m.role==='performer')} onClick={()=>choose(candidate)}><strong>{candidate.identityName}</strong><small>{candidate.disambiguation} · {candidate.context}</small></button>)}</div>
   <div className="catalog-pagination"><button disabled={busy||searching||!page} onClick={()=>setPage(p=>p-1)}>上一页录音艺人</button><span>{page+1} / {Math.max(1,Math.ceil(candidates.total/50))}</span><button disabled={busy||searching||(page+1)*50>=candidates.total} onClick={()=>setPage(p=>p+1)}>下一页录音艺人</button></div>
  </>:null}
  {error&&<p className="collection-error" role="alert">{error}</p>}
  <footer><button disabled={busy} onClick={onClose}>关闭</button><button className="primary-button" disabled={busy||loading||!profile||!title.trim()} onClick={()=>void save()}>{busy?'正在保存…':'确认保存录音资料'}</button></footer>
 </div></div>;
}
