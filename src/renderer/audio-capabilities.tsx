import React,{useEffect,useRef,useState} from 'react';
import type {AudioDevice,AudioDeviceCapabilities,AudioFormatCandidate} from '../shared/contracts';
function label(f:AudioFormatCandidate):string{return `${f.format==='float'?'浮点':f.format==='unknown'?'其他格式':'整数'} ${f.validBits} 位${f.containerBits!==f.validBits?`（${f.containerBits} 位容器）`:''} · ${f.channels} 声道`;}
export function AudioCapabilities({device,disabled}:{device:AudioDevice;disabled:boolean}):React.JSX.Element{
 const [result,setResult]=useState<AudioDeviceCapabilities|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),working=useRef(false);useEffect(()=>{alive.current=true;const off=window.music.onEvent(event=>{if(event.event==='asioPanelChanged')setResult(null);});return()=>{alive.current=false;off();};},[]);
 async function inspect():Promise<void>{
  if(working.current||disabled)return;working.current=true;setBusy(true);setResult(null);setError('');
  try{const report=await window.music.audioDeviceCapabilities(device.id);if(alive.current){if(report.deviceId!==device.id)throw new Error('设备选择已变化，请重新读取');setResult(report);}}
  catch(e){if(alive.current)setError(String(e));}finally{working.current=false;if(alive.current)setBusy(false);}
 }
 const groups=new Map<string,{format:AudioFormatCandidate;rates:number[]}>();
 for(const row of result?.exclusiveProbes??[])if(row.status==='reported'){
  const key=JSON.stringify([row.format,row.validBits,row.containerBits,row.channels,row.channelMask,row.representation]),group=groups.get(key)??{format:row,rates:[]};group.rates.push(row.sampleRate);groups.set(key,group);
 }
 const errors=result?.exclusiveProbes.filter(row=>row.status==='error').length??0;
 return <section className="output-capabilities"><div className="output-capabilities-heading"><h3>设备报告的格式</h3><button disabled={disabled||busy} onClick={()=>void inspect()}>{busy?'正在查询…':result?'重新查询':'读取所选设备格式'}</button></div><p>{device.name}</p>
  {error&&<p className="output-error" role="alert">{error}</p>}{busy&&<p role="status">正在读取驱动报告；当前播放设置保持原样。</p>}
  {result&&<><small>查询时间：{new Date(result.observedAt).toLocaleString()} · 驱动报告值</small>
   <p>共享模式：{result.mixFormat?`${label(result.mixFormat)} · ${result.mixFormat.sampleRate/1000} kHz`:'共享格式暂时未读取'}。</p>
   {result.periods&&<p>报告处理周期：默认 {Number(result.periods.default100ns)/10000} ms，最小 {Number(result.periods.minimum100ns)/10000} ms。</p>}
   <details><summary>独占模式候选组合（{result.exclusiveProbes.filter(row=>row.status==='reported').length} 项被驱动接受）</summary>
    {groups.size?<ul>{[...groups].map(([key,group])=><li key={key}><strong>{label(group.format)} · {group.format.representation==='extensible'?'扩展格式':'常规格式'}</strong><span>{group.rates.map(rate=>rate/1000).join(' / ')} kHz</span></li>)}</ul>:<p>本次候选范围内没有获得独占支持报告；其他格式仍可能可用。</p>}
   </details>
   {result.incomplete&&<p>部分信息未读取{errors?`，其中 ${errors} 个格式组合查询失败`:''}；失败项不按“不支持”处理。</p>}
   <p>只查询常见 PCM 组合，不代表设备全部能力。共享格式与独占支持分别读取；设备占用、独占权限和实际播放仍由打开时确认。</p>
   <small>驱动／固件版本暂未读取，结果不会保存为跨会话能力缓存。未据此启用 DSD Native／DoP 或标记数字输出认证。</small>
  </>}
 </section>;
}
