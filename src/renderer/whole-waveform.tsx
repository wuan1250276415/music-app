import {drawingDimensions,drawingColors,useDrawingEnvironment} from './drawing-environment';
import React,{useEffect,useRef,useState} from 'react';
import type {LibraryItem,PlaybackState,WaveformJob} from '../shared/contracts';
const working=(status:WaveformJob['status'])=>['queued','running','cancelling'].includes(status);
const labels:Record<WaveformJob['status'],string>={queued:'等待分析',running:'正在分析',cancelling:'等待取消完成',completed:'已完成',failed:'分析失败',cancelled:'已取消',interrupted:'已中断'};
const time=(seconds:number)=>`${Math.floor(seconds/60)}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;
export function WholeWaveform({item,playback,seek}:{item:LibraryItem|null;playback:PlaybackState;seek:(seconds:number)=>Promise<unknown>}):React.JSX.Element{
 const environment=useDrawingEnvironment();
 const canvas=useRef<HTMLCanvasElement|null>(null),alive=useRef(true),generation=useRef(0),attempt=useRef<string|null>(null),owned=useRef<string|null>(null),acting=useRef(false);
 const [job,setJob]=useState<WaveformJob|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[history,setHistory]=useState<WaveformJob[]>([]),[view,setView]=useState<[number,number]>([0,1]),[preview,setPreview]=useState<number|null>(null),[size,setSize]=useState(0);
 const key=JSON.stringify([item?.id,item?.fileId,item?.path,item?.sourceStartCueFrame,item?.sourceEndCueFrame,item?.sourceStartSeconds,item?.sourceEndSeconds]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{generation.current++;setJob(null);setView([0,1]);setPreview(null);setError('');attempt.current=null;return()=>{generation.current++;const id=owned.current;owned.current=null;if(id)void window.music.cancelWaveform(id).catch(()=>{});};},[key]);
 useEffect(()=>window.music.onEvent(event=>{if(event.event!=='libraryChanged')return;generation.current++;const id=owned.current;owned.current=null;attempt.current=null;setJob(null);setView([0,1]);setPreview(null);setError('曲库已变化，请重新核对波形；内容未变时可以复用缓存。');if(id)void window.music.cancelWaveform(id).catch(()=>{});}),[key]);
 useEffect(()=>{if(!canvas.current)return;const observer=new ResizeObserver(()=>setSize(value=>value+1));observer.observe(canvas.current);return()=>observer.disconnect();},[]);
 useEffect(()=>{
  if(!job||!working(job.status))return;let active=true,timer:ReturnType<typeof setTimeout>|undefined;const id=job.id;
  const poll=async()=>{try{const value=await window.music.waveformJob(id);if(active&&alive.current){setJob(value);if(working(value.status))timer=setTimeout(()=>void poll(),500);else owned.current=null;}}catch(e){if(active&&alive.current){setError(String(e));timer=setTimeout(()=>void poll(),1500);}}};
  timer=setTimeout(()=>void poll(),500);return()=>{active=false;clearTimeout(timer);};
 },[job?.id,job?.status]);
 const summary=job?.summary??null,duration=summary?.durationSeconds??0,canSeek=Boolean(summary&&item?.id===playback.itemId&&['playing','paused'].includes(playback.state));
 const position=item?.id===playback.itemId?playback.positionSeconds:0;
 useEffect(()=>{
  const element=canvas.current;if(!element)return;const rect=element.getBoundingClientRect(),{scale,width,height}=drawingDimensions(rect,window.devicePixelRatio),colors=drawingColors();
  if(element.width!==width)element.width=width;if(element.height!==height)element.height=height;const context=element.getContext('2d');if(!context)return;context.fillStyle=colors.background;context.fillRect(0,0,width,height);context.strokeStyle=colors.grid;context.beginPath();context.moveTo(0,height/2);context.lineTo(width,height/2);context.stroke();if(!summary)return;
  const span=view[1]-view[0],needed=rect.width/span,level=summary.levels.find(value=>value.points>=needed)??summary.levels.at(-1)!;
  context.strokeStyle=colors.primary;context.lineWidth=Math.max(1,scale);
  for(let pixel=0;pixel<Math.ceil(rect.width);++pixel){const first=Math.min(level.points-1,Math.floor((view[0]+pixel/rect.width*span)*level.points)),last=Math.min(level.points,Math.max(first+1,Math.ceil((view[0]+(pixel+1)/rect.width*span)*level.points)));let low=16,high=-16;for(let i=first;i<last;++i){low=Math.min(low,level.values[i][0]);high=Math.max(high,level.values[i][1]);}context.beginPath();context.moveTo((pixel+.5)*scale,(1-Math.min(1,high))*height/2);context.lineTo((pixel+.5)*scale,(1-Math.max(-1,low))*height/2);context.stroke();}
  const fraction=(preview??position)/summary.durationSeconds;if(fraction>=view[0]&&fraction<=view[1]){context.strokeStyle=colors.position;context.lineWidth=2*scale;const x=(fraction-view[0])/span*width;context.beginPath();context.moveTo(x,0);context.lineTo(x,height);context.stroke();}
 },[summary,view,position,preview,size,environment]);
 async function request(retry=false):Promise<void>{
  if(!item||acting.current)return;const epoch=generation.current,id=retry?attempt.current:crypto.randomUUID();if(!id)return;acting.current=true;attempt.current=id;owned.current=id;setBusy(true);setError('');
  try{const value=await window.music.requestWaveform(item.id,id);if(alive.current&&generation.current===epoch){setJob(value);attempt.current=null;if(!working(value.status))owned.current=null;}else void window.music.cancelWaveform(id).catch(()=>{});}
  catch(e){if(alive.current&&generation.current===epoch)setError(String(e));}
  finally{acting.current=false;if(alive.current)setBusy(false);}
 }
 async function cancel():Promise<void>{if(!job||acting.current)return;const epoch=generation.current;acting.current=true;setBusy(true);try{const value=await window.music.cancelWaveform(job.id);if(alive.current&&epoch===generation.current)setJob(value);}catch(e){if(alive.current&&epoch===generation.current)setError(String(e));}finally{acting.current=false;if(alive.current)setBusy(false);}}
 async function jump(seconds:number):Promise<void>{if(!canSeek)return;const epoch=generation.current,limit=Math.min(duration,playback.durationSeconds??duration);try{await seek(Math.max(0,Math.min(seconds,Math.max(0,limit-.01))));if(alive.current&&epoch===generation.current)setPreview(null);}catch(e){if(alive.current&&epoch===generation.current)setError(String(e));}}
 function zoom(factor:number):void{const width=Math.min(1,Math.max(1/64,(view[1]-view[0])*factor)),center=duration?Math.max(0,Math.min(1,(preview??position)/duration)):.5,start=Math.max(0,Math.min(1-width,center-width/2));setView([start,start+width]);}
 return <section className="audio-visualization whole-waveform" aria-label="整曲波形">
  <div className="visualization-heading"><h3>整曲波形</h3><button disabled={!item||busy||Boolean(attempt.current)||Boolean(job&&working(job.status))} onClick={()=>void request()}>{summary?'重新核对文件':'生成波形'}</button>{job&&working(job.status)&&<button disabled={busy||job.status==='cancelling'} onClick={()=>void cancel()}>取消分析</button>}{attempt.current&&<button disabled={busy} onClick={()=>void request(true)}>核对上次请求</button>}</div>
  <p className="visualization-note">{job?`${labels[job.status]}${job.status==='running'?` · ${job.phase==='hashing'?'核对文件内容':'生成波形'} ${Math.round(job.progress*100)}%`:''}${job.cached?' · 内容未变，复用缓存':''}`:'按需分析本地音乐，不修改文件。'}{job?.message?` · ${job.message}`:''}</p>
  <canvas ref={canvas} className="visualization-canvas" role="img" aria-label="当前曲目范围的整曲最小最大值波形" onClick={event=>{if(!summary||!canSeek)return;const rect=event.currentTarget.getBoundingClientRect(),fraction=view[0]+Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width))*(view[1]-view[0]);void jump(fraction*duration);}}/>
  {summary&&<><div className="visualization-axis"><span>{time(view[0]*duration)}</span><span>{time(view[1]*duration)}</span></div><div className="visualization-tabs"><button disabled={view[1]-view[0]<=1/64} onClick={()=>zoom(.5)}>放大</button><button disabled={view[1]-view[0]>=1} onClick={()=>zoom(2)}>缩小</button><button onClick={()=>setView([0,1])}>整曲</button></div>{view[1]-view[0]<1&&<label className="whole-waveform-pan">移动可视范围<input type="range" min={0} max={1-(view[1]-view[0])} step={.001} value={view[0]} onChange={event=>{const start=Number(event.target.value),width=view[1]-view[0];setView([start,start+width]);}}/></label>}<input className="whole-waveform-seek" type="range" min={0} max={duration} step={.01} value={Math.min(duration,preview??position)} disabled={!canSeek} aria-label="整曲波形跳转位置" onChange={event=>setPreview(Number(event.target.value))} onPointerUp={event=>void jump(Number(event.currentTarget.value))} onKeyUp={event=>{if(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key))void jump(Number(event.currentTarget.value));}}/><p className="visualization-note">{time(duration)} · {summary.sampleRate.toLocaleString()} Hz · {summary.channels} 声道 · 峰值 {summary.peakDb} / RMS {summary.rmsDb} dBFS。CUE 按当前轨范围分析；图形汇总全部声道，并限制在 ±1。</p></>}
  {summary?.dsdConversion&&<p className="visualization-note">DSD{summary.dsdConversion.bitRate/44100} → PCM 分析副本 · 转换增益 {summary.dsdConversion.gainDb} dB；不改变播放策略。转换质量与滤波延迟待验收。</p>}
  {error&&<p className="collection-error" role="alert">{error}</p>}
  <details onToggle={event=>{if(event.currentTarget.open)void window.music.waveformJobs().then(values=>{if(alive.current)setHistory(values);}).catch(e=>{if(alive.current)setError(String(e));});}}><summary>近期分析任务</summary><button onClick={()=>void window.music.waveformJobs().then(values=>{if(alive.current)setHistory(values);}).catch(e=>{if(alive.current)setError(String(e));})}>刷新任务</button>{history.map(value=><p className="visualization-note" key={value.id}>{value.itemId===item?.id?'当前曲目':'其他曲目'} · {labels[value.status]} · {new Date(value.createdAt).toLocaleString()}</p>)}</details>
 </section>;
}
