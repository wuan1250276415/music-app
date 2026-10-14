import React,{useEffect,useRef,useState} from 'react';
import {readSmartPlaylistPage} from '../shared/smart-playlists';
import {readFilterPresetPage} from '../shared/filter-presets';
import {RULE_TRANSFER_MAX_BYTES,RULE_TRANSFER_MAX_ENTRIES,mapRuleEntry,readRuleBundle,readRuleImportRequest,readRuleImportResult,readRuleReferencePage,readRuleTransferInspection,ruleEntryKey,ruleReferenceKey,ruleReferences,type RuleBundle,type RuleEntry,type RuleImportRequest,type RuleMapping,type RuleReference,type RuleReferencePage,type RuleSelection,type RuleTransferInspection} from '../shared/rule-transfer';
import {MusicFiltersDialog} from './music-filters-dialog';
import {trap,useFocus} from './dialog-focus';
import './rule-transfer.css';

const pendingKey='aural-rule-import-pending-v1';
const kinds={artist:'艺人',release:'发行专辑',group:'专辑概念',genre:'风格',root:'音乐文件夹'};
const entryKinds={smart:'智能歌单',preset:'筛选预设'};
const viewLabels={all:'全部音乐',artists:'艺人',albums:'发行专辑',albumGroups:'专辑概念',genres:'风格',folders:'音乐文件夹',favorites:'收藏',recent:'最近添加',playlists:'歌单'};
const sortLabels={default:'默认顺序',title:'歌曲名称',artist:'艺人名称',album:'专辑名称',date:'发行日期',added:'加入时间'};
type ExportChoice=RuleSelection&{name:string};
function scopeText(entry:RuleEntry,references:RuleReference[]):string{
 if(entry.kind==='preset')return '复用到载入时的当前分类';const q=entry.definition.query,k=({artists:'artist',albums:'release',albumGroups:'group',genres:'genre',folders:'root'} as Record<string,string>)[q.view],id=q.view==='folders'?q.value:q.facetId,name=id?references.find(ref=>ref.kind===k&&ref.id===id)?.name:undefined;
 return `${viewLabels[q.view]}${name||q.value?` · ${name??(q.view==='folders'?'原文件夹':q.value)}`:''}`;
}
function RuleOverview({entry,references}:{entry:RuleEntry;references:RuleReference[]}):React.JSX.Element{
 if(entry.kind==='preset')return <small>只保存组合条件，载入时用于当前分类。</small>;
 const q=entry.definition.query,sort=q.sort,genre=q.genreFilter;
 return <details className="rule-transfer-overview"><summary>查看原范围、检索与排序</summary><dl><dt>范围</dt><dd>{scopeText(entry,references)}</dd><dt>原检索词</dt><dd>{q.query||'不限'}</dd><dt>排序</dt><dd>{sortLabels[sort?.mode??'default']}{sort?.mode&&sort.mode!=='default'?sort.direction==='asc'?' · 升序':' · 降序':''}</dd><dt>文件版本</dt><dd>{q.collapseVersions?'折叠同一发行曲目的文件版本':'显示全部文件版本'}</dd>{q.view==='artists'&&<><dt>艺人角色</dt><dd>{({performer:'曲目艺人',album_artist:'专辑艺人',composer:'作曲',conductor:'指挥',orchestra:'乐团'} as const)[q.artistRole??'performer']}</dd></>}{genre?.ids.length? <><dt>分类风格范围</dt><dd>{genre.ids.map(id=>references.find(ref=>ref.kind==='genre'&&ref.id===id)?.name??'原风格资料').join('、')} · {genre.operator==='all'?'全部满足':'任意满足'} · {genre.descendants?'包含下级':'仅指定风格'}</dd></>:null}</dl></details>;
}
function pendingRecord():{pending:RuleImportRequest|null;broken:boolean}{
 try{const raw=localStorage.getItem(pendingKey);if(raw&&raw.length>RULE_TRANSFER_MAX_BYTES)throw new Error('导入记录过长');return {pending:raw?readRuleImportRequest(JSON.parse(raw)):null,broken:false};}catch{return {pending:null,broken:true};}
}
async function bundleDigest(bundle:RuleBundle):Promise<string>{const bytes=new TextEncoder().encode('aural-rule-bundle-v1:'+JSON.stringify(readRuleBundle(bundle))),hash=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(hash)].map(value=>value.toString(16).padStart(2,'0')).join('');}

