import React,{useState} from 'react';
import type {MetadataMatchResult} from '../shared/contracts';
import './metadata-recording-lookup.css';
export function MetadataISRCChoice({match,busy,onChoose}:{match:MetadataMatchResult;busy:boolean;onChoose:(isrc:string)=>void}):React.JSX.Element|null {
 const lookup=match.isrcLookup;const [selected,setSelected]=useState(lookup?.selectedCode??(lookup?.codes.length===1?lookup.codes[0]:''));if(!lookup?.codes.length&&!lookup?.notices.length)return null;
 return <section className="metadata-match-reasons metadata-recording-choice" aria-label="录音编码查询"><p className="metadata-note">{lookup.source==='cue'?'当前CUE音轨':'上次扫描的文件标签'}中的录音编码，仅作为匹配依据；同一编码可能关联多个录音，发行版仍需单独审核。</p>{lookup.codes.length>0&&<><label>选择录音编码<select aria-label="选择录音编码" value={selected} disabled={busy} onChange={event=>setSelected(event.target.value)}><option value="">请选择录音编码</option>{lookup.codes.map(code=><option key={code} value={code}>{code}{lookup.selectedCode===code?' · 当前查询':''}</option>)}</select></label><button className="metadata-primary" disabled={busy||!selected} onClick={()=>onChoose(selected)}>按编码查询候选</button></>}{lookup.notices.map((notice,i)=><p className="metadata-note" key={i}>{notice}</p>)}</section>;
}
