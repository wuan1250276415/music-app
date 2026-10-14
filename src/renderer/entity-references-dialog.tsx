import React,{useEffect,useRef,useState} from 'react';
import type {CatalogChangeResult,EntityReferenceKind,EntityReferenceRef,EntityReferences,ExternalReference,LibraryItem} from '../shared/contracts';
import {trap,useFocus} from './dialog-focus';
const labels:Record<EntityReferenceKind,string>={recording:'录音',release:'发行版',release_group:'专辑概念',release_track:'发行曲目'};
const ref=(entity:EntityReferences):EntityReferenceRef=>({kind:entity.kind,entityId:entity.entityId,revision:entity.revision,fingerprint:entity.fingerprint});
export function EntityReferencesDialog({item,onClose,onChanged}:{item:LibraryItem;onClose:()=>void;onChanged:(result:CatalogChangeResult)=>void}):React.JSX.Element{
 const dialog=useRef<HTMLDivElement|null>(null);useFocus(dialog);const attempt=useRef<{identity:string;commandId:string}|null>(null);
 const [kind,setKind]=useState<EntityReferenceKind>('recording'),[entity,setEntity]=useState<EntityReferences|null>(null),[references,setReferences]=useState<ExternalReference[]>([]),[reload,setReload]=useState(0);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const ids={recording:item.catalog!.recordingId,release:item.catalog!.releaseId,release_group:item.catalog!.groupId,release_track:item.catalog!.releaseTrackId};
 useEffect(()=>{let alive=true;setLoading(true);setEntity(null);setReferences([]);setError('');setNotice('');const id=ids[kind];
  if(id)void window.music.entityReferences(kind,id).then(value=>{if(alive){setEntity(value);setReferences(value.references);setLoading(false);}}).catch(e=>{if(alive){setError(String(e));setLoading(false);}});
  else setLoading(false);return()=>{alive=false;};
 },[kind,item.id,reload]);
 function edit(index:number,change:Partial<ExternalReference>):void{setReferences(rows=>rows.map((r,i)=>i===index?{...r,...change}:r));setNotice('');}
 async function save():Promise<void>{if(!entity)return;const operation={entity:ref(entity),references},identity=JSON.stringify(operation);if(attempt.current?.identity!==identity)attempt.current={identity,commandId:crypto.randomUUID()};setBusy(true);setError('');
  try{const result=await window.music.editEntityReferences({...operation,commandId:attempt.current.commandId});const fresh=await window.music.entityReferences(kind,entity.entityId);setEntity(fresh);setReferences(fresh.references);setNotice('外部引用已保存。');onChanged(result);}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 }
 async function open(provider:string,externalId:string):Promise<void>{if(!entity)return;setBusy(true);setError('');try{await window.music.openEntityReference(ref(entity),provider,externalId);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 return <div className="collection-backdrop"><div className="collection-dialog catalog-dialog artist-manager" role="dialog" aria-label="实体外部引用" aria-modal="true" ref={dialog} onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
  <header><h2>管理外部引用</h2><button aria-label="关闭外部引用" disabled={busy} onClick={onClose}>×</button></header>
  <p className="collection-note">录音、具体发行版、发行曲目和专辑概念分别保存引用。填写来源 ID 不会自动合并曲目或更新标签；目前这些手工引用尚未联网核验。</p>
  <label>引用对象<select aria-label="引用对象" disabled={busy} value={kind} onChange={e=>setKind(e.target.value as EntityReferenceKind)}>{(Object.keys(labels) as EntityReferenceKind[]).map(k=><option key={k} value={k} disabled={!ids[k]}>{labels[k]}</option>)}</select></label>
  <button className="release-refresh" disabled={busy} onClick={()=>setReload(r=>r+1)}>刷新引用预览</button>
  {loading?<p>正在读取…</p>:entity?<>
   <div className="catalog-song"><strong>{labels[kind]} · {entity.title}</strong><small>{entity.subtitle}</small><small>{entity.itemCount} 个关联文件 · {entity.releaseCount} 个发行版</small></div>
   <div className="artist-profile-refs">{references.map((r,index)=><div key={index}>
    <label>来源<input aria-label={`实体引用来源 ${index+1}`} value={r.provider} disabled={busy} maxLength={48} onChange={e=>edit(index,{provider:e.target.value})}/></label>
    <label>来源 ID<input aria-label={`实体引用 ID ${index+1}`} value={r.externalId} disabled={busy} maxLength={512} onChange={e=>edit(index,{externalId:e.target.value})}/></label>
    <label className="artist-profile-url">可选 HTTPS 链接<input aria-label={`实体引用链接 ${index+1}`} value={r.url??''} disabled={busy} maxLength={2048} onChange={e=>edit(index,{url:e.target.value||null})}/></label>
    <button aria-label={`移除实体引用 ${index+1}`} disabled={busy} onClick={()=>setReferences(rows=>rows.filter((_,i)=>i!==index))}>移除此引用</button>
   </div>)}</div>
   <button disabled={busy||references.length>=32} onClick={()=>setReferences(rows=>[...rows,{provider:'musicbrainz',externalId:'',url:null}])}>添加实体引用</button>
   <p className="collection-note">MusicBrainz 填写当前对象的 MBID，将生成对应链接。其他来源可保存不透明 ID 和 HTTPS 链接；同种对象的同一来源 ID 只能由一个本地身份声明。</p>
   <div className="artist-saved-references">{entity.references.filter(r=>r.url).map(r=><button key={JSON.stringify([r.provider,r.externalId])} disabled={busy} onClick={()=>void open(r.provider,r.externalId)}>打开 {labels[kind]} {r.provider} · {r.externalId}</button>)}</div>
  </>:<p>当前曲目尚未关联此类对象。</p>}
  {error&&<p className="collection-error" role="alert">{error}</p>}{notice&&<p role="status" className="collection-note">{notice}</p>}
  <footer><button disabled={busy} onClick={onClose}>关闭</button><button className="primary-button" disabled={busy||loading||!entity||JSON.stringify(references)===JSON.stringify(entity.references)} onClick={()=>void save()}>{busy?'正在处理…':'确认保存外部引用'}</button></footer>
 </div></div>;
}
