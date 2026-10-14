import React,{useEffect,useRef,useState} from 'react';
import type {PlaybackState,AudioDeviceList,AudioOutputView,AudioOutputMode,AudioOutputRequest,AudioDeviceWatchState} from '../shared/contracts';
import {useFocus,trap} from './dialog-focus';
import './output.css';
import {AudioCapabilities} from './audio-capabilities';
import {AudioBackendSettings} from './audio-backend-settings';
import {AsioPlaybackInfo} from './asio-playback-info';
import {AsioOutputSettings} from './asio-output-settings';
import {defaultProcessing,processingEnabled} from '../shared/audio-processing';
const modeNames={shared:'共享（兼容）',exclusive:'独占（原始格式）','exclusive-convert':'独占（允许转换）'};
export function AudioOutputDialog({playback,onClose}:{playback:PlaybackState;onClose:()=>void}):React.JSX.Element{
 const [view,setView]=useState<AudioOutputView|null>(null),[catalog,setCatalog]=useState<AudioDeviceList|null>(null),[deviceId,setDeviceId]=useState(''),[mode,setMode]=useState<AudioOutputMode>('shared'),[dsdPolicy,setDsdPolicy]=useState<'stop'|'pcm'>('stop');
 const [busy,setBusy]=useState(false),[pending,setPending]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const dialog=useRef<HTMLDivElement|null>(null),alive=useRef(true),working=useRef(false),attempt=useRef<AudioOutputRequest|null>(null);
 const [watch,setWatch]=useState<AudioDeviceWatchState|null>(null),[deviceStale,setDeviceStale]=useState(false);
 const [processing,setProcessing]=useState(defaultProcessing);
 const [showAsio,setShowAsio]=useState(false);
 const watchRevision=useRef(0),catalogRevision=useRef<number|null>(null);
 function observeWatch(state:AudioDeviceWatchState):void{
  if(!state||!Number.isSafeInteger(state.revision)||state.revision<watchRevision.current||!['starting','watching','unavailable','stopped'].includes(state.status)||typeof state.message!=='string'||!Array.isArray(state.reasons))return;
  watchRevision.current=state.revision;setWatch(state);if(catalogRevision.current!==null&&catalogRevision.current!==state.revision)setDeviceStale(true);
 }
 useFocus(dialog);
 async function reload():Promise<void>{
  const results=await Promise.allSettled([window.music.audioOutput(),window.music.audioDevices()]);if(!alive.current)return;
  const latestWatch=await window.music.audioDeviceWatch();if(!alive.current)return;observeWatch(latestWatch);
  if(results[0].status==='rejected')throw results[0].reason;const current=results[0].value;setView(current);attempt.current=current.pendingRequest;setPending(Boolean(current.pendingRequest));
  const p=current.pendingRequest??current.preference;setDeviceId(p.deviceId??'');setMode(p.mode);setDsdPolicy(p.dsdPolicy);setProcessing({...p.processing});setStale(false);
  if(results[1].status==='fulfilled'){catalogRevision.current=results[1].value.deviceRevision;setDeviceStale(catalogRevision.current!==watchRevision.current);setCatalog(results[1].value);setError('');}else{catalogRevision.current=null;setDeviceStale(true);setCatalog(null);setError(`设备列表未读取：${String(results[1].reason)}`);}
 }
 async function reading():Promise<void>{if(working.current)return;working.current=true;setBusy(true);setError('');try{await reload();}catch(e){if(alive.current)setError(String(e));}finally{working.current=false;if(alive.current)setBusy(false);}}
 useEffect(()=>{alive.current=true;void reading();const stop=window.music.onEvent(event=>{if(event.event==='audioOutputChanged'&&!working.current)setStale(true);if(event.event==='audioDevicesChanged')observeWatch(event.payload as AudioDeviceWatchState);if(event.event==='asioPanelChanged')setDeviceStale(true);});return()=>{alive.current=false;stop();};},[]);
 useEffect(()=>{if(busy)dialog.current?.focus();},[busy]);
 async function submit(retry=false):Promise<void>{
  if(working.current||!view||!retry&&(pending||stale||deviceStale||mode==='exclusive'&&processingEnabled(processing)))return;const r=retry?attempt.current:{commandId:crypto.randomUUID(),baseRevision:view.preference.revision,deviceId:deviceId||null,mode,dsdPolicy,processing:{...processing}};if(!r)return;
  working.current=true;attempt.current=r;setBusy(true);setPending(true);setError('');setNotice('');
  try{
   const result=await window.music.configureAudioOutput(r);if(!alive.current)return;
   if(result.status==='unknown'){setError(result.error);return;}
   attempt.current=null;setPending(false);setView({preference:result.preference,pendingCommandId:null,pendingRequest:null});setStale(true);
   if(result.status==='rejected'){setError(result.error);return;}
   const fresh=await window.music.audioOutput();if(!alive.current)return;setView(fresh);const p=fresh.preference;setDeviceId(p.deviceId??'');setMode(p.mode);setDsdPolicy(p.dsdPolicy);setProcessing({...p.processing});setStale(false);
   setNotice(result.error||`已保存输出设置${result.playback.state==='paused'?'，继续保持暂停':result.playback.state==='playing'?'，已恢复当前曲目':'，下次播放使用所选设备'}。`);
  }catch(e){if(alive.current)setError(`操作结果尚未确认，请核对原操作：${String(e)}`);}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 async function reconnect():Promise<void>{
  if(working.current)return;working.current=true;setBusy(true);setError('');
  try{const state=await window.music.restartAudioDeviceWatch();if(!alive.current)return;observeWatch(state);await reload();}
  catch(e){if(alive.current)setError(String(e));}finally{working.current=false;if(alive.current)setBusy(false);}
 }
 const capabilityDevice=catalog?.devices.find(d=>deviceId?d.id===deviceId:d.isDefault);
 const selected=catalog?.devices.find(device=>device.id===deviceId),missing=Boolean(deviceId&&!selected),disabled=busy||pending||!view,actual=playback.actualOutput;
 return <div className="collection-backdrop"><div ref={dialog} className="collection-dialog catalog-dialog audio-output-dialog" role="dialog" aria-modal="true" aria-label="输出设备与播放设置" tabIndex={-1} onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
  <header><div><h2>输出设备与播放设置</h2><p>分别保存播放后端、WASAPI 设置和 ASIO 驱动配置。</p></div><button disabled={busy} aria-label="关闭输出设置" onClick={onClose}>×</button></header>
  <AudioBackendSettings playback={playback}/>
  <h3>WASAPI 设置</h3>
  {error&&<p className="output-error" role="alert">{error}</p>}{notice&&<p className="output-notice" role="status">{notice}</p>}{pending&&<p role="status">正在核对保存结果。可稍后核对同一操作；暂停修改其他设置。</p>}{stale&&<p role="status">设置已变化或提交被拒绝，请重新读取后再修改。</p>}
  {deviceStale&&<p className="output-notice" role="status">设备或默认输出已变化，旧列表与格式报告已过期。请重新读取后再保存设置。</p>}
  {watch&&watch.status!=='watching'&&<p role="status">{watch.message}；设备列表仍可手动刷新。<button disabled={busy||watch.status==='starting'} onClick={()=>void reconnect()}>重新连接设备通知</button></p>}
  <fieldset disabled={disabled||stale} className="output-fields"><label>输出设备<select value={deviceId} onChange={event=>setDeviceId(event.target.value)}><option value="">系统默认输出（每次打开时确定）</option>{missing&&<option value={deviceId}>已保存设备：{view?.preference.deviceName??'未连接'}（当前未发现）</option>}{catalog?.devices.map(device=><option key={device.id} value={device.id}>{device.name}{device.isDefault?' · 系统默认':''}</option>)}</select></label>
   <label>输出模式<select value={mode} onChange={event=>setMode(event.target.value as AudioOutputMode)}>{Object.entries(modeNames).map(([id,name])=><option value={id} key={id}>{name}</option>)}</select></label>
   <label>DSD 播放策略<select value={dsdPolicy} onChange={event=>setDsdPolicy(event.target.value as 'stop'|'pcm')}><option value="stop">遇到 DSD 停止</option><option value="pcm">明确允许 DSD 转 PCM</option></select></label>
   <label>数字音量 · {processing.volumeDb} dB<input aria-label="数字音量" type="range" min={-60} max={0} step={1} value={processing.volumeDb} onChange={event=>setProcessing(p=>({...p,volumeDb:Number(event.target.value)}))}/></label>
   <label className="output-check"><input type="checkbox" checked={processing.muted} onChange={event=>setProcessing(p=>({...p,muted:event.target.checked}))}/>静音（应用处理；播放栏可实时调整）</label>
   <label>ReplayGain<select value={processing.replayGain} onChange={event=>setProcessing(p=>({...p,replayGain:event.target.value as typeof p.replayGain}))}><option value="off">关闭</option><option value="track">曲目增益</option><option value="album">专辑增益（缺少时使用曲目）</option></select></label>
   <label>ReplayGain 预增益 · {processing.preampDb} dB<input aria-label="ReplayGain 预增益" type="range" min={-12} max={12} step={0.5} disabled={processing.replayGain==='off'} value={processing.preampDb} onChange={event=>setProcessing(p=>({...p,preampDb:Number(event.target.value)}))}/></label>
   <label className="output-check"><input type="checkbox" checked={processing.preventClipping} onChange={event=>setProcessing(p=>({...p,preventClipping:event.target.checked}))}/>源样本防削波（标签峰值调整＋限幅）</label>
   <label>Opus 增益来源<select disabled={processing.replayGain==='off'} value={processing.opusPolicy} onChange={event=>setProcessing(p=>({...p,opusPolicy:event.target.value as typeof p.opusPolicy}))}><option value="r128">R128 标签（默认）</option><option value="header-only">只用文件头部增益</option><option value="legacy-before-header">传统 ReplayGain：基于头部增益前的测量</option><option value="legacy-after-header">传统 ReplayGain：基于头部增益后的测量</option></select></label>
   <label>Opus R128 目标响度<select disabled={processing.replayGain==='off'||processing.opusPolicy!=='r128'} value={processing.opusTargetLUFS} onChange={event=>setProcessing(p=>({...p,opusTargetLUFS:Number(event.target.value) as -23|-18}))}><option value={-23}>−23 LUFS（标签原始基准）</option><option value={-18}>−18 LUFS（额外 +5 dB，仍受保护限制）</option></select></label>
  </fieldset>
  {mode==='exclusive'&&processingEnabled(processing)&&<p role="alert">原始格式独占模式不允许音量、静音或 ReplayGain。请关闭处理，或选择共享／允许转换的独占模式。</p>}
  {processing.replayGain!=='off'&&<p>读取已有标签，不自动分析响度；缺少有效标签时不加预增益。Opus 总会应用文件头部增益，默认只追加 R128，忽略传统 ReplayGain；选择传统标签前需确认其测量基准。其他格式的旧曲库可重新扫描补读。</p>}
  {missing&&<p>已保存设备当前未发现。重新连接后刷新列表，或明确选择其他输出设备。</p>}{(catalog?.truncated||catalog?.incomplete)&&<p>设备列表达到上限或部分条目不可读取，列表可能不完整。</p>}
  <p>切换会中断并重新打开输出，保留当前曲目、播放位置和暂停状态。所选设备不可用时停止并说明原因，不自动改用其他声卡。</p>
  {dsdPolicy==='pcm'&&mode==='exclusive'&&<p>原始格式独占模式不允许 DSD 转 PCM；播放 DSD 时需选择共享或允许转换的独占模式。</p>}
  {capabilityDevice&&!deviceStale&&<AudioCapabilities key={`${capabilityDevice.id}:${catalog?.observedAt}`} device={capabilityDevice} disabled={busy||pending||stale}/>}
  {actual&&<section className="output-actual"><h3>{playback.state==='playing'||playback.state==='paused'?'本次会话的实际输出':'最近会话的输出信息'}</h3><p>{actual.deviceName}</p><p>{actual.mode==='shared'?'共享':'独占'} · {actual.deviceFormat} · {(actual.deviceSampleRate/1000).toFixed(1)} kHz · {actual.deviceChannels} 声道{actual.adapterConversion?' · 输出适配转换':''}</p><small>这些参数来自宿主打开结果，尚未通过设备数字输出认证。</small></section>}
  <AsioPlaybackInfo value={playback.asio}/>
  <button disabled={busy} aria-expanded={showAsio} aria-controls="asio-output-settings" onClick={()=>setShowAsio(value=>!value)}>{showAsio?'收起':'展开'} ASIO 驱动配置</button>
  {showAsio&&<div id="asio-output-settings"><AsioOutputSettings playback={playback}/></div>}
  <footer>{busy&&<button onClick={()=>void window.music.stop().catch(e=>{if(alive.current)setError(String(e));})}>停止播放</button>}<button disabled={busy} onClick={()=>void reading()}>重新读取设置与设备</button>{pending?<button disabled={busy||!attempt.current} onClick={()=>void submit(true)}>核对上次保存结果</button>:<button className="primary-button" disabled={disabled||stale||deviceStale||missing||!catalog||playback.state==='preparing'||mode==='exclusive'&&processingEnabled(processing)} onClick={()=>void submit()}>保存 WASAPI 设置</button>}<button disabled={busy} onClick={onClose}>关闭</button></footer>
 </div></div>;
}
