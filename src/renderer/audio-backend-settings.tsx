import React,{useEffect,useRef,useState} from 'react';
import type {PlaybackState} from '../shared/contracts';
import {defaultProcessing,processingEnabled} from '../shared/audio-processing';
import type {AudioBackendView,AudioBackendRequest} from '../shared/audio-backend';
import type {AsioOutputView} from '../shared/asio-output';
export function AudioBackendSettings({playback}:{playback:PlaybackState}):React.JSX.Element{
 const [view,setView]=useState<AudioBackendView|null>(null),[asio,setAsio]=useState<AsioOutputView|null>(null),[backend,setBackend]=useState<'wasapi'|'asio'>('wasapi');
 const [processing,setProcessing]=useState(defaultProcessing),[dsd,setDsd]=useState<'stop'|'pcm'>('stop'),[busy,setBusy]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const alive=useRef(true),working=useRef(false),attempt=useRef<AudioBackendRequest|null>(null);
 function adopt(v:AudioBackendView):void{setView(v);attempt.current=v.pendingRequest;const p=v.pendingRequest??v.preference;setBackend(p.backend);setProcessing({...p.asioProcessing});setDsd(p.asioDsdPolicy);setStale(false);}
 async function read():Promise<void>{const [v,a]=await Promise.all([window.music.audioBackend(),window.music.asioOutput()]);if(alive.current){adopt(v);setAsio(a);}}
 async function run(action:()=>Promise<void>):Promise<void>{if(working.current)return;working.current=true;setBusy(true);setError('');try{await action();}catch(e){if(alive.current)setError(String(e));}finally{working.current=false;if(alive.current)setBusy(false);}}
 useEffect(()=>{alive.current=true;void run(read);const off=window.music.onEvent(event=>{if((event.event==='audioBackendChanged'||event.event==='asioOutputChanged')&&!working.current)setStale(true);});return()=>{alive.current=false;off();};},[]);
 async function submit(retry=false):Promise<void>{
  if(!view||working.current)return;const r=retry?attempt.current:{commandId:crypto.randomUUID(),baseRevision:view.preference.revision,backend,asioProcessing:{...processing},asioDsdPolicy:dsd};if(!r)return;attempt.current=r;setNotice('');
  await run(async()=>{const result=await window.music.configureAudioBackend(r);if(!alive.current)return;adopt(result.view);if(result.status==='unknown'){setError(result.error);return;}if(result.status==='rejected'){setStale(true);setError(result.error);return;}await read();if(alive.current)setNotice(result.error||'播放后端已保存，当前曲目和暂停状态已保留。');});
 }
 const pending=Boolean(view?.pendingRequest),disabled=busy||pending||stale||!view||playback.state==='preparing';
 const conversion=asio?.preference.allowConversion,invalid=backend==='asio'&&(!asio?.preference.driver||Boolean(asio.pendingRequest)||!conversion&&(processingEnabled(processing)||dsd==='pcm'));
 return <section className="output-actual" aria-label="播放后端"><h3>播放后端</h3>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}{stale&&<p role="status">输出设置已变化，请重新读取后再保存。</p>}
  <fieldset className="output-fields" disabled={disabled}><label>播放方式<select value={backend} onChange={e=>setBackend(e.target.value as 'wasapi'|'asio')}><option value="wasapi">WASAPI（Windows 系统输出）</option><option value="asio">ASIO（使用已保存的驱动配置）</option></select></label>
  {backend==='asio'&&<><p>驱动：{asio?.preference.driver?.description||asio?.preference.driver?.registryName||'尚未保存驱动'}。声道和缓冲在下方 ASIO 驱动配置中设置。</p>
   <label>ASIO 数字音量 · {processing.volumeDb} dB<input aria-label="ASIO 数字音量" type="range" min={-60} max={0} step={1} value={processing.volumeDb} disabled={!conversion||Boolean(playback.asioDsd&&['playing','paused','preparing'].includes(playback.state))} onChange={e=>setProcessing(p=>({...p,volumeDb:Number(e.target.value)}))}/></label>
   <label className="output-check"><input type="checkbox" checked={processing.muted} disabled={!conversion||Boolean(playback.asioDsd&&['playing','paused','preparing'].includes(playback.state))} onChange={e=>setProcessing(p=>({...p,muted:e.target.checked}))}/>ASIO 软件静音</label>
   <label>ASIO ReplayGain<select value={processing.replayGain} disabled={!conversion||Boolean(playback.asioDsd&&['playing','paused','preparing'].includes(playback.state))} onChange={e=>setProcessing(p=>({...p,replayGain:e.target.value as typeof p.replayGain}))}><option value="off">关闭</option><option value="track">曲目增益</option><option value="album">专辑增益</option></select></label>
   <label>ASIO 预增益 · {processing.preampDb} dB<input type="range" min={-12} max={12} step={0.5} value={processing.preampDb} disabled={!conversion||processing.replayGain==='off'} onChange={e=>setProcessing(p=>({...p,preampDb:Number(e.target.value)}))}/></label>
   <label className="output-check"><input type="checkbox" checked={processing.preventClipping} disabled={!conversion||Boolean(playback.asioDsd&&['playing','paused','preparing'].includes(playback.state))} onChange={e=>setProcessing(p=>({...p,preventClipping:e.target.checked}))}/>源样本防削波</label>
   <label>ASIO Opus 增益来源<select value={processing.opusPolicy} disabled={!conversion||processing.replayGain==='off'} onChange={e=>setProcessing(p=>({...p,opusPolicy:e.target.value as typeof p.opusPolicy}))}><option value="r128">R128 标签</option><option value="header-only">只用头部增益</option><option value="legacy-before-header">传统标签：头部增益前</option><option value="legacy-after-header">传统标签：头部增益后</option></select></label>
   <label>ASIO Opus 目标响度<select value={processing.opusTargetLUFS} disabled={!conversion||processing.opusPolicy!=='r128'} onChange={e=>setProcessing(p=>({...p,opusTargetLUFS:Number(e.target.value) as -23|-18}))}><option value={-23}>−23 LUFS</option><option value={-18}>−18 LUFS</option></select></label>
   <label>ASIO DSD 播放策略<select value={dsd} disabled={!conversion||Boolean(playback.asioDsd&&['playing','paused','preparing'].includes(playback.state))} onChange={e=>setDsd(e.target.value as 'stop'|'pcm')}><option value="stop">遇到 DSD 停止</option><option value="pcm">明确允许 DSD 转 PCM</option></select></label>
   <p>数字处理与 DSD 转 PCM 需允许精度转换；保持源采样率和声道数。Native／DoP 在下方 DSD 输出预设中选择；原始输出使用硬件音量，需要数字处理时先选择转 PCM。</p>
  </>}</fieldset>
  {invalid&&<p role="alert">请先保存可用 ASIO 驱动和声道配置；启用数字处理前需允许精度转换。</p>}
  <div className="asio-actions"><button disabled={busy} onClick={()=>void run(read)}>重新读取播放后端</button>{pending?<button disabled={busy} onClick={()=>void submit(true)}>核对播放后端原操作</button>:<button disabled={disabled||invalid} onClick={()=>void submit()}>保存并切换播放后端</button>}</div>
 </section>;
}
