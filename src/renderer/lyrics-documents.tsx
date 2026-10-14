import React,{useEffect,useRef,useState} from 'react';
import type {LibraryItem,LyricsEncoding,LyricsTimeBasis,LyricsImportInput,LyricsImportPreview,LyricsDocumentPage,LyricsDocumentRequest,LyricsDocumentChangePage,SavedLyricsDocument,LocalLyricsVersionPage,LocalLyricsVersion} from '../shared/contracts';
import {useFocus,trap} from './dialog-focus';
import {LyricsContext} from './lyrics-context';
import './lyrics-documents.css';

function utf8Base64(text:string):string{
 const bytes=new TextEncoder().encode(text);if(!bytes.length||bytes.length>1024*1024)throw new Error('歌词文本须为 1 MiB 以内的非空 UTF-8 文本');
 let binary='';for(let at=0;at<bytes.length;at+=8192)binary+=String.fromCharCode(...bytes.subarray(at,at+8192));return btoa(binary);
}
const actionNames={import:'导入新版本',archive:'归档',restore:'恢复'};
export function LyricsDocumentsDialog({item,onClose,onChanged,onBrowseSaved,onBrowseLocal,reuseSource=null,reuseLocalSource=null,covered=false}:{item:LibraryItem;onClose:()=>void;onChanged:()=>void;onBrowseSaved?:()=>void;onBrowseLocal?:()=>void;reuseSource?:SavedLyricsDocument|null;reuseLocalSource?:LocalLyricsVersion|null;covered?:boolean}):React.JSX.Element{
 const initialSource=reuseLocalSource??reuseSource;
 const [tab,setTab]=useState<'import'|'versions'|'changes'|'local'>('import');
 const [localPage,setLocalPage]=useState<LocalLyricsVersionPage|null>(null),[localViewing,setLocalViewing]=useState<LocalLyricsVersion|null>(null),[localOrigin,setLocalOrigin]=useState<LocalLyricsVersion|null>(reuseLocalSource);
 const [page,setPage]=useState<LyricsDocumentPage|null>(null),[changes,setChanges]=useState<LyricsDocumentChangePage|null>(null);
 const [file,setFile]=useState<{name:string;rawBase64:string;sourceDocumentId?:string;sourceLocalVersionId?:string}|null>(reuseLocalSource?{name:reuseLocalSource.summary.label,rawBase64:reuseLocalSource.rawBase64,sourceLocalVersionId:reuseLocalSource.summary.id}:reuseSource?{name:reuseSource.summary.label,rawBase64:reuseSource.rawBase64,sourceDocumentId:reuseSource.summary.id}:null),[text,setText]=useState(''),[label,setLabel]=useState(initialSource?`${initialSource.summary.label.replace(/[\u0000-\u001f]/g,'').slice(0,120)}（复制）`:`${item.title} 歌词`.slice(0,128)),[language,setLanguage]=useState(reuseLocalSource?.preview.document.language??reuseSource?.summary.language??'');
 const [encoding,setEncoding]=useState<LyricsEncoding>(initialSource&&['utf-8','utf-16le','utf-16be','gb18030'].includes(initialSource.preview.encoding)?initialSource.preview.encoding as LyricsEncoding:'auto'),[basis,setBasis]=useState<LyricsTimeBasis|''>(initialSource?'':'track-relative');
 const [preview,setPreview]=useState<LyricsImportPreview|null>(null),[viewing,setViewing]=useState<LyricsImportPreview|null>(null),[viewLabel,setViewLabel]=useState('');
 const [busy,setBusy]=useState(false),[pending,setPending]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const dialog=useRef<HTMLDivElement|null>(null),working=useRef(false),alive=useRef(true),attempt=useRef<LyricsDocumentRequest|null>(null),previewInput=useRef<LyricsImportInput|null>(null);
 useFocus(dialog);
 const disabled=busy||pending,blocked=disabled||stale||!page;
 useEffect(()=>{
  alive.current=true;working.current=true;setBusy(true);
  void window.music.lyricsDocuments(item.id).then(value=>{if(alive.current)setPage(value);}).catch(e=>{if(alive.current)setError(String(e));}).finally(()=>{if(alive.current){working.current=false;setBusy(false);}});
  const unsubscribe=window.music.onEvent(event=>{if((event.event==='lyricsChanged'&&(event.payload as {itemId?:string})?.itemId===item.id||event.event==='libraryChanged')&&!working.current)setStale(true);});
  return()=>{alive.current=false;unsubscribe();};
 },[item.id]);
 useEffect(()=>{if(busy)dialog.current?.focus();},[busy]);
 function invalidate():void{previewInput.current=null;setPreview(null);setError('');setNotice('');}
 async function reload(cursor?:string):Promise<void>{
  const value=await window.music.lyricsDocuments(item.id,cursor);
  if(!alive.current)return;
  if(cursor&&page&&(value.scope!==page.scope||value.revision!==page.revision)){setStale(true);throw new Error('歌词版本列表已变化，请重新读取');}
  setPage(previous=>cursor&&previous?{...value,items:[...previous.items,...value.items]}:value);
  if(!cursor){setStale(false);setChanges(null);setViewing(null);invalidate();}
 }
 async function reading(action:()=>Promise<void>):Promise<void>{
  if(working.current||pending)return;working.current=true;setBusy(true);setError('');
  try{await action();}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}
  finally{if(alive.current){working.current=false;setBusy(false);}}
 }
 async function chooseFile():Promise<void>{
  await reading(async()=>{const selected=await window.music.pickLyricsFile();if(!alive.current||!selected)return;setFile(selected);setLabel(selected.name);setEncoding('auto');invalidate();});
 }
 async function inspectImport():Promise<void>{
  if(blocked||!page||!basis)return;
  await reading(async()=>{
   const input:LyricsImportInput={itemId:item.id,scope:page.scope,label,language,encoding:file?encoding:'utf-8',timeBasis:basis,rawBase64:file?.rawBase64??utf8Base64(text),...(file?.sourceDocumentId?{sourceDocumentId:file.sourceDocumentId}:{}),...(file?.sourceLocalVersionId?{sourceLocalVersionId:file.sourceLocalVersionId}:{})};
   const value=await window.music.previewLyricsImport(input);if(!alive.current)return;previewInput.current=input;setPreview(value);
  });
 }
 async function submit(request?:LyricsDocumentRequest):Promise<void>{
  if(working.current)return;const intent=request??attempt.current;if(!intent)return;
  working.current=true;attempt.current=intent;setBusy(true);setPending(true);setError('');setNotice('');
  try{
   const result=await window.music.editLyricsDocument(intent);if(!alive.current)return;
   attempt.current=null;setPending(false);
   if(result.status==='rejected'){setError(result.error);setStale(true);return;}
   setStale(true);onChanged();await reload();
   setNotice(`${actionNames[intent.action]}已保存${intent.action==='import'?'；新版本加入来源列表，已有自动优先级和指定主歌词保持原设置。':'。'}`);
   if(intent.action==='import')setTab('versions');
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}
  finally{if(alive.current){working.current=false;setBusy(false);}}
 }
 function importVersion():void{
  if(blocked||!page||!previewInput.current||!preview)return;
  void submit({commandId:crypto.randomUUID(),itemId:item.id,scope:page.scope,baseRevision:page.revision,action:'import',input:previewInput.current});
 }
 function toggleVersion(documentId:string,archived:boolean):void{
  if(blocked||!page)return;void submit({commandId:crypto.randomUUID(),itemId:item.id,scope:page.scope,baseRevision:page.revision,action:archived?'restore':'archive',documentId});
 }
 async function viewVersion(documentId:string,name:string):Promise<void>{
  await reading(async()=>{const value=await window.music.lyricsDocument(item.id,documentId);if(alive.current){setViewing(value);setViewLabel(name);}});
 }
 async function readChanges(cursor?:string):Promise<void>{
  await reading(async()=>{const value=await window.music.lyricsDocumentChanges(item.id,cursor);if(alive.current)setChanges(previous=>cursor&&previous?{...value,items:[...previous.items,...value.items]}:value);});
 }
 async function reloadLocal(cursor?:string):Promise<void>{
  const value=await window.music.localLyricsVersions(item.id,cursor);if(!alive.current)return;
  if(cursor&&localPage&&localPage.scope!==value.scope){setStale(true);throw new Error('曲目范围已变化，请重新读取原文历史');}
  setLocalPage(previous=>cursor&&previous?{...value,items:[...previous.items,...value.items]}:value);if(!cursor)setLocalViewing(null);
 }
 async function viewLocal(id:string):Promise<void>{
  await reading(async()=>{const value=await window.music.localLyricsVersion(item.id,id);if(alive.current)setLocalViewing(value);});
 }
 async function copyLocal(id:string):Promise<void>{
  await reading(async()=>{
   const value=await window.music.localLyricsVersion(item.id,id);await reload();if(!alive.current)return;
   setLocalOrigin(value);setFile({name:value.summary.label,rawBase64:value.rawBase64,sourceLocalVersionId:value.summary.id});
   setLabel(`${value.summary.label.replace(/[\u0000-\u001f]/g,'').slice(0,120)}（复制）`);setLanguage(value.preview.document.language??'');setEncoding(value.summary.encoding);setBasis('');setTab('import');
  });
 }
 return <div className="collection-backdrop"><div ref={dialog} className="collection-dialog catalog-dialog lyrics-documents-dialog" role="dialog" aria-modal={!covered} aria-hidden={covered} inert={covered} aria-label="歌词导入与版本" tabIndex={-1} onKeyDown={event=>trap(event,dialog.current,onClose,disabled)}>
  <header><div><h2>歌词导入与版本</h2><p>{item.title} · {item.artist}</p></div><button aria-label="关闭歌词管理" disabled={disabled} onClick={onClose}>×</button></header>
  <div className="lyrics-document-tabs"><button disabled={disabled} aria-pressed={tab==='import'} onClick={()=>setTab('import')}>导入歌词</button><button disabled={disabled} aria-pressed={tab==='versions'} onClick={()=>setTab('versions')}>保存的版本</button><button disabled={disabled} aria-pressed={tab==='local'} onClick={()=>{setTab('local');void reading(()=>reloadLocal());}}>本地原文历史</button><button disabled={disabled} aria-pressed={tab==='changes'} onClick={()=>{setTab('changes');if(!changes)void readChanges();}}>修订记录</button></div>
  {notice&&<p className="lyrics-document-notice" role="status">{notice}</p>}{error&&<p className="lyrics-document-error" role="alert">{error}</p>}
  {stale&&<p role="status">曲目或歌词已变化，请重新读取后再修改。</p>}{pending&&<p role="status">保存结果尚未确认，保留原操作等待核对。</p>}
  <div className="lyrics-document-body">
   {tab==='import'&&<>
    <div className="lyrics-document-file"><button disabled={blocked} onClick={()=>void chooseFile()}>选择 LRC / TXT 文件</button>{file&&<><span>{file.name}</span><button disabled={disabled} onClick={()=>{setFile(null);invalidate();}}>改为粘贴文本</button></>}</div>
    {file?.sourceDocumentId&&reuseSource&&<p>从保存的“{reuseSource.summary.label}”复制。原版本时间基：{reuseSource.summary.timeBasis==='audio-absolute'?'源音频时间':'原曲目相对时间'}；请重新选择目标时间基并核对预览。</p>}
    <fieldset disabled={blocked} className="lyrics-document-fields"><label>版本名称<input maxLength={128} value={label} onChange={event=>{setLabel(event.target.value);invalidate();}}/></label><label>语言（可留空）<input maxLength={32} value={language} placeholder="zh / en / zh-CN" onChange={event=>{setLanguage(event.target.value);invalidate();}}/></label>
     <label>文本编码<select value={file?encoding:'utf-8'} disabled={!file} onChange={event=>{setEncoding(event.target.value as LyricsEncoding);invalidate();}}><option value="auto">自动识别</option><option value="utf-8">UTF-8</option><option value="utf-16le">UTF-16LE</option><option value="utf-16be">UTF-16BE</option><option value="gb18030">GB18030</option></select></label>
     <label>歌词时间基<select value={basis} onChange={event=>{setBasis(event.target.value as LyricsTimeBasis|'');invalidate();}}><option value="">请选择目标时间基</option><option value="track-relative">当前曲目时间</option><option value="audio-absolute">源音频时间</option></select></label>
    </fieldset>
    {file?.sourceDocumentId&&reuseSource&&<LyricsContext value={reuseSource.preview.scopeSnapshot}/>}
    {file?.sourceLocalVersionId&&localOrigin&&<><p>从本地原文历史“{localOrigin.summary.label}”复制。请明确选择目标时间基，并核对预览；历史版本不会自动作为当前歌词。</p><LyricsContext value={localOrigin.preview.scopeSnapshot}/></>}
    {item.kind==='cue'&&<p>逐轨歌词选“当前曲目时间”；整碟同步歌词选“源音频时间”，仅解析当前 CUE 范围。</p>}
    {!file&&<label className="lyrics-document-text">歌词文本<textarea maxLength={1048576} rows={9} disabled={blocked} value={text} placeholder="粘贴 LRC 同步歌词或纯文本歌词" onChange={event=>{setText(event.target.value);invalidate();}}/></label>}
    <button disabled={blocked||!basis||!label.trim()||!file&&!text.trim()} onClick={()=>void inspectImport()}>解析并预览</button>
    {preview?.target&&<p>预览关联：{preview.target.title} · {preview.target.artist}{preview.target.kind==='cue'?`；源音频范围 ${preview.target.sourceStartSeconds.toFixed(3)} 秒至 ${preview.target.sourceEndSeconds===null?'源音频结束':`${preview.target.sourceEndSeconds.toFixed(3)} 秒`}`:''}。请核对解析后的歌词时间。</p>}
    {preview&&<section className="lyrics-document-preview"><h3>导入预览</h3><p>{preview.encoding}{file&&encoding==='auto'?'（自动识别，请核对文字）':''} · {preview.rawBytes} 字节 · {preview.document.kind==='timed'?'逐行同步':'纯文本'} · {preview.document.lines.length} 行</p><div>{preview.document.lines.slice(0,12).map((line,index)=><p key={index}>{preview.document.kind==='timed'?`${line.atSeconds.toFixed(3)} 秒 · `:''}{line.text}</p>)}</div><small>展示前 12 行；来源自带偏移已应用，用户偏移另行设置。</small><details><summary>解码后的原文</summary><textarea aria-label="导入歌词原文" rows={8} readOnly value={preview.text}/>{file&&<button disabled={disabled} onClick={()=>{setText(preview.text);setFile(null);setEncoding('utf-8');invalidate();}}>复制为文本继续编辑</button>}</details></section>}
    <p>确认后保存为独立版本；不改写所选歌词文件或音乐文件。默认自动顺序优先使用最近导入；自定义优先级和指定的主歌词保持原设置。</p>
   </>}
   {tab==='versions'&&<>
    {page?.olderScopeCount? <p>另有 {page.olderScopeCount} 个旧曲目范围版本仍保留，当前范围不会套用其时间与内容。</p>:null}
    {onBrowseSaved&&<button disabled={disabled} onClick={onBrowseSaved}>查看此曲目的全部范围原文</button>}
    {!page?.items.length&&<p>{busy?'正在读取…':'当前曲目范围尚无导入版本。'}</p>}
    {page?.items.map(version=><div className="lyrics-document-version" key={version.id}><div><strong>{version.label}{version.archived?' · 已归档':''}</strong><small>{version.kind==='timed'?'同步':'文本'} · {version.lineCount} 行 · {version.encoding}{version.language?` · ${version.language}`:''} · {version.timeBasis==='audio-absolute'?'源音频时间':'当前曲目时间'}</small><small>导入：{new Date(version.createdAt).toLocaleString()} · {version.rawBytes} 字节</small></div><button disabled={disabled} onClick={()=>void viewVersion(version.id,version.label)}>查看原文</button><button disabled={blocked} onClick={()=>toggleVersion(version.id,version.archived)}>{version.archived?'恢复':'归档'}</button></div>)}
    {page?.nextCursor&&<button disabled={disabled} onClick={()=>void reading(()=>reload(page.nextCursor!))}>更多版本</button>}
    <p>归档只停用歌词来源，原文与修订记录继续保留。可在“歌词来源与显示设置”选择主／辅助版本。</p>
    {viewing&&<section className="lyrics-document-preview"><h3>{viewLabel}</h3><LyricsContext value={viewing.scopeSnapshot}/><p>{viewing.encoding} · {viewing.rawBytes} 字节</p><small className="lyrics-document-hash">原始内容 SHA-256：{viewing.rawSha256}</small><textarea aria-label="保存的歌词原文" rows={10} readOnly value={viewing.text}/></section>}
   </>}
   {tab==='local'&&<>
    {onBrowseLocal&&<button disabled={disabled} onClick={onBrowseLocal}>查看全部曲目的本地原文目录</button>}
    <p>读取歌曲歌词时保存可用 LRC / TXT 的原始内容。这里的“最近保存”只表示历史中最近确认的版本；文件当前是否存在、是否改动，以重新读取歌词的结果为准。</p>
    {!localPage?.items.length&&<p>{busy?'正在读取…':'尚无本地文件原文历史。读取到这首歌曲的 LRC / TXT 后，会在这里保存版本。'}</p>}
    {localPage?.items.map(version=><div className="lyrics-document-version" key={version.id}><div><strong>{version.label}{version.lastKnown?' · 最近保存':''}{version.scope!==localPage.scope?' · 旧曲目范围':''}</strong><small>{version.encoding} · {version.rawBytes} 字节 · {version.lineCount} 行 · {new Date(version.createdAt).toLocaleString()}</small></div><button disabled={disabled} onClick={()=>void viewLocal(version.id)}>查看原文</button><button disabled={disabled} onClick={()=>void copyLocal(version.id)}>复制为导入草稿</button></div>)}
    {localPage?.nextCursor&&<button disabled={disabled} onClick={()=>void reading(()=>reloadLocal(localPage.nextCursor!))}>更多原文版本</button>}
    {localViewing&&<section className="lyrics-document-preview"><h3>{localViewing.summary.label}</h3><LyricsContext value={localViewing.preview.scopeSnapshot}/><p>{localViewing.summary.encoding} · {localViewing.summary.rawBytes} 字节</p><small className="lyrics-document-hash">原始内容 SHA-256：{localViewing.summary.rawSha256}</small><textarea aria-label="本地歌词历史原文" rows={10} readOnly value={localViewing.preview.text}/><button disabled={disabled} onClick={()=>void copyLocal(localViewing.summary.id)}>复制为导入草稿</button></section>}
   </>}
   {tab==='changes'&&<>{!changes?.items.length&&<p>{busy?'正在读取…':'暂无文档修订记录。'}</p>}{changes?.items.map(change=><div className="lyrics-document-change" key={change.commandId}><strong>{actionNames[change.action]} · {change.label}</strong><small>修订 {change.revision} · {new Date(change.createdAt).toLocaleString()}</small><button disabled={disabled} onClick={()=>{setTab('versions');void viewVersion(change.documentId,change.label);}}>查看此版本</button></div>)}{changes?.nextCursor&&<button disabled={disabled} onClick={()=>void readChanges(changes.nextCursor!)}>更多记录</button>}</>}
  </div>
  <footer><button disabled={disabled} onClick={()=>void reading(async()=>{await reload();if(tab==='local')await reloadLocal();})}>重新读取</button>{pending&&<button disabled={busy} onClick={()=>void submit()}>核对上次保存结果</button>}{tab==='import'&&<button className="primary-button" disabled={blocked||!preview} onClick={importVersion}>确认保存新版本</button>}<button disabled={disabled} onClick={onClose}>关闭</button></footer>
 </div></div>;
}
