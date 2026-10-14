import {AsioControlPanel} from './asio-control-panel';
import {AsioTransportCapabilities} from './asio-transport-capabilities';
import {DsdOutputSettings} from './dsd-output-settings';
import {asioPanelActive,type AsioPanelState} from '../shared/asio-panel';
import React,{useEffect,useRef,useState} from 'react';
import type {PlaybackState} from '../shared/contracts';
import {asioDriverId,asioBufferAllowed,sameAsioDriver,validateAsioOutputRequest,validateAsioSelection,type AsioDriverCatalog,type AsioCapabilities,type AsioOutputView,type AsioOutputRequest} from '../shared/asio-output';

export function AsioOutputSettings({playback}:{playback:PlaybackState}):React.JSX.Element {
 const [view,setView]=useState<AsioOutputView|null>(null),[catalog,setCatalog]=useState<AsioDriverCatalog|null>(null),[report,setReport]=useState<AsioCapabilities|null>(null);
 const [driverId,setDriverId]=useState(''),[channels,setChannels]=useState<number[]>([]),[frames,setFrames]=useState('0'),[conversion,setConversion]=useState(false);
 const [busy,setBusy]=useState(false),[stale,setStale]=useState(false),[expired,setExpired]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [panel,setPanel]=useState<AsioPanelState|null>(null);
 const panelRevision=useRef(-1);
 const alive=useRef(true),working=useRef(false),attempt=useRef<AsioOutputRequest|null>(null);
 const selected=catalog?.drivers.find(d=>asioDriverId(d)===driverId),pending=Boolean(attempt.current),missing=Boolean(driverId&&!selected);
 function adopt(next:AsioOutputView):void {
  setView(next);attempt.current=next.pendingRequest;const p=next.pendingRequest??next.preference;
  setDriverId(p.driver?asioDriverId(p.driver):'');setChannels([...p.outputChannels]);setFrames(String(p.bufferFrames));setConversion(p.allowConversion);setStale(false);
 }
 async function run(action:()=>Promise<void>):Promise<void>{
  if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');
  try{await action();}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 async function reload():Promise<void>{
  const results=await Promise.allSettled([window.music.asioOutput(),window.music.asioDrivers(),window.music.asioControlPanel()]);if(!alive.current)return;
  if(results[2].status==='fulfilled'&&results[2].value.revision>=panelRevision.current){panelRevision.current=results[2].value.revision;setPanel(results[2].value);}
  setReport(null);setExpired(false);
  if(results[0].status==='fulfilled')adopt(results[0].value);else throw results[0].reason;
  if(results[1].status==='fulfilled'){setCatalog(results[1].value);if(![0,2].includes(results[1].value.registryStatus))setError(`ASIO 注册表读取失败（${results[1].value.registryStatus}）`);}
  else{setCatalog(null);throw results[1].reason;}
 }
 useEffect(()=>{
  alive.current=true;void run(reload);
  const stop=window.music.onEvent(event=>{
   if(event.event==='asioOutputChanged'&&!working.current)setStale(true);
   if(event.event==='audioDevicesChanged'){setReport(null);setExpired(true);}
   if(event.event==='asioPanelChanged'){const state=event.payload as AsioPanelState;if(state.revision>=panelRevision.current){panelRevision.current=state.revision;setPanel(state);setReport(null);setExpired(true);}}
  });return()=>{alive.current=false;stop();};
 },[]);
 useEffect(()=>{if(!report)return;const timer=setTimeout(()=>setExpired(true),60000);return()=>clearTimeout(timer);},[report]);
 const stopped=playback.state==='idle'||playback.state==='error';
 async function inspect():Promise<void>{
  if(!selected||pending||stale||!stopped)return;
  const key={registryName:selected.registryName,clsid:selected.clsid};setReport(null);setExpired(false);
  await run(async()=>{const next=await window.music.asioDriverCapabilities(key);if(alive.current){setReport(next);setNotice('已读取驱动声道与缓冲观察，未创建播放缓冲或开始播放。');}});
 }
 function request():AsioOutputRequest {
  if(!view)throw new Error('ASIO 配置尚未读取');
  if(driverId&&!selected)throw new Error('所选驱动当前未发现，请刷新');
  if(!/^\d{1,5}$/.test(frames))throw new Error('缓冲大小须为 0 到 32768 的整数');
  const r=validateAsioOutputRequest({commandId:crypto.randomUUID(),baseRevision:view.preference.revision,driver:selected?{registryName:selected.registryName,clsid:selected.clsid}:null,outputChannels:channels,bufferFrames:Number(frames),allowConversion:conversion});
  if(r.driver){if(!report||expired)throw new Error('请先读取所选驱动能力');validateAsioSelection(r,report);}return r;
 }
 async function submit(retry=false):Promise<void>{
  if(working.current||!view||!retry&&(pending||stale))return;
  await run(async()=>{
   const r=retry?attempt.current:request();if(!r)return;attempt.current=r;
   try{
    const result=await window.music.configureAsioOutput(r);if(!alive.current)return;setView(result.view);
    if(result.status==='unknown'){attempt.current=r;setError(result.error||'保存结果尚未确认，请核对原操作。');return;}
    attempt.current=null;adopt(result.view);
    if(result.status==='rejected'){setError(result.error);setStale(true);return;}
    setNotice(result.error||'ASIO 配置已保存。');
   }catch(e){if(alive.current){setError(`保存结果尚未确认，请核对原操作：${e instanceof Error?e.message:String(e)}`);}}
  });
 }
 const panelActive=Boolean(panel&&asioPanelActive(panel));
 async function refreshAfterPanel(driver:import('../shared/asio-output').AsioDriverIdentity):Promise<void>{
  if(!selected||!sameAsioDriver(selected,driver)||working.current||!stopped)return;await inspect();
 }
 const disabled=busy||pending||stale||!view||panelActive,bufferValid=Boolean(report&&asioBufferAllowed(Number(frames),report.buffers));
 const mappingValid=channels.length>0&&new Set(channels).size===channels.length&&channels.every(index=>Boolean(report?.channels[index]?.containerBytes));
 return <section className="asio-settings" aria-label="ASIO 驱动配置">
  <h3>ASIO 驱动配置</h3>
  <p>保存驱动、PCM 声道映射和缓冲大小，然后在播放后端中选择 ASIO。使用 ASIO 播放时，修改配置会重新准备当前曲目。</p>
  {error&&<p className="output-error" role="alert">{error}</p>}{notice&&<p className="output-notice" role="status">{notice}</p>}
  {busy&&<p role="status">正在处理 ASIO 配置或读取驱动，请稍候。</p>}
  {pending&&<p role="status">上次保存结果尚未确认，请核对原操作后再修改配置。</p>}{stale&&<p role="status">ASIO 配置已变化或提交被拒绝，请重新读取。</p>}
  <fieldset className="output-fields" disabled={disabled}>
   <label>首选 ASIO 驱动<select value={driverId} onChange={e=>{setDriverId(e.target.value);setChannels([]);setReport(null);setExpired(false);setFrames('0');setConversion(false);}}>
    <option value="">不保存 ASIO 驱动</option>{missing&&<option value={driverId}>{view?.preference.driver?.registryName??'原操作所选驱动'}（当前未发现）</option>}
    {catalog?.drivers.map(d=><option key={asioDriverId(d)} value={asioDriverId(d)}>{d.description||d.registryName}{d.description&&d.description!==d.registryName?` · ${d.registryName}`:''}</option>)}
   </select></label>
   {selected&&<><p>读取能力会初始化所选驱动，但不会开始播放；请先停止当前播放。</p><button type="button" disabled={!stopped} onClick={()=>void inspect()}>读取所选驱动能力</button></>}
   {selected&&report&&sameAsioDriver(selected,report.identity)&&<>
    <p>{report.driverName||report.identity.registryName} · 驱动版本 {report.driverVersion} · {report.outputChannels} 个输出声道{report.currentSampleRate!==null?` · 当前 ${(report.currentSampleRate/1000).toFixed(1)} kHz`:''}<br/>缓冲：{report.buffers.minimum}–{report.buffers.maximum} 帧，首选 {report.buffers.preferred}，步长 {report.buffers.granularity}。</p>
    <AsioTransportCapabilities report={report}/>
    {report.channelsTruncated&&<p>仅列出前 256 个输出声道，未读取声道不能保存映射。</p>}
    {report.ioMode!=='pcm'&&<p>驱动 I/O 模式：{report.ioMode==='dsd'?'DSD':report.ioMode==='unreported'?'驱动未报告':'读取结果不明确'}；此处保存 PCM 配置，DSD 预设和设备档案在下方管理。</p>}
    <label>源声道数量<select value={channels.length} onChange={e=>{const count=Number(e.target.value);setChannels(c=>Array.from({length:count},(_,index)=>c[index]??-1));}}><option value={0}>请选择</option>{Array.from({length:16},(_,i)=><option value={i+1} key={i+1}>{i+1} 声道</option>)}</select></label>
    <p>按歌曲解码后的声道顺序逐项选择输出；不会自动复制、混音或补选声道。</p>
    {channels.map((channel,index)=><label key={index}>源声道 {index+1} → ASIO 输出<select value={channel} onChange={e=>setChannels(c=>c.map((v,i)=>i===index?Number(e.target.value):v))}><option value={-1}>请选择输出</option>{channel>=0&&!report.channels.some(c=>c.index===channel)&&<option value={channel}>已保存输出 {channel+1}（未读取）</option>}{report.channels.map(c=><option key={c.index} value={c.index} disabled={!c.containerBytes}>{c.index+1} · {c.name||'未命名'}{c.containerBytes?` · ${c.floating?'浮点':'整数'} ${c.validBits} bit`:' · 非 PCM 或未知格式'}</option>)}</select></label>)}
    {channels.length>0&&!mappingValid&&<p role="alert">每个源声道需选择不同、已读取且支持 PCM 的输出。</p>}
    <label>缓冲帧数（0 使用驱动首选）<input type="number" min={0} max={32768} step={1} value={frames} onChange={e=>setFrames(e.target.value)}/></label>
    {!bufferValid&&<p role="alert">缓冲值不符合驱动范围、步长或应用上限。</p>}
    <label className="output-check"><input type="checkbox" checked={conversion} onChange={e=>setConversion(e.target.checked)}/>允许 PCM 样本精度转换</label><p>允许整数／浮点精度转换；数字增益和 DSD 转 PCM 另需在播放后端中明确设置，不进行重采样或声道混音。</p>
   </>}
  </fieldset>
  <AsioControlPanel driver={selected??null} disabled={busy||pending||stale||!stopped} onReleased={driver=>{void refreshAfterPanel(driver);}}/>
  {expired&&driverId&&<p role="status">声道能力观察已过期或设备发生变化，请重新读取后保存。</p>}
  {catalog&&!catalog.drivers.length&&<p>没有发现可用的 64 位 ASIO 注册驱动。32 位驱动不在此列表中。</p>}
  {catalog&&(catalog.truncated||catalog.skipped>0)&&<p>驱动目录可能不完整：跳过 {catalog.skipped} 项{catalog.truncated?'，已达到枚举上限':''}。</p>}
  <div className="asio-actions"><button disabled={busy} onClick={()=>void run(reload)}>刷新 ASIO 配置与列表</button>{pending?<button disabled={busy} onClick={()=>void submit(true)}>核对 ASIO 原操作</button>:<button disabled={disabled||missing||Boolean(driverId&&(!report||expired||!bufferValid||!mappingValid))} onClick={()=>void submit()}>保存 ASIO 配置</button>}</div>
  <DsdOutputSettings catalog={catalog} preference={view?.preference??null} observation={expired?null:report} disabled={disabled}/>
 </section>;
}
