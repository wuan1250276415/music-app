import React,{useState} from 'react';
import type {LyricsBundle,LyricsPreference} from '../shared/contracts';
import {orderedLyricsSources,effectiveLyricsSelection} from '../shared/lyrics-selection';

const kinds={embedded:'内嵌',sidecar:'本地文件',imported:'用户导入'};
export function LyricsControls({bundle,busy,pending,error,save,retry,reload}:{bundle:LyricsBundle;busy:boolean;pending:boolean;error:string;save:(preference:LyricsPreference)=>void;retry:()=>void;reload:()=>void}):React.JSX.Element {
 const byId=new Map(bundle.sources.flatMap(source=>source.id?[[source.id,source] as const]:[])),ids=new Set(byId.keys());
 const baseline=bundle.defaultSourceIds.flatMap(id=>{const source=byId.get(id);return source?[source]:[];});
 // Unavailable choices and their offsets remain intact when unrelated display settings change.
 const initial:LyricsPreference={...bundle.preference,...(bundle.preference.sourceOrder?{sourceOrder:[...bundle.preference.sourceOrder]}:{})};
 const [draft,setDraft]=useState(initial);
 const ordered=orderedLyricsSources(baseline,draft),{primaryId}=effectiveLyricsSelection(baseline,draft),selected=byId.get(primaryId??'');
 const missingPrimary=draft.primaryId!==null&&!ids.has(draft.primaryId),missingSecondary=draft.secondaryId!==null&&!ids.has(draft.secondaryId);
 const offsetInactive=draft.offsetSourceId!==null&&draft.offsetSourceId!==primaryId;
 const secondaryUnavailable=missingSecondary||draft.secondaryId!==null&&draft.secondaryId===primaryId;
 const priorityIds=[...new Set([...(draft.sourceOrder??[]),...bundle.defaultSourceIds])],missingPriority=priorityIds.filter(id=>!ids.has(id)).length;
 const disabled=busy||pending,priorityTooLong=priorityIds.length>64;
 function primary(value:string):void {
  const id=value||null,next:LyricsPreference={...draft,primaryId:id},effective=effectiveLyricsSelection(baseline,next).primaryId;
  setDraft({...next,offsetSourceId:effective,offsetMs:0,secondaryId:next.secondaryId===effective?null:next.secondaryId,secondaryOffsetMs:next.secondaryId===effective?0:next.secondaryOffsetMs});
 }
 function priority(next:LyricsPreference):void{
  const effective=effectiveLyricsSelection(baseline,next).primaryId;
  // Automatic offsets follow one source identity. Reordering never transfers an old offset.
  if(next.primaryId===null&&effective!==primaryId){next={...next,offsetSourceId:effective,offsetMs:0,secondaryId:next.secondaryId===effective?null:next.secondaryId,secondaryOffsetMs:next.secondaryId===effective?0:next.secondaryOffsetMs};}
  setDraft(next);
 }
 function move(index:number,direction:-1|1):void{
  if(priorityTooLong||index+direction<0||index+direction>=priorityIds.length)return;
  const order=[...priorityIds];[order[index],order[index+direction]]=[order[index+direction],order[index]];priority({...draft,sourceOrder:order});
 }
 function resetPriority():void{const {sourceOrder,...rest}=draft;priority(rest);}
 const edited=JSON.stringify(initial)!==JSON.stringify(draft);
 return <details className="lyrics-settings"><summary>歌词来源与显示设置</summary><fieldset disabled={disabled}>
  <label>主歌词<select value={draft.primaryId??''} onChange={event=>primary(event.target.value)}><option value="">自动选择</option>{missingPrimary&&<option value={draft.primaryId!} disabled>原主歌词暂不可用（选择保留）</option>}{ordered.map(source=><option key={source.id} value={source.id}>{source.label} · {source.kind==='timed'?'同步':'文本'}</option>)}</select></label>
  <label>主歌词偏移（毫秒）<input type="number" step="100" min="-300000" max="300000" value={draft.offsetMs} disabled={missingPrimary||offsetInactive||!primaryId||selected?.kind!=='timed'} onChange={event=>setDraft(previous=>({...previous,offsetMs:Number(event.target.value),offsetSourceId:primaryId}))}/></label>
  <p>正值延后显示，负值提前显示。来源自带偏移 {selected?.sourceOffsetMs??0} 毫秒已单独应用。{missingPrimary?'原主歌词不可用时保留原偏移，临时回退来源不会继承该偏移。':offsetInactive?'已保存偏移属于原来源，当前自动来源暂不应用该偏移。':''}{offsetInactive&&!missingPrimary&&selected?.kind==='timed'&&<button type="button" onClick={()=>setDraft(previous=>({...previous,offsetSourceId:primaryId,offsetMs:0}))}>为当前自动来源重设偏移</button>}</p>
  <label>辅助歌词<select value={draft.secondaryId??''} onChange={event=>setDraft(previous=>({...previous,secondaryId:event.target.value||null,secondaryOffsetMs:0}))}><option value="">不选择</option>{secondaryUnavailable&&<option value={draft.secondaryId!} disabled>{missingSecondary?'原辅助歌词暂不可用（选择保留）':'与临时主歌词相同（选择保留）'}</option>}{ordered.filter(source=>source.id!==primaryId).map(source=><option key={source.id} value={source.id}>{source.label} · {source.kind==='timed'?'同步':'文本'}</option>)}</select></label>
  <label>辅助歌词偏移（毫秒）<input type="number" step="100" min="-300000" max="300000" value={draft.secondaryOffsetMs} disabled={secondaryUnavailable||!draft.secondaryId||byId.get(draft.secondaryId)?.kind!=='timed'} onChange={event=>setDraft(previous=>({...previous,secondaryOffsetMs:Number(event.target.value)}))}/></label>
  <label className="lyrics-checkbox"><input type="checkbox" checked={draft.showSecondary} onChange={event=>setDraft(previous=>({...previous,showSecondary:event.target.checked}))}/>显示辅助歌词／双语</label>
  <label>字号<select value={draft.fontSize} onChange={event=>setDraft(previous=>({...previous,fontSize:Number(event.target.value)}))}>{Array.from({length:19},(_,index)=>index+14).map(size=><option key={size} value={size}>{size}</option>)}</select></label>
  <section className="lyrics-priority" aria-label="自动歌词来源优先级"><h4>自动来源优先级</h4><p>自动选择使用最靠前的可用来源；已指定的主歌词保持原选择。新增来源追加，缺失来源的排序记录保留。</p><ol>{priorityIds.map((id,index)=>{const source=byId.get(id);return <li key={id}><div><strong>{index+1}. {source?.label??`暂不可用的来源 ${id.slice(0,10)}…`}</strong><small>{source?`${source.sourceKind?kinds[source.sourceKind]:'歌词'} · ${source.kind==='timed'?'同步':'文本'}${source.language?` · ${source.language}`:''}`:'恢复相同内容后继续沿用此优先级'}</small></div><button type="button" aria-label={`上移优先级 ${source?.label??id.slice(0,10)}`} disabled={index===0||priorityTooLong} onClick={()=>move(index,-1)}>↑</button><button type="button" aria-label={`下移优先级 ${source?.label??id.slice(0,10)}`} disabled={index===priorityIds.length-1||priorityTooLong} onClick={()=>move(index,1)}>↓</button></li>;})}</ol>
   {!priorityIds.length&&<p>当前没有可用来源；保存的选择与优先级仍保留。</p>}
   {priorityTooLong&&<p role="status">保留项与新增来源超过 64 条，请先清除缺失来源的优先级记录再排序。</p>}
   <div className="lyrics-priority-actions"><button type="button" disabled={draft.sourceOrder===undefined} onClick={resetPriority}>恢复默认自动顺序</button>{missingPriority>0&&<button type="button" onClick={()=>priority({...draft,sourceOrder:(draft.sourceOrder??[]).filter(id=>ids.has(id))})}>清除 {missingPriority} 个缺失优先项</button>}</div><p>清除只移除排序记录，不删除歌词或主、辅助来源的选择。当前自动候选：{ordered[0]?.label??'暂无'}。</p>
  </section>
  <button type="button" disabled={!edited} onClick={()=>save(draft)}>保存此曲设置</button>
 </fieldset><div className="lyrics-settings-actions"><button disabled={busy||pending} onClick={reload}>重新读取歌词</button>{pending&&<button disabled={busy} onClick={retry}>核对上次保存结果</button>}</div>
 {selected&&<p>{selected.encoding??'未记录编码'}{selected.language?` · 语言 ${selected.language}`:''}{selected.descriptor?` · ${selected.descriptor}`:''}</p>}
 <p>也支持同名语言文件，如“曲名.zh.lrc”。同步辅助歌词仅配对相差不超过 750 毫秒的行；纯文本单独展示。设置不会改写音乐或歌词文件。</p>
 {bundle.notice&&<p role="status">{bundle.notice}</p>}{pending&&<p role="status">上次保存结果尚未确认，请核对后再修改。</p>}{error&&<p className="lyrics-settings-error" role="alert">{error}</p>}
 </details>;
}
