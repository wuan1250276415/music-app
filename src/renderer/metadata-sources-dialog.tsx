import React,{useEffect,useRef,useState} from 'react';
import type {CatalogChangeResult,MetadataEntityKind,MetadataSourceEntity,MetadataPolicyRef} from '../shared/contracts';
import {trap,useFocus} from './dialog-focus';
import {MetadataCollectionDialog} from './metadata-collection-dialog';
import type {MetadataCollectionKind,MetadataCollectionField} from '../shared/contracts';
import {MetadataHistoryDialog} from './metadata-history-dialog';

export type MetadataSourceTarget={itemId:string}|{kind:MetadataEntityKind;entityId:string};
const labels:Record<MetadataEntityKind,string>={playable_item:'歌曲标签／覆盖值',artist:'艺人身份',recording:'录音',release:'发行版',release_group:'专辑概念'};
const key=(entity:MetadataSourceEntity)=>`${entity.kind}:${entity.entityId}`;
const ref=(entity:MetadataSourceEntity):MetadataPolicyRef=>({kind:entity.kind,entityId:entity.entityId,revision:entity.revision,fingerprint:entity.fingerprint});
export function MetadataSourcesDialog({target,onClose,onChanged}:{target:MetadataSourceTarget;onClose:()=>void;onChanged:(result:CatalogChangeResult)=>void}):React.JSX.Element{
 const dialog=useRef<HTMLDivElement|null>(null),attempt=useRef<{identity:string;commandId:string}|null>(null);useFocus(dialog);
 const [entities,setEntities]=useState<MetadataSourceEntity[]>([]),[selected,setSelected]=useState(''),[lockDraft,setLockDraft]=useState<{fingerprint:string;values:Record<string,boolean>}>({fingerprint:'',values:{}});
 const [reload,setReload]=useState(0),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [historyField,setHistoryField]=useState<string|null>(null),[collectionField,setCollectionField]=useState<MetadataCollectionField|null>(null);
 const targetKey=JSON.stringify(target),entity=entities.find(value=>key(value)===selected);
 const locks=entity&&lockDraft.fingerprint===entity.fingerprint?lockDraft.values:{};
 useEffect(()=>{
  let alive=true;setLoading(true);setError('');
  const request='itemId' in target?window.music.metadataSources(target.itemId):window.music.metadataSource(target.kind,target.entityId).then(value=>[value]);
  void request.then(values=>{if(!alive)return;setEntities(values);setSelected(previous=>values.some(value=>key(value)===previous)?previous:values[0]?key(values[0]):'');setLoading(false);}).catch(e=>{if(alive){setEntities([]);setError(String(e));setLoading(false);}});
  return()=>{alive=false;};
 },[targetKey,reload]);
 useEffect(()=>{setLockDraft({fingerprint:entity?.fingerprint??'',values:Object.fromEntries(entity?.fields.map(field=>[field.field,field.locked])??[])});},[entity]);
 useEffect(()=>{if(historyField===null&&collectionField===null)dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();},[historyField,collectionField]);
 const changes=entity?.fields.filter(field=>locks[field.field]!==undefined&&locks[field.field]!==field.locked).map(field=>({field:field.field,locked:locks[field.field]}))??[];
 async function save():Promise<void>{
  if(!entity||!changes.length)return;const operation={entity:ref(entity),locks:changes},identity=JSON.stringify(operation);
  if(attempt.current?.identity!==identity)attempt.current={identity,commandId:crypto.randomUUID()};setBusy(true);setError('');
  try{const result=await window.music.editMetadataLocks({...operation,commandId:attempt.current.commandId});onChanged(result);setNotice('字段锁已保存，可在曲库修订记录中撤销。');setReload(value=>value+1);}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 }
 if(collectionField&&entity&&['playable_item','recording','release'].includes(entity.kind))return <MetadataCollectionDialog kind={entity.kind as MetadataCollectionKind} entityId={entity.entityId} field={collectionField} onClose={()=>setCollectionField(null)} onChanged={result=>{onChanged(result);setNotice('集合修订已保存。');setReload(value=>value+1);}}/>;
 if(historyField&&entity)return <MetadataHistoryDialog entity={entity} field={historyField} onClose={()=>setHistoryField(null)} onChanged={result=>{onChanged(result);setNotice('来源选择已保存。');setReload(value=>value+1);}}/>;
 return <div className="collection-backdrop"><div className="collection-dialog catalog-dialog metadata-sources-dialog" role="dialog" aria-modal="true" aria-label="元数据来源与字段锁" ref={dialog} onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
  <header><h2>元数据来源与字段锁</h2><button aria-label="关闭元数据来源" disabled={busy} onClick={onClose}>×</button></header>
  <p className="collection-note">锁定当前值可防止自动重扫或在线匹配覆盖；您仍可在资料编辑中主动修改。单值字段可查看历史来源；署名和风格集合可单独管理来源与锁，署名角色与连接词也可在资料编辑中调整。</p>
  <label>查看对象<select aria-label="元数据来源对象" value={selected} disabled={busy||loading} onChange={event=>{setSelected(event.target.value);setNotice('');}}>{entities.map(value=><option key={key(value)} value={key(value)}>{labels[value.kind]} · {value.title}</option>)}</select></label>
  <button className="release-refresh" disabled={busy||loading} onClick={()=>setReload(value=>value+1)}>刷新来源预览</button>
  {loading?<p>正在读取字段来源…</p>:entity?<>
   {['playable_item','recording','release'].includes(entity.kind)&&<div className="metadata-collection-actions">{(entity.kind==='release'?['albumArtists','genres']:entity.kind==='recording'?['artists']:['artists','genres']).map(value=><button key={value} disabled={busy||loading||changes.length>0} title={changes.length?'请先保存字段锁':undefined} onClick={()=>setCollectionField(value as MetadataCollectionField)}>{value==='genres'?'风格集合来源与锁':value==='albumArtists'?'专辑署名来源与锁':'有序署名来源与锁'}</button>)}</div>}
   <div className="metadata-source-fields">{entity.fields.map(field=><div key={field.field}>
    <div className="metadata-source-value"><strong>{field.label}</strong><p>{field.decisionMode==='clear'?'用户明确清空':field.value===null||field.value===''?'未填写':String(field.value)}</p></div>
    <label className="metadata-source-lock"><input type="checkbox" aria-label={`锁定 ${field.label}`} checked={locks[field.field]??field.locked} disabled={busy} onChange={event=>{setLockDraft({fingerprint:entity.fingerprint,values:{...Object.fromEntries(entity.fields.map(value=>[value.field,value.locked])),...locks,[field.field]:event.target.checked}});setNotice('');}}/>锁定当前值</label>
    <small>{field.source} · {field.recordedAt?`首次记录 ${new Date(field.recordedAt).toLocaleString()}`:'来源时间未记录'}</small>
    <small>{field.rights}</small>
    {field.decisionMode&&<small>{field.decisionMode==='observation'?'保留指定来源':field.decisionMode==='clear'?'保留用户清空决定':'采用最新本地扫描'}</small>}
    <button className="metadata-link" disabled={busy||loading||changes.length>0} title={changes.length?'请先保存或恢复字段锁修改':undefined} onClick={()=>setHistoryField(field.field)}>查看历史与选择来源</button>
    {field.sourceUrl&&<button className="metadata-link" disabled={busy} onClick={()=>void window.music.openMetadataSource(field.sourceUrl!).catch(e=>setError(String(e)))}>查看已确认的 MusicBrainz 来源</button>}
   </div>)}</div>
   <p className="collection-note">默认文件来源的锁解除后采用最新扫描值；已指定来源或明确清空的字段仍保留选择。人工、在线确认值与来源未知的旧值解除锁后仍保留，可通过来源历史或资料编辑调整。这里的授权说明仅针对已记录的字段值。</p>
  </>:<p>未找到可查看的元数据对象。</p>}
  {error&&<p className="collection-error" role="alert">{error}</p>}{notice&&<p className="collection-note" role="status">{notice}</p>}
  <footer><button disabled={busy} onClick={onClose}>关闭</button><button className="primary-button" disabled={busy||loading||!changes.length} onClick={()=>void save()}>{busy?'正在保存…':`保存字段锁${changes.length?`（${changes.length} 项）`:''}`}</button></footer>
 </div></div>;
}
