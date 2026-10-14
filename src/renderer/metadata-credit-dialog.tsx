import React,{useEffect,useRef,useState} from 'react';
import type {ArtistRole,CatalogChangeResult,MetadataCreditApplyRequest,MetadataCreditPreview,MetadataCreditTarget} from '../shared/contracts';
import {trap,useFocus} from './dialog-focus';
import './metadata-credit.css';
type Draft={source:'current'|'candidate';ordinal:number;role:ArtistRole|'';joinPhrase:string};
const roles:Record<ArtistRole,string>={performer:'演唱／演奏',composer:'作曲',conductor:'指挥',orchestra:'乐团',album_artist:'专辑艺人'};
const scopeName=(target:MetadataCreditTarget):string=>target.ref.kind==='playable_item'?'此歌曲署名':target.ref.kind==='recording'?'此录音署名':'发行版专辑艺人';
export function MetadataCreditDialog({itemId,token,onClose,onChanged}:{itemId:string;token:string;onClose:()=>void;onChanged:(result:CatalogChangeResult)=>void}):React.JSX.Element{
 const dialog=useRef<HTMLDivElement|null>(null),requestId=useRef<string|null>(null),libraryEvents=useRef(0),attempt=useRef<{identity:string;request:MetadataCreditApplyRequest}|null>(null);useFocus(dialog);
 const [preview,setPreview]=useState<MetadataCreditPreview|null>(null),[scope,setScope]=useState(0),[entries,setEntries]=useState<Draft[]>([]),[reload,setReload]=useState(0),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false),[now,setNow]=useState(Date.now());
 useEffect(()=>window.music.onEvent(message=>{if(message.event==='libraryChanged'){libraryEvents.current++;if(!busy)setStale(true);}if(message.event==='metadataNetwork'&&(!(message.payload as {enabled:boolean}).enabled||(message.payload as {retentionMode:string}).retentionMode!=='reviewed'))setStale(true);}),[busy]);
 useEffect(()=>{
  let alive=true;const id=crypto.randomUUID(),events=libraryEvents.current;requestId.current=id;setLoading(true);setPreview(null);setError('');setConfirmed(false);setStale(false);attempt.current=null;
  void window.music.metadataCreditPreview(itemId,token,id,reload>0).then(value=>{if(!alive||requestId.current!==id)return;setPreview(value);setScope(0);setEntries(value.targets[0].current.map((member,ordinal)=>({source:'current',ordinal,role:member.role??'',joinPhrase:member.joinPhrase??''})));setStale(events!==libraryEvents.current);setLoading(false);}).catch(e=>{if(alive){setError(e instanceof Error?e.message:String(e));setLoading(false);}});
  return()=>{alive=false;if(requestId.current===id)requestId.current=null;void window.music.cancelMetadataMatch(id).catch(()=>{});};
 },[itemId,token,reload]);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(timer);},[]);
 const target=preview?.targets[scope],expired=Boolean(preview&&Date.parse(preview.expiresAt)<=now);
 function selectScope(index:number):void{if(!preview)return;setScope(index);setEntries(preview.targets[index].current.map((member,ordinal)=>({source:'current',ordinal,role:member.role??'',joinPhrase:member.joinPhrase??''})));setConfirmed(false);attempt.current=null;setError('');}
 function toggle(source:Draft['source'],ordinal:number,checked:boolean):void{
  if(!target)return;setConfirmed(false);if(!checked){setEntries(values=>values.filter(value=>value.source!==source||value.ordinal!==ordinal));return;}if(entries.length>=64){setError('每次最多确认 64 个成员。');return;}
  const value=source==='current'?target.current[ordinal]:target.candidates[ordinal];setEntries(values=>[...values,{source,ordinal,role:source==='current'?target.current[ordinal].role??'':target.ref.kind==='release'?'album_artist':'',joinPhrase:value.joinPhrase??''}]);
 }
 function change(index:number,values:Partial<Draft>):void{setConfirmed(false);setEntries(rows=>rows.map((row,i)=>i===index?{...row,...values}:row));}
 function move(index:number,direction:number):void{setConfirmed(false);setEntries(rows=>{const next=[...rows];[next[index],next[index+direction]]=[next[index+direction],next[index]];return next;});}
 function name(entry:Draft):string{if(!target)return '';const value=entry.source==='current'?target.current[entry.ordinal]:target.candidates[entry.ordinal];return value.creditedName??value.name;}
 async function save():Promise<void>{
  if(!preview||!target||busy||!confirmed||stale||entries.some(value=>!value.role))return;
  const operation={itemId,token:preview.token,ref:target.ref,entries:entries.map(entry=>({...entry,role:entry.role as ArtistRole,...(entry.source==='candidate'?{identityFingerprint:target.candidates[entry.ordinal].identityFingerprint}:{})}))};const identity=JSON.stringify(operation);
  if(attempt.current?.identity!==identity)attempt.current={identity,request:{...operation,commandId:crypto.randomUUID()}};
  setBusy(true);setError('');try{onChanged(await window.music.metadataCreditApply(attempt.current.request));}catch(e){setError(e instanceof Error?e.message:String(e));setBusy(false);}
 }
 const invalid=entries.length===0||!entries.some(value=>value.source==='candidate')||entries.some(value=>!value.role);
 return <div className="collection-backdrop"><div className="collection-dialog catalog-dialog metadata-credit-dialog" ref={dialog} role="dialog" aria-modal="true" aria-label="在线署名审核" onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
  <header><h2>审核在线署名</h2><button aria-label="关闭在线署名审核" disabled={busy} onClick={onClose}>×</button></header>
  <p className="collection-note">主署名可以使用不同于艺人资料的名称。请明确选择本地角色，并核对保留的成员和顺序；同名艺人不会自动合并。</p>
  <button disabled={busy||loading} onClick={()=>setReload(value=>value+1)}>重新读取署名与预览</button>{loading&&<p role="status">正在读取录音和专辑署名…</p>}
  {preview&&target&&<>
   <fieldset className="metadata-credit-scopes" disabled={busy||stale||expired}><legend>更新范围</legend>{preview.targets.map((value,index)=><label key={`${value.ref.kind}:${value.ref.entityId}`}><input type="radio" name="credit-scope" checked={scope===index} onChange={()=>selectScope(index)}/><span>{scopeName(value)}<small>{value.title} · 影响 {value.itemCount} 首{value.locked?' · 已锁定':''}</small></span></label>)}</fieldset>
   <p className="collection-note">候选录音：{preview.recordingTitle}{preview.releaseTitle?`；候选发行版：${preview.releaseTitle}`:''}。只修改所选范围的署名，确认前请核对本地归属。{target.locked?' 此集合或歌手展示字段已锁定，请先到来源页解除。':''}</p>
   <div className="metadata-credit-columns"><section><h3>本地成员</h3>{target.current.map((value,ordinal)=><label key={ordinal} className="metadata-credit-choice"><input type="checkbox" disabled={busy||stale||expired||target.locked} checked={entries.some(entry=>entry.source==='current'&&entry.ordinal===ordinal)} onChange={event=>toggle('current',ordinal,event.target.checked)}/><span>{value.creditedName??value.name}<small>{value.creditedName&&value.creditedName!==value.name?`艺人资料：${value.name} · `:''}{value.role?roles[value.role]:''}</small></span></label>)}{!target.current.length&&<p>没有本地署名成员。</p>}</section>
    <section><h3>候选成员</h3>{target.candidates.map((value,ordinal)=><label key={ordinal} className="metadata-credit-choice"><input type="checkbox" disabled={busy||stale||expired||target.locked||value.archived} checked={entries.some(entry=>entry.source==='candidate'&&entry.ordinal===ordinal)} onChange={event=>toggle('candidate',ordinal,event.target.checked)}/><span>{value.creditedName}<small>艺人：{value.name}{value.disambiguation?` · ${value.disambiguation}`:''}<br/>{value.archived?'本地身份已归档，需先恢复':value.localArtistId?`复用已关联的艺人资料：${value.localName}`:'将创建独立艺人资料'}</small></span></label>)}{!target.candidates.length&&<p>所选候选没有提供该范围的完整署名。</p>}</section></div>
   <h3>所选成员与显示顺序</h3><p className="collection-note">连接词跟随成员移动，支持尾部文本。取消选择或改变顺序后，请核对预览中的空格和连接词。</p>
   {target.ref.kind!=='release'&&<label className="metadata-credit-bulk-role">设置所选候选角色<select disabled={busy||stale||expired||target.locked} value="" onChange={event=>{const role=event.target.value as ArtistRole;if(role){setConfirmed(false);setEntries(values=>values.map(value=>value.source==='candidate'?{...value,role}:value));}}}><option value="">选择角色…</option>{Object.entries(roles).filter(([role])=>role!=='album_artist').map(([role,label])=><option key={role} value={role}>{label}</option>)}</select></label>}
   <div className="metadata-credit-draft">{entries.map((entry,index)=><div key={`${entry.source}:${entry.ordinal}`}><strong>{name(entry)}<small>{entry.source==='current'?'本地':'候选'}</small></strong><select aria-label={`审核署名角色 ${index+1}`} disabled={busy||stale||expired||target.locked} value={entry.role} onChange={event=>change(index,{role:event.target.value as ArtistRole})}><option value="">请选择角色</option>{Object.entries(roles).filter(([role])=>(role==='album_artist')===(target.ref.kind==='release')).map(([role,label])=><option key={role} value={role}>{label}</option>)}</select><input aria-label={`审核连接词 ${index+1}`} maxLength={80} disabled={busy||stale||expired||target.locked} value={entry.joinPhrase} onChange={event=>change(index,{joinPhrase:event.target.value})}/><button disabled={busy||stale||expired||index===0} aria-label={`上移审核成员 ${index+1}`} onClick={()=>move(index,-1)}>↑</button><button disabled={busy||stale||expired||index===entries.length-1} aria-label={`下移审核成员 ${index+1}`} onClick={()=>move(index,1)}>↓</button><button disabled={busy||stale||expired} aria-label={`取消审核成员 ${index+1}`} onClick={()=>toggle(entry.source,entry.ordinal,false)}>×</button></div>)}</div>
   <div className="metadata-history-preview" aria-live="polite">{Object.entries(roles).filter(([role])=>entries.some(entry=>entry.role===role)).map(([role,label])=><p key={role}>{label}：{entries.filter(entry=>entry.role===role).map(entry=>name(entry)+entry.joinPhrase).join('')}</p>)}{entries.some(value=>!value.role)&&<p>请为尚未确定的成员选择本地角色。</p>}</div>
   <label className="metadata-credit-confirm"><input type="checkbox" disabled={busy||stale||expired||target.locked||invalid} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>我已核对范围、成员、角色和显示顺序（影响 {target.itemCount} 首）</label>
   <p className="collection-note">来源原文与本次选择分别记录。保存后可在曲库修订记录撤销；新增艺人资料与已读取的来源记录会保留。不会写入音乐文件。</p>
   <button className="metadata-link" onClick={()=>void window.music.openMetadataSource(target.ref.kind==='release'?preview.releaseUrl??preview.sourceUrl:preview.sourceUrl).catch(e=>setError(String(e)))}>查看署名来源</button>
  </>}
  {stale&&<p className="collection-error" role="alert">曲库或在线设置已变化，请重新读取预览。</p>}{expired&&<p className="collection-error" role="alert">候选确认期限已过，请重新读取预览。</p>}{error&&<p className="collection-error" role="alert">{error}</p>}
  <footer><button disabled={busy} onClick={onClose}>{loading?'取消读取':'取消'}</button><button className="primary-button" disabled={busy||loading||stale||!confirmed||invalid||target?.locked||expired&&!attempt.current} onClick={()=>void save()}>{busy?'正在保存…':'确认更新所选署名'}</button></footer>
 </div></div>;
}
