import React,{useEffect,useRef,useState} from 'react';
import {readHistoryExportScope,readHistoryExportState,readHistoryExportResult,type HistoryExportScope,type HistoryExportState,type HistoryExportFormat} from '../shared/history-export';

const activePhases=['choosing','preparing','running','stopping','publishing'];
export function HistoryExportControls({scope,disabled}:{scope:HistoryExportScope;disabled:boolean}):React.JSX.Element{
 const [state,setState]=useState<HistoryExportState|null>(null),[format,setFormat]=useState<HistoryExportFormat>('jsonl'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),flight=useRef(false),stamp=useRef(0),epoch=useRef(0);
 const active=state!==null&&activePhases.includes(state.phase);
 async function refresh():Promise<void>{
  if(!alive.current)return;
  const token=++epoch.current,events=stamp.current;
  try{const value=readHistoryExportState(await window.music.historyExportState());if(alive.current&&epoch.current===token&&stamp.current===events)setState(value);}
  catch(e){if(alive.current&&epoch.current===token){setState(null);setError(String(e instanceof Error?e.message:e).slice(0,1024));}}
 }
 useEffect(()=>{
  alive.current=true;const stop=window.music.onEvent(e=>{if(e.event==='historyExportChanged'){stamp.current++;try{setState(readHistoryExportState(e.payload));}catch{setState(null);setError('导出状态无法核对，请刷新状态。');}}});void refresh();
  return()=>{alive.current=false;epoch.current++;stop();};
 },[]);
 async function start():Promise<void>{
  if(flight.current||disabled||active||!state)return;flight.current=true;setBusy(true);setError('');
  try{const request={operationId:crypto.randomUUID(),format,scope:readHistoryExportScope(scope)},raw=await window.music.exportPlaybackHistory(request);if(raw!==null){const result=readHistoryExportResult(raw);if(result.format!==request.format)throw new Error('导出结果与选择格式不符');}await refresh();}
  catch(e){if(alive.current)setError(String(e instanceof Error?e.message:e).slice(0,1024));await refresh();}
  finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 async function cancel():Promise<void>{
  if(!state?.operationId||!['preparing','running'].includes(state.phase))return;setError('');
  try{const accepted=await window.music.cancelHistoryExport(state.operationId);if(typeof accepted!=='boolean')throw new Error('停止导出回应无效');if(!accepted&&alive.current)setError('导出状态已变化，请查看当前状态。');await refresh();}
  catch(e){if(alive.current)setError(String(e instanceof Error?e.message:e).slice(0,1024));}
 }
 return <details className="history-export-controls"><summary>导出播放历史</summary>
  <p>导出当前搜索与“仅此曲目”范围内全部已保存记录，包含当时的歌曲资料、规则、时长和计次依据。关闭面板不会停止导出；重新打开可查看状态。导出不会删除历史，也不能代替完整曲库备份。</p>
  <label>文件格式<select value={format} disabled={busy||active||disabled} onChange={e=>setFormat(e.target.value as HistoryExportFormat)}><option value="jsonl">JSONL（完整资料与规则）</option><option value="csv">CSV（表格查看）</option></select></label>
  <p>CSV会为可能被表格软件作为公式的文字加保护前缀；需要保留原始文字时选择JSONL。文件末尾包含完成标记与内容摘要，中断的文件不能视为完整导出。</p>
  {state?.request&&state.phase!=='idle'&&<p>该次范围：{state.request.scope.itemId?'仅所选曲目':'全部曲目'}{state.request.scope.query?` · 搜索“${state.request.scope.query}”`:''} · {state.request.format.toUpperCase()}</p>}
  {state&&state.phase!=='idle'&&<p role="status">{state.message} 已处理 {state.rows.toLocaleString()} 条 · {(state.bytes/1024/1024).toFixed(2)} MiB</p>}
  {state?.result&&<p>文件：{state.result.name}{state.result.pending>0?`；导出请求时还有 ${state.result.pending} 项待保存数据。`:''}{state.result.publication==='exclusive-copy'?' 此保存位置使用复制发布；请保留文件末尾的完成记录。':''}</p>}
  {error&&<p className="error" role="alert">{error}</p>}
  <div><button type="button" disabled={busy||active||disabled||!state} onClick={()=>void start()}>导出当前范围</button><button type="button" disabled={!state||!['preparing','running'].includes(state.phase)} onClick={()=>void cancel()}>停止导出</button><button type="button" onClick={()=>void refresh()}>刷新导出状态</button></div>
 </details>;
}
