import React,{useEffect,useRef,useState} from 'react';
import type {MetadataCandidate} from '../shared/contracts';
import type {MetadataReleaseContextResult} from '../shared/metadata-release-context';
import {releaseAudioTracks,releaseAudioTrackCount,releaseTrackLocation} from '../shared/metadata-release-context';
const duration=(ms:number|null):string=>ms===null?'时长未知':`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;
export function MetadataReleaseContextPanel({itemId,fingerprint,candidate,networkEnabled,onReview,onAlbumReview,readOnly=false}:{itemId:string;fingerprint:string;candidate:MetadataCandidate;networkEnabled:boolean;readOnly?:boolean;onReview?:(review:import('../shared/metadata-release-fields').ReleaseFieldsReview)=>void;onAlbumReview?:(header:import('../shared/metadata-album-review').MetadataAlbumReviewHeader)=>void}):React.JSX.Element{
 const [result,setResult]=useState<MetadataReleaseContextResult|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(false),generation=useRef(0),pending=useRef<string|null>(null);
 const expired=Date.parse(candidate.expiresAt??'')<=Date.now();
 function cancel():void{generation.current++;const request=pending.current;pending.current=null;if(request)void window.music.cancelMetadataMatch(request).catch(()=>{});if(alive.current)setBusy(false);}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;cancel();};},[]);
 useEffect(()=>{if(!networkEnabled){cancel();setResult(null);}},[networkEnabled]);
 useEffect(()=>{if(!result)return;const timer=setTimeout(()=>{if(alive.current){setResult(null);setError('专辑上下文已过期，请重新匹配。');}},Math.max(1,Date.parse(result.expiresAt)-Date.now()));return()=>clearTimeout(timer);},[result]);
 async function load():Promise<void>{
  if(pending.current||!networkEnabled||expired||!candidate.releaseId)return;
  const requestId=crypto.randomUUID(),epoch=++generation.current;pending.current=requestId;setBusy(true);setError('');setResult(null);
  try{const value=await window.music.metadataReleaseContext({itemId,token:candidate.token,fingerprint,requestId,...(readOnly?{readOnly:true}:{})});
   if(!alive.current||generation.current!==epoch)return;
   if(value.itemId!==itemId||value.token!==candidate.token||value.fingerprint!==fingerprint||value.requestId!==requestId||value.recordingId!==candidate.recordingId||value.context.releaseId!==candidate.releaseId.toLowerCase()||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.now())throw new Error('专辑上下文不属于当前候选或已过期');
   setResult(value);
  }catch(e){if(alive.current&&generation.current===epoch)setError(e instanceof Error?e.message:String(e));}
  finally{if(alive.current&&generation.current===epoch){pending.current=null;setBusy(false);}}
 }
 const context=result?.context,local=result?.local,tracks=context?.media.flatMap(m=>releaseAudioTracks(m).map(t=>({...t,disc:m.position})))??[],matches=tracks.filter(t=>t.recordingId===candidate.recordingId.toLowerCase()),count=context?.media.reduce((sum,m)=>sum+releaseAudioTrackCount(m),0)??0,dataCount=context?.media.reduce((sum,m)=>sum+(m.dataTracks?.length??0),0)??0;
 return <section className="metadata-release-context-panel" aria-label="专辑上下文"><button className="metadata-link" disabled={busy||!networkEnabled||expired||!candidate.releaseId} onClick={()=>void load()}>读取专辑上下文</button>
  {busy&&<><p className="metadata-note" role="status">正在读取专辑曲目表…</p><button className="metadata-link" onClick={()=>{cancel();setResult(null);setError('已取消专辑上下文查询。');}}>取消专辑上下文查询</button></>}{error&&<p className="collection-error" role="alert">{error}</p>}
  {context&&local&&result&&<><h3>{context.title}</h3><p className="metadata-note">{[context.date,context.country,context.status,context.disambiguation].filter(Boolean).join(' · ')}</p>
   <p>专辑艺人：{context.artists.map(a=>a.creditedName+a.joinPhrase).join('')}</p>{context.group&&<p>专辑概念：{context.group.title} · {[context.group.primaryType,...context.group.secondaryTypes].filter(Boolean).join(' / ')}</p>}
   {context.barcode&&<p>条码：{context.barcode}</p>}{!!context.labels.length&&<ul>{context.labels.map((v,i)=><li key={i}>{v.name}{v.catalogNumber?` · 目录号 ${v.catalogNumber}`:''}</li>)}</ul>}
   <p role="status">发行版：{context.media.length} 碟／{count} 轨（音频）{dataCount?` · 另有 ${dataCount} 条数据轨`:''}；本地专辑：{local.media.length||'未知'} 碟／{local.trackCount??'未知'} 轨</p>
   {local.trackCount!==null&&local.trackCount!==count&&<p className="collection-error">曲目数量不同；本地曲库可能不完整，也可能属于其他发行版。</p>}
   {!matches.length?<p className="collection-error">已载入的音频曲目表未找到当前录音，请核对发行版。</p>:<p className="metadata-note">当前录音位置：{matches.map(t=>releaseTrackLocation(t,t.disc)).join('、')}{matches.length>1?'；同一录音出现多次，请确认具体曲目。':''}</p>}
   {!!matches.length&&local.discNumber!==null&&local.trackNumber!==null&&!matches.some(t=>t.disc===local.discNumber&&t.position===local.trackNumber)&&<p className="collection-error">本地碟号／曲号与当前录音位置不同，请核对。</p>}
   {context.media.map(m=><details key={m.position}><summary>第 {m.position} 碟 · {m.format??'介质未知'} · {releaseAudioTrackCount(m)} 音频轨{m.title?` · ${m.title}`:''}</summary>
    {!m.trackListComplete&&<p className="collection-error">曲目表不完整：已载入 {releaseAudioTracks(m).length}／{releaseAudioTrackCount(m)} 音频轨。</p>}
    <ol className="metadata-context-tracks">{releaseAudioTracks(m).map(t=><li key={t.id} className={t.recordingId===candidate.recordingId.toLowerCase()?'chosen':''}><span>{t.kind==='pregap'?'隐藏前轨（0）':t.number} · {t.title}</span><small>{duration(t.lengthMs)}{t.recordingId===candidate.recordingId.toLowerCase()?' · 当前录音':''}</small></li>)}</ol>
    {!!m.dataTracks?.length&&<><p className="metadata-note">数据轨仅供版本核对，不作为音频曲目采用。</p><ul className="metadata-context-tracks" aria-label={`第 ${m.position} 碟数据轨`}>{m.dataTracks.map(t=><li key={t.id}><span>数据轨 {t.number} · {t.title}</span><small>{duration(t.lengthMs)}</small></li>)}</ul></>}
   </details>)}
   {!readOnly&&onAlbumReview&&result.albumReview&&<button className="metadata-primary" disabled={!networkEnabled||expired} onClick={()=>onAlbumReview(result.albumReview!)}>审核整张专辑曲目</button>}
   {!readOnly&&onReview&&result.fieldsReview&&<button className="metadata-primary" disabled={!networkEnabled||expired} onClick={()=>onReview(result.fieldsReview!)}>审核并更新发行资料</button>}
   <p className="metadata-note">曲库比较基于本次查询时的专辑信息。此处只供审核，不修改曲目归属或文件。{result.cacheHit?'资料来自短期缓存。':''}</p>
  </>}
 </section>;
}