function RuleExportPanel({revision,initial=[],onBusy}:{revision:number;initial?:ExportChoice[];onBusy:(busy:boolean)=>void}):React.JSX.Element{
 const [kind,setKind]=useState<'smart'|'preset'>('smart'),[offset,setOffset]=useState(0),[refresh,setRefresh]=useState(0),[page,setPage]=useState<{key:string;items:ExportChoice[];total:number}|null>(null),[chosen,setChosen]=useState<ExportChoice[]>(initial),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const snapshot=useRef<{key:string;value:string}|null>(null),alive=useRef(true),flight=useRef(false),key=JSON.stringify([kind,offset,revision,refresh]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>window.music.onEvent(event=>{if(event.event==='filterPresetsChanged'){snapshot.current=null;setOffset(0);setRefresh(n=>n+1);}}),[]);
 useEffect(()=>{setOffset(0);snapshot.current=null;},[kind,revision]);
 useEffect(()=>{let current=true;setLoading(true);setError('');const scope=JSON.stringify([kind,revision]),bound=snapshot.current?.key===scope?snapshot.current.value:undefined;
  void (kind==='smart'?window.music.smartPlaylists({offset,...(bound?{snapshot:bound}:{})}):window.music.filterPresets({offset,...(bound?{snapshot:bound}:{})})).then(raw=>{
   const result=kind==='smart'?readSmartPlaylistPage(raw):readFilterPresetPage(raw);if(!current)return;
   if(result.status==='stale'){snapshot.current=null;setError('目录已变化，请重新读取。');return;}snapshot.current={key:scope,value:result.snapshot};setPage({key,total:result.total,items:result.items.map(item=>({kind,id:item.id,revision:item.revision,name:item.name}))});
  }).catch(e=>{if(current)setError(String(e instanceof Error?e.message:e).slice(0,512));}).finally(()=>{if(current)setLoading(false);});return()=>{current=false;};
 },[key]);
 const visible=page?.key===key?page:null;
 function toggle(item:ExportChoice):void{const id=ruleEntryKey(item);setChosen(old=>old.some(c=>ruleEntryKey(c)===id)?old.filter(c=>ruleEntryKey(c)!==id):[...old,item]);setNotice('');}
 async function save():Promise<void>{
  if(flight.current||!chosen.length)return;flight.current=true;setBusy(true);onBusy(true);setError('');setNotice('');
  try{const result=await window.music.exportRules({items:chosen.map(({kind,id,revision})=>({kind,id,revision}))});if(result&&(typeof result.name!=='string'||result.name.length>128||result.entries!==chosen.length))throw new Error('规则文件保存响应不一致');if(alive.current&&result)setNotice(`已保存 ${result.entries} 项规则到“${result.name}”。`);}
  catch(e){if(alive.current)setError(String(e instanceof Error?e.message:e).slice(0,512));}finally{flight.current=false;onBusy(false);if(alive.current)setBusy(false);}
 }
 return <section aria-label="选择导出的规则"><p>导出已保存的规则和引用资料，不包含歌曲、歌词、凭据或正在编辑的草稿。最多选择64项，可跨页选择。</p><div className="rule-transfer-tools"><label>类型<select value={kind} disabled={busy} onChange={e=>setKind(e.target.value as 'smart'|'preset')}><option value="smart">智能歌单</option><option value="preset">筛选预设</option></select></label><button disabled={busy||loading} onClick={()=>{snapshot.current=null;setRefresh(n=>n+1);}}>重新读取目录</button><button disabled={busy||!chosen.length} onClick={()=>setChosen([])}>清空选择</button></div>
  {error&&<p className="collection-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {loading?<p role="status">正在读取已保存的规则…</p>:<div className="rule-transfer-entries">{visible?.items.map(item=>{const selected=chosen.some(c=>ruleEntryKey(c)===ruleEntryKey(item));return <label key={item.id}><input type="checkbox" checked={selected} disabled={busy||!selected&&chosen.length>=RULE_TRANSFER_MAX_ENTRIES} onChange={()=>toggle(item)}/><strong>{item.name}</strong><small>{entryKinds[item.kind]}</small></label>;})}{visible?.total===0&&<p>还没有这种已保存的规则。</p>}</div>}
  <div className="rule-transfer-tools"><button disabled={busy||loading||!offset} onClick={()=>setOffset(n=>Math.max(0,n-50))}>上一页</button><span>{visible?`${visible.total} 项 · 第 ${Math.floor(offset/50)+1} 页`:''}</span><button disabled={busy||loading||!visible||offset+50>=visible.total} onClick={()=>setOffset(n=>n+50)}>下一页</button></div>
  <details><summary>已选择 {chosen.length} 项</summary><ul>{chosen.map(item=><li key={ruleEntryKey(item)}>{entryKinds[item.kind]} · {item.name}<button disabled={busy} onClick={()=>toggle(item)}>移除选择</button></li>)}</ul></details><button className="primary-button" disabled={busy||!chosen.length} onClick={()=>void save()}>{busy?'正在保存…':'选择位置并导出'}</button><p>规则更新后，请移除旧选择并重新勾选；导出会核对保存版本。</p>
 </section>;
}

function ReferencePicker({source,revision,onChoose,onClose}:{source:RuleReference;revision:number;onChoose:(ref:RuleReference)=>void;onClose:()=>void}):React.JSX.Element{
 const [query,setQuery]=useState(''),[cursor,setCursor]=useState<string|undefined>(),[refresh,setRefresh]=useState(0),[page,setPage]=useState<{key:string;value:RuleReferencePage}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const key=JSON.stringify([source.kind,query.trim(),cursor,revision,refresh]);
 useEffect(()=>{setCursor(undefined);},[query,source.kind,revision]);
 useEffect(()=>{let active=true;setBusy(true);setError('');const timer=setTimeout(()=>{void window.music.ruleReferenceTargets({kind:source.kind,query:query.trim(),...(cursor?{cursor}:{})}).then(raw=>{
  const value=readRuleReferencePage(raw);if(value.kind!==source.kind||value.query!==query.trim())throw new Error('匹配目标与检索范围不一致');if(!active)return;if(value.status==='stale'){setError('目标目录已变化，请从第一页重新搜索。');return;}setPage({key,value});
 }).catch(e=>{if(active)setError(String(e instanceof Error?e.message:e).slice(0,512));}).finally(()=>{if(active)setBusy(false);});},200);return()=>{active=false;clearTimeout(timer);};},[key]);
 const visible=page?.key===key&&!error?page.value:null;
 return <section className="rule-reference-picker" aria-label={`匹配${kinds[source.kind]}`}><h3>匹配 {kinds[source.kind]}：{source.name}</h3><p>{source.context}</p><label>查找当前曲库资料<input type="search" maxLength={128} value={query} onChange={e=>setQuery(e.target.value)} placeholder={`输入${kinds[source.kind]}名称`}/></label>{error&&<p className="collection-error" role="alert">{error}</p>}{busy?<p role="status">正在检索…</p>:<div className="rule-reference-targets">{visible?.items.map(ref=><button key={ref.id} onClick={()=>onChoose(ref)}><strong>{ref.name}</strong><small>{ref.context||kinds[ref.kind]}</small></button>)}{visible?.items.length===0&&<p>没有匹配资料，可修改名称后再检索。</p>}</div>}<div className="rule-transfer-tools"><button disabled={busy} onClick={()=>{setCursor(undefined);setRefresh(n=>n+1);}}>从第一页重新搜索</button><button disabled={busy||!visible?.nextCursor} onClick={()=>setCursor(visible!.nextCursor!)}>下一页</button><button onClick={onClose}>取消本次匹配</button></div></section>;
}

export function RuleTransferDialog({revision,onClose,onChanged,initialExport}:{revision:number;onClose:()=>void;onChanged:()=>void;initialExport?:ExportChoice[]}):React.JSX.Element{
 const [initial]=useState(pendingRecord),[pending,setPending]=useState(initial.pending),[broken,setBroken]=useState(initial.broken),[mode,setMode]=useState<'import'|'export'>(initial.pending||initial.broken?'import':initialExport?'export':'import');
 const [bundle,setBundle]=useState<RuleBundle|null>(initial.pending?.bundle??null),[filename,setFilename]=useState(initial.pending?'上次选择的规则文件':''),[selected,setSelected]=useState<string[]>(initial.pending?.selected??[]),[inspection,setInspection]=useState<RuleTransferInspection|null>(null),[mappings,setMappings]=useState<RuleMapping[]>(initial.pending?.mappings??[]),[referenceOffset,setReferenceOffset]=useState(0),[choosing,setChoosing]=useState<RuleReference|null>(null),[preview,setPreview]=useState<RuleEntry|null>(null),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[exportBusy,setExportBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const ref=useRef<HTMLDivElement|null>(null),alive=useRef(true),flight=useRef(false),generation=useRef(0),lastRevision=useRef(revision),pendingRef=useRef(pending);pendingRef.current=pending;useFocus(ref);
 const locked=busy||exportBusy||!!pending||broken;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
 useEffect(()=>{if(lastRevision.current===revision)return;lastRevision.current=revision;if(pendingRef.current)return;generation.current++;setInspection(null);setConfirm(false);setChoosing(null);setPreview(null);if(bundle)setNotice('曲库已更新，请重新核对规则引用。');},[revision]);
 function changeSelection(key:string):void{setSelected(old=>old.includes(key)?old.filter(k=>k!==key):[...old,key]);generation.current++;setInspection(null);setMappings([]);setConfirm(false);setChoosing(null);setReferenceOffset(0);}
 async function pickFile():Promise<void>{
  if(flight.current||locked)return;flight.current=true;setBusy(true);setError('');setNotice('');
  try{const value=await window.music.pickRulesFile();if(!value)return;if(typeof value.name!=='string'||value.name.length>128)throw new Error('规则文件名称无效');const result=readRuleBundle(value.bundle);if(!alive.current)return;generation.current++;setBundle(result);setFilename(value.name);setSelected(result.entries.map(ruleEntryKey));setInspection(null);setMappings([]);setConfirm(false);setChoosing(null);setPreview(null);setReferenceOffset(0);}
  catch(e){if(alive.current)setError(String(e instanceof Error?e.message:e).slice(0,512));}finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 async function inspect():Promise<void>{
  if(flight.current||locked||!bundle||!selected.length)return;flight.current=true;setBusy(true);setError('');setConfirm(false);setChoosing(null);const g=++generation.current;
  try{const value=readRuleTransferInspection(await window.music.inspectRuleImport({bundle,selected,mappings})),required=ruleReferences(bundle.entries.filter(entry=>selected.includes(ruleEntryKey(entry)))).map(ruleReferenceKey),expected=bundle.references.filter(ref=>required.includes(ruleReferenceKey(ref)));
   if(value.digest!==await bundleDigest(bundle)||JSON.stringify(value.needed)!==JSON.stringify(expected)||value.retained.some(m=>!mappings.some(old=>JSON.stringify(old)===JSON.stringify(m))))throw new Error('引用核对与所选文件不一致');if(!alive.current||g!==generation.current)return;setInspection(value);setMappings([...value.retained,...value.suggested.filter(m=>!value.retained.some(old=>old.source===m.source))]);setReferenceOffset(0);setNotice(value.sameLibrary?'来源为同一曲库；只保留仍符合原资料的身份匹配。':'来源为其他曲库；请逐项选择当前资料。');
  }catch(e){if(alive.current&&g===generation.current){setInspection(null);setError(String(e instanceof Error?e.message:e).slice(0,512));}}finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 function showPreview(entry:RuleEntry):void{try{setPreview(mapRuleEntry(entry,mappings));setError('');}catch(e){setError(String(e instanceof Error?e.message:e).slice(0,512));}}
 async function submit(retry=false):Promise<void>{
  if(flight.current||broken||!retry&&(pending||!confirm||!bundle||!inspection))return;flight.current=true;setBusy(true);setError('');setNotice('');
  try{
   const request=retry?pending!:readRuleImportRequest({commandId:crypto.randomUUID(),bundle,selected,mappings});if(!request)throw new Error('没有待核对导入');
   request.bundle.entries.filter(entry=>request.selected.includes(ruleEntryKey(entry))).forEach(entry=>mapRuleEntry(entry,request.mappings));
   const canonical=JSON.stringify(request),existing=localStorage.getItem(pendingKey);if(existing&&existing!==canonical)throw new Error('已有另一项待核对导入，请重新打开并核对');
   localStorage.setItem(pendingKey,canonical);setPending(request);pendingRef.current=request;
   const result=readRuleImportResult(await window.music.importRules(request));
   if(result.commandId!==request.commandId)throw new Error('导入回执身份不一致，请重试原操作');
   if(result.status==='saved'){
    const entries=request.bundle.entries.filter(entry=>request.selected.includes(ruleEntryKey(entry))),created=result.value!.created;
    if(result.value!.digest!==await bundleDigest(request.bundle)||created.length!==entries.length||created.some((item,index)=>item.source!==ruleEntryKey(entries[index])||item.kind!==entries[index].kind||item.name!==entries[index].name))throw new Error('导入回执条目不一致，请重试原操作');
   }
   if(localStorage.getItem(pendingKey)!==canonical)throw new Error('待核对记录已变化，请重新打开');localStorage.removeItem(pendingKey);
   if(!alive.current)return;setPending(null);pendingRef.current=null;setInspection(null);setConfirm(false);setChoosing(null);setPreview(null);
   if(result.status==='rejected'){setError(result.error);return;}
   setNotice(`原导入已保存，共创建 ${result.value!.created.length} 项。当前条件和播放列表保持原状；可在对应目录中查看。`);setBundle(null);setSelected([]);setMappings([]);onChanged();
  }catch(e){if(alive.current)setError(String(e instanceof Error?e.message:e).slice(0,512));}finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 const unmatched=inspection?inspection.needed.filter(ref=>!mappings.some(m=>m.source===ruleReferenceKey(ref))).length:0;
 const previewQuery=preview?.kind==='smart'?preview.definition.query:preview?{view:'all' as const,filters:preview.definition.filters}:null;
 return <><div className="collection-backdrop"><div ref={ref} className="collection-dialog rule-transfer-dialog" role="dialog" aria-modal="true" aria-label="音乐规则导入导出" inert={!!preview} aria-hidden={preview?true:undefined} onKeyDown={event=>{if(!preview)trap(event,ref.current,onClose,busy||exportBusy);}}><header><h2>音乐规则导入导出</h2><button disabled={busy||exportBusy} aria-label="关闭音乐规则导入导出" onClick={onClose}>×</button></header><div className="rule-transfer-tools"><button aria-pressed={mode==='import'} disabled={busy||exportBusy} onClick={()=>setMode('import')}>导入规则</button><button aria-pressed={mode==='export'} disabled={locked} onClick={()=>setMode('export')}>导出规则</button></div>
  {mode==='export'?<RuleExportPanel revision={revision} initial={initialExport} onBusy={setExportBusy}/>:<>
   <p>导入会创建新的智能歌单或筛选预设。同名规则也保留为独立条目；不会覆盖已有规则、修改音乐文件或替换播放列表。</p>
   {pending&&<div className="rule-transfer-pending"><p>上次导入结果待核对，已保留原规则和匹配资料。先重试原操作，可在重启后继续核对。</p><button disabled={busy||broken} onClick={()=>void submit(true)}>{busy?'正在核对…':'核对原导入结果'}</button></div>}
   {broken&&<p role="alert">上次导入记录无法读取。请先在歌单和预设目录核对已有条目，再清除无效记录。</p>}
   {error&&<p className="collection-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
   <button disabled={locked} onClick={()=>void pickFile()}>{busy?'正在读取…':'选择 JSON 规则文件'}</button>
   {bundle&&<><h3>{filename} · {bundle.entries.length} 项</h3><p>请选择需要导入的规则，然后核对引用。</p><div className="rule-transfer-entries">{bundle.entries.map(entry=><label key={ruleEntryKey(entry)}><input type="checkbox" checked={selected.includes(ruleEntryKey(entry))} disabled={locked} onChange={()=>changeSelection(ruleEntryKey(entry))}/><strong>{entry.name}</strong><small>{entryKinds[entry.kind]}</small><RuleOverview entry={entry} references={bundle.references}/>{inspection&&unmatched===0&&selected.includes(ruleEntryKey(entry))&&<button type="button" disabled={locked} onClick={()=>showPreview(entry)}>查看匹配后的规则</button>}</label>)}</div><button disabled={locked||!selected.length} onClick={()=>void inspect()}>核对所选规则引用</button></>}
   {inspection&&!pending&&<section aria-label="规则引用匹配"><h3>引用匹配 · 还需匹配 {unmatched} 项</h3><p>{inspection.needed.length?'请检查名称和上下文，不能仅凭同名判断为同一资料。':'这些规则没有引用特定艺人、专辑、风格或文件夹。'}</p><div className="rule-transfer-references">{inspection.needed.slice(referenceOffset,referenceOffset+16).map(source=>{const mapped=mappings.find(m=>m.source===ruleReferenceKey(source));return <article key={ruleReferenceKey(source)}><div><small>{kinds[source.kind]} · 原资料</small><strong>{source.name}</strong><p>{source.context}</p></div><div><small>当前资料</small><strong>{mapped?.target.name??'尚未匹配'}</strong><p>{mapped?.target.context}</p><button disabled={locked} onClick={()=>{setChoosing(source);setConfirm(false);}}>选择对应资料</button>{mapped&&<button disabled={locked} onClick={()=>{setMappings(old=>old.filter(m=>m.source!==ruleReferenceKey(source)));setConfirm(false);}}>取消匹配</button>}</div></article>;})}</div>{inspection.needed.length>16&&<div className="rule-transfer-tools"><button disabled={locked||referenceOffset===0} onClick={()=>setReferenceOffset(n=>Math.max(0,n-16))}>上一页引用</button><span>{referenceOffset+1}–{Math.min(referenceOffset+16,inspection.needed.length)}／{inspection.needed.length}</span><button disabled={locked||referenceOffset+16>=inspection.needed.length} onClick={()=>setReferenceOffset(n=>n+16)}>下一页引用</button></div>}
    {choosing&&<ReferencePicker key={ruleReferenceKey(choosing)} source={choosing} revision={revision} onClose={()=>setChoosing(null)} onChoose={target=>{if(target.kind!==choosing.kind||!inspection.needed.some(ref=>ruleReferenceKey(ref)===ruleReferenceKey(choosing)))return;setMappings(old=>[...old.filter(m=>m.source!==ruleReferenceKey(choosing)),{source:ruleReferenceKey(choosing),target}]);setChoosing(null);setConfirm(false);}}/>}
    <label className="rule-transfer-confirm"><input type="checkbox" checked={confirm} disabled={locked||unmatched>0||!!choosing} onChange={e=>setConfirm(e.target.checked)}/>确认创建 {selected.length} 项新规则，以上引用匹配已经核对</label><button className="primary-button" disabled={locked||!confirm||unmatched>0||!!choosing} onClick={()=>void submit()}>{busy?'正在导入…':'导入所选规则'}</button></section>}
  </>}
  <footer>{broken&&<button onClick={()=>{try{localStorage.removeItem(pendingKey);setBroken(false);setError('');setNotice('无效记录已清除，请核对现有规则后再导入。');}catch(e){setError(String(e));}}}>清除无效操作记录</button>}<button disabled={busy||exportBusy} onClick={onClose}>{pending?'关闭，保留待核对导入':'关闭'}</button></footer>
 </div></div>{preview&&previewQuery&&<MusicFiltersDialog value={previewQuery.filters??{}} previewQuery={previewQuery} scopeLabel={preview.kind==='preset'?`预设“${preview.name}”在全部音乐中的结果`:`${preview.name} · ${scopeText(preview,mappings.map(m=>m.target))}`} revision={revision} readOnly readOnlyTitle="导入规则的组合条件" onApply={()=>{}} onClose={()=>setPreview(null)}/>}</>;
}
