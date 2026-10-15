import React,{useState} from 'react';
import type {FingerprintIdentification} from '../shared/audio-fingerprint';

export function MetadataBatchFingerprint({result,busy,onChoose,onClose}:{result:FingerprintIdentification;busy:boolean;onChoose:(recordingId:string)=>void;onClose:()=>void}):React.JSX.Element{
 const [page,setPage]=useState(0);
 return <details className="metadata-batch-fingerprint" open><summary>音频关联 · {result.recordings.length} 个录音</summary>
  <p>取样 {result.summary.sampledSeconds.toFixed(1)} 秒／曲目 {result.summary.durationSeconds.toFixed(1)} 秒。排序值不是匹配正确率；先选录音，再审核发行版和字段。{result.summary.sampledSeconds<20?'短片段的辨识依据较少，请仔细核对。':''}</p>
  {result.recordings.slice(page*20,(page+1)*20).map(r=><article key={r.recordingId} className="metadata-batch-fingerprint-recording">
   <strong>{r.title??'来源未提供录音标题'}</strong><p>{r.artists.join('、')||'来源未提供艺人'}{r.durationSeconds!==null?` · ${r.durationSeconds.toFixed(1)} 秒`:''} · 来源排序 {r.score.toFixed(3)}</p>
   <button disabled={busy} onClick={()=>onChoose(r.recordingId)}>读取此关联录音</button>
   <details><summary>关联标识</summary><small>录音 {r.recordingId}<br/>AcoustID {r.acoustidId}</small></details>
  </article>)}
  {!result.recordings.length&&<p>没有关联录音，当前资料保留；可以改用标题或录音编码查询。</p>}
  {result.recordings.length>20&&<div className="metadata-batch-toolbar"><button disabled={busy||page===0} onClick={()=>setPage(p=>p-1)}>上一页关联</button><span>{page*20+1}–{Math.min((page+1)*20,result.recordings.length)} / {result.recordings.length}</span><button disabled={busy||(page+1)*20>=result.recordings.length} onClick={()=>setPage(p=>p+1)}>下一页关联</button></div>}
  <p>确认期限：{new Date(result.expiresAt).toLocaleTimeString()} <button disabled={busy} onClick={onClose}>关闭此曲音频关联</button></p>
 </details>;
}
