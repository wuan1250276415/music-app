import {drawingDimensions,drawingColors,useDrawingEnvironment} from './drawing-environment';
import React,{useEffect,useRef,useState} from 'react';
import type {AudioAnalysisFrame,AudioAnalysisStatus,PlaybackState} from '../shared/contracts';
import './visualization.css';

type Mode='spectrum'|'waveform';
export function AudioVisualization({playback}:{playback:PlaybackState}):React.JSX.Element{
 const environment=useDrawingEnvironment();
 const [analysisStatus,setAnalysisStatus]=useState<AudioAnalysisStatus|null>(null);
 const canvas=useRef<HTMLCanvasElement|null>(null),[enabled,setEnabled]=useState(true),[mode,setMode]=useState<Mode>('spectrum'),[frame,setFrame]=useState<AudioAnalysisFrame|null>(null),[error,setError]=useState(''),[size,setSize]=useState(0),[full,setFull]=useState(Boolean(document.fullscreenElement));
 useEffect(()=>{const changed=()=>setFull(Boolean(document.fullscreenElement));document.addEventListener('fullscreenchange',changed);return()=>{document.removeEventListener('fullscreenchange',changed);if(document.fullscreenElement?.classList.contains('app-shell'))void document.exitFullscreen().catch(()=>{});};},[]);
 useEffect(()=>{if(!canvas.current)return;const observer=new ResizeObserver(()=>setSize(value=>value+1));observer.observe(canvas.current);return()=>observer.disconnect();},[]);
 useEffect(()=>{
  let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  const active=()=>enabled&&playback.state==='playing'&&!document.hidden;
  const configure=()=>{setFrame(null);void window.music.setAudioAnalysisEnabled(active()).catch(e=>{if(alive)setError(String(e));});};
  const poll=async()=>{
   try{if(active()){const [value,status]=await Promise.all([window.music.audioAnalysis(),window.music.audioAnalysisStatus()]);if(alive){setFrame(value?.itemId===playback.itemId&&(!playback.asioDsd||value.generation===playback.asioDsd.generation)?value:null);setAnalysisStatus(status);}}else if(alive){setFrame(null);setAnalysisStatus(null);}}
   catch(e){if(alive){setFrame(null);setError(String(e));}}
   if(alive)timer=setTimeout(()=>void poll(),reduced.matches?250:40);
  };
  setError('');configure();document.addEventListener('visibilitychange',configure);void poll();
  return()=>{alive=false;clearTimeout(timer);document.removeEventListener('visibilitychange',configure);void window.music.setAudioAnalysisEnabled(false).catch(()=>{});};
 },[enabled,playback.state,playback.itemId,playback.asioDsd?.generation]);
 useEffect(()=>{
  const element=canvas.current;if(!element)return;
  const rect=element.getBoundingClientRect(),{scale,width,height}=drawingDimensions(rect,window.devicePixelRatio),colors=drawingColors();
  if(element.width!==width)element.width=width;if(element.height!==height)element.height=height;const context=element.getContext('2d');if(!context)return;
  context.clearRect(0,0,width,height);context.fillStyle=colors.background;context.fillRect(0,0,width,height);
  context.strokeStyle=colors.grid;context.lineWidth=scale;
  if(mode==='spectrum'){
   for(const value of [-24,-48,-72]){const y=height*(1-(value+96)/96);context.beginPath();context.moveTo(0,y);context.lineTo(width,y);context.stroke();}
   if(frame){const gap=Math.max(1,scale),step=width/64;for(let i=0;i<64;++i){const amplitude=Math.min(1,Math.max(0,(frame.spectrumDb[i]+96)/96));const bar=amplitude*height;context.fillStyle=i<40?colors.primary:colors.secondary;context.fillRect(i*step,height-bar,Math.max(1,step-gap),bar);}}
  }else{
   context.beginPath();context.moveTo(0,height/2);context.lineTo(width,height/2);context.stroke();
   if(frame){context.strokeStyle=colors.primary;context.lineWidth=Math.max(scale,width/128);for(let i=0;i<64;++i){const [low,high]=frame.waveform[i],x=(i+.5)*width/64;context.beginPath();context.moveTo(x,(1-high)*height/2);context.lineTo(x,(1-low)*height/2);context.stroke();}}
  }
 },[frame,mode,size,environment]);
 async function toggleFull():Promise<void>{
  try{if(document.fullscreenElement)await document.exitFullscreen();else await document.querySelector<HTMLElement>('.app-shell')?.requestFullscreen();}
  catch(e){setError(String(e));}
 }
 const status=!enabled?'可视化已关闭':playback.state==='paused'?'播放已暂停':playback.state!=='playing'?'播放音乐后显示分析':analysisStatus?.message??'等待新的播放信号';
 return <section className="audio-visualization" aria-label="播放信号可视化">
  <div className="visualization-heading"><h3>播放信号</h3><button aria-pressed={enabled} onClick={()=>setEnabled(value=>!value)}>{enabled?'关闭可视化':'开启可视化'}</button><button onClick={()=>void toggleFull()}>{full?'退出全屏':'全屏播放'}</button></div>
  <div className="visualization-tabs" role="group" aria-label="可视化视图"><button aria-pressed={mode==='spectrum'} onClick={()=>setMode('spectrum')}>频谱</button><button aria-pressed={mode==='waveform'} onClick={()=>setMode('waveform')}>实时波形</button></div>
  <canvas ref={canvas} className="visualization-canvas" role="img" aria-label={mode==='spectrum'?'64 频带实时频谱，按声道能量合并':'当前 2048 帧的实时波形，包含全部声道的最小与最大值'}/>
  {frame?<><div className="visualization-axis"><span>{mode==='spectrum'?'20 Hz':'当前窗口'}</span><span>{mode==='spectrum'?`${(frame.sampleRate/2000).toFixed(1)} kHz`:`${(2048/frame.sampleRate*1000).toFixed(1)} ms`}</span></div><div className="visualization-levels">{frame.peakDb.map((peak,ch)=><div key={ch}><span>声道 {ch+1}</span><div className="visualization-meter" aria-hidden="true"><i style={{width:`${Math.min(100,Math.max(0,(frame.rmsDb[ch]+96)/96*100))}%`}}/><b style={{left:`${Math.min(99,Math.max(0,(peak+96)/96*100))}%`}}/></div><small>峰值 {peak.toFixed(1)} · RMS {frame.rmsDb[ch].toFixed(1)} dBFS</small></div>)}</div><p className="visualization-note">{frame.sampleRate.toLocaleString()} Hz · {frame.channels} 声道{frame.tap==='independent-dsd-pcm-copy'?' · 独立解码窗口':` · 分析丢弃 ${frame.droppedFrames.toLocaleString()} 帧`}{frame.invalidSamples?` · 异常样本 ${frame.invalidSamples.toLocaleString()}`:''}</p></>:<p className="visualization-note">{status}</p>}
  <p className="visualization-note">{playback.asioDsd?'原始 DSD 由独立进程解码为 176.4 kHz PCM 分析副本，不改变位流输出。窗口按播放时钟估算，滤波延迟和数值仍待验证；频谱不能作为设备输出或位完美证据。':'PCM 播放分析设备前的有效副本，不含缓冲补零。共享模式后续转换与设备输出仍需验证。'}实时波形显示当前窗口，整曲波形可在下方按需生成。</p>
  {error&&<p className="collection-error" role="alert">{error}</p>}
 </section>;
}
