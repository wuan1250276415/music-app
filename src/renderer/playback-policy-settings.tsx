import React,{useEffect,useRef,useState} from 'react';
import {defaultPlaybackRule,readPlaybackPolicy,readPlaybackPolicyRequest,readPlaybackPolicyResult,matchesPlaybackPolicy,playbackRuleSummary,type PlaybackCountingRule,type PlaybackPolicyRequest,type PlaybackPolicySnapshot} from '../shared/playback-policy';

const pendingKey='aural-playback-policy-pending-v2';
function initial():{pending:PlaybackPolicyRequest|null;broken:boolean}{
 try{const raw=localStorage.getItem(pendingKey);if(raw&&raw.length>8192)throw new Error('记录过长');return {pending:raw?readPlaybackPolicyRequest(JSON.parse(raw)):null,broken:false};}
 catch{return {pending:null,broken:true};}
}
type Draft={countEnabled:boolean;percent:string;seconds:string;combine:'either'|'both';shortSeconds:string;shortPercent:string;shortRequireTail:boolean};
const draft=(r:PlaybackCountingRule):Draft=>({...r,percent:String(r.percent),seconds:String(r.seconds),shortSeconds:String(r.shortSeconds),shortPercent:String(r.shortPercent)});
export function PlaybackPolicySettings({onBusy}:{onBusy:(value:boolean)=>void}):React.JSX.Element{
 const [start]=useState(initial),[pending,setPending]=useState(start.pending),[broken,setBroken]=useState(start.broken),[current,setCurrent]=useState<PlaybackPolicySnapshot|null>(null),[form,setForm]=useState(()=>draft(start.pending?.rule??defaultPlaybackRule()));
 const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const alive=useRef(true),flight=useRef(false),epoch=useRef(0),events=useRef(0),pendingRef=useRef(pending);
 const locked=busy||loading||!!pending||broken;
 useEffect(()=>{onBusy(busy);return()=>onBusy(false);},[busy,onBusy]);
 async function load():Promise<void>{
  const token=++epoch.current,stamp=events.current;setLoading(true);setError('');
  try{const value=readPlaybackPolicy(await window.music.playbackPolicy());if(!alive.current||epoch.current!==token)return;setCurrent(value);if(!pendingRef.current)setForm(draft(value.rule));setStale(events.current!==stamp);}
  catch(e){if(alive.current&&epoch.current===token){setCurrent(null);setError(String(e instanceof Error?e.message:e).slice(0,512));}}
  finally{if(alive.current&&epoch.current===token)setLoading(false);}
 }
 useEffect(()=>{
  alive.current=true;void load();
  const stop=window.music.onEvent(e=>{if(e.event==='playbackPolicyChanged'){events.current++;setStale(true);}});
  return()=>{alive.current=false;epoch.current++;stop();};
 },[]);
 async function save(retry=false):Promise<void>{
  if(flight.current||broken||loading||!retry&&(pendingRef.current||!current||stale))return;
  flight.current=true;setBusy(true);setError('');setNotice('');
  try{
   const number=(value:string)=>/^\d+$/.test(value)?Number(value):NaN;
   const request=retry?pendingRef.current:readPlaybackPolicyRequest({commandId:crypto.randomUUID(),baseRevision:current!.revision,rule:{version:2,countEnabled:form.countEnabled,percent:number(form.percent),seconds:number(form.seconds),combine:form.combine,shortSeconds:number(form.shortSeconds),shortPercent:number(form.shortPercent),shortRequireTail:form.shortRequireTail}});
   if(!request)throw new Error('没有待核对操作');const canonical=JSON.stringify(request),prior=localStorage.getItem(pendingKey);
   if(prior&&prior!==canonical)throw new Error('另一个统计设置操作尚未核对，请重新打开设置');
   localStorage.setItem(pendingKey,canonical);pendingRef.current=request;setPending(request);
   const result=readPlaybackPolicyResult(await window.music.configurePlaybackPolicy(request));
   if(result.commandId!==request.commandId||result.status==='saved'&&(!result.value||!matchesPlaybackPolicy(result.value,request)))throw new Error('统计设置回执与原操作不符，请重试原操作');
   if(localStorage.getItem(pendingKey)!==canonical)throw new Error('待核对记录已变化，请重新打开设置');
   localStorage.removeItem(pendingKey);pendingRef.current=null;
   if(!alive.current)return;setPending(null);
   if(result.status==='rejected'){setStale(true);setError(result.error);return;}
   setNotice('原设置操作已保存。正在读取当前规则；已有记录和正在播放的曲目保留原规则。');
   await load();
  }catch(e){if(alive.current)setError(String(e instanceof Error?e.message:e).slice(0,512));}
  finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 function preserveBroken():void{
  try{const raw=localStorage.getItem(pendingKey);if(raw!==null){localStorage.setItem(pendingKey+'.invalid.'+crypto.randomUUID(),raw);if(localStorage.getItem(pendingKey)!==raw)throw new Error('操作记录已变化');localStorage.removeItem(pendingKey);}setBroken(false);setNotice('无法解析的原记录已保留为本机副本，请重新读取并核对当前规则后编辑。');void load();}
  catch(e){setError(String(e instanceof Error?e.message:e).slice(0,512));}
 }
 const set=<K extends keyof Draft>(key:K,value:Draft[K])=>setForm(old=>({...old,[key]:value}));
 return <section className="playback-policy-settings" aria-label="播放统计设置">
  <p>只调整达标次数的计算，播放历史与设备回报／估算时长继续保留。新规则从下一首开始记录的曲目生效，暂停、恢复与跳转沿用该次播放的规则；已保存历史不重新计算。</p>
  {current&&<p>当前规则：{playbackRuleSummary(current.rule)}</p>}
  {loading&&<p role="status">正在读取统计规则…</p>}{stale&&<p role="status">统计规则已变化，请重新读取后编辑。</p>}
  {broken&&<p role="alert">上次操作记录无法解析。先核对当前规则，保留原记录副本后再编辑。</p>}
  {pending&&<div role="status"><p>上次设置结果待核对，请重试同一操作。关闭后仍会保留。</p><button type="button" disabled={busy||loading||broken} onClick={()=>void save(true)}>{busy?'正在核对…':'重试原操作'}</button></div>}
  {error&&<p className="error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <fieldset disabled={locked||!current||stale}>
   <label className="playback-policy-check"><input type="checkbox" checked={form.countEnabled} onChange={e=>set('countEnabled',e.target.checked)}/>统计达标播放次数</label>
   <div className="playback-policy-grid">
    <label>曲长比例（1–100%）<input type="number" min={1} max={100} step={1} value={form.percent} onChange={e=>set('percent',e.target.value)}/></label>
    <label>播放时长（1–3600 秒）<input type="number" min={1} max={3600} step={1} value={form.seconds} onChange={e=>set('seconds',e.target.value)}/></label>
    <label>条件关系<select value={form.combine} onChange={e=>set('combine',e.target.value as Draft['combine'])}><option value="either">达到任一条件</option><option value="both">两项都达到</option></select></label>
    <label>短曲边界（0–300 秒）<input type="number" min={0} max={300} step={1} value={form.shortSeconds} onChange={e=>set('shortSeconds',e.target.value)}/></label>
    <label>短曲比例（1–100%）<input type="number" min={1} max={100} step={1} value={form.shortPercent} onChange={e=>set('shortPercent',e.target.value)}/></label>
    <label className="playback-policy-check"><input type="checkbox" checked={form.shortRequireTail} onChange={e=>set('shortRequireTail',e.target.checked)}/>短曲进度需到达对应位置</label>
   </div>
   <p>短曲边界为 0 时不单独处理短曲；未知曲长只使用时长条件。“两项都达到”可能需要重复播放同一曲目中的片段才能满足长于曲长的时长条件，跳转本身不计时。</p>
   <button type="button" onClick={()=>setForm(draft(defaultPlaybackRule()))}>载入默认条件</button>
  </fieldset>
  <div className="playback-policy-actions"><button type="button" disabled={busy||loading} onClick={()=>void load()}>重新读取当前规则</button><button type="button" disabled={locked||!current||stale} onClick={()=>void save()}>保存统计规则</button>{broken&&<button type="button" disabled={busy||loading||!current} onClick={preserveBroken}>保留原记录副本并解除编辑限制</button>}</div>
 </section>;
}
