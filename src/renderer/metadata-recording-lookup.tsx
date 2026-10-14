import React,{useState} from 'react';
import './metadata-recording-lookup.css';
import type {MetadataMatchResult} from '../shared/contracts';
export function MetadataRecordingLookup({match,busy,onChoose}:{match:MetadataMatchResult;busy:boolean;onChoose:(recordingId:string)=>void}):React.JSX.Element|null {
 const lookup=match.recordingLookup;const [selected,setSelected]=useState(lookup?.selectedId??'');if(!lookup?.references.length)return null;
 return <section className="metadata-match-reasons metadata-recording-choice" aria-label="已确认录音查询"><p className="metadata-note">本地已确认 {lookup.references.length} 个录音标识。{lookup.requiresChoice?'请选择本次读取的录音标识。':lookup.selectedId?'本次按已确认录音读取资料。':'本次按录音编码查询，已确认录音标识保持。'}具体发行版仍需单独核对。</p>
 {lookup.references.length>1&&<><label>选择已确认录音<select aria-label="选择已确认录音" value={selected} onChange={event=>setSelected(event.target.value)} disabled={busy}><option value="">请选择录音标识</option>{lookup.references.map(id=><option key={id} value={id}>{id}{lookup.selectedId===id?' · 当前读取':''}</option>)}</select></label><button className="metadata-primary" disabled={busy||!selected} onClick={()=>onChoose(selected)}>读取所选录音</button></>}
 </section>;
}
