import React,{useEffect,useRef,useState} from 'react';
import type {AudioOutputView,AudioOutputRequest,PlaybackState} from '../shared/contracts';
import './volume.css';
import {AsioPlayerVolume} from './asio-player-volume';
function WasapiPlayerVolume({playback}:{playback:PlaybackState}):React.JSX.Element{
 const [view,setView]=useState<AudioOutputView|null>(null),[db,setDb]=useState(0),[muted,setMuted]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const alive=useRef(false),latest=useRef<AudioOutputView|null>(null),working=useRef(false),timer=useRef<ReturnType<typeof setTimeout>|null>(null),wanted=useRef<{volumeDb:number;muted:boolean}|null>(null),attempt=useRef<AudioOutputRequest|null>(null);
 function accept(value:AudioOutputView):void{
  if(!alive.current||latest.current&&value.preference.revision<latest.current.preference.revision)return;
  latest.current=value;setView(value);if(!working.current&&!wanted.current){setDb(value.preference.processing.volumeDb);setMuted(value.preference.processing.muted);}
 }
 function arm():void{if(!timer.current&&!working.current)timer.current=setTimeout(()=>{timer.current=null;void submit();},100);}
 function change(volumeDb:number,mute:boolean):void{setDb(volumeDb);setMuted(mute);wanted.current={volumeDb,muted:mute};arm();}
 async function submit(retry=false):Promise<void>{
  if(working.current||!alive.current)return;const current=latest.current;if(!current)return;
  if(current.pendingCommandId&&!retry){wanted.current=null;setMessage('设置保存尚未确认，请先核对');return;}
  const target=wanted.current;if(!retry&&!target)return;wanted.current=null;
  const p=current.preference,r=retry?attempt.current:{commandId:crypto.randomUUID(),baseRevision:p.revision,deviceId:p.deviceId,mode:p.mode,dsdPolicy:p.dsdPolicy,processing:{...p.processing,...target}};
  if(!r)return;attempt.current=r;working.current=true;setBusy(true);setMessage('');
  try{
   const result=await window.music.configureAudioVolume(r);if(!alive.current)return;
   if(result.status==='unknown'){wanted.current=null;accept(await window.music.audioOutput());setMessage(result.error||'音量保存尚未确认');}
   else{accept({preference:result.preference,pendingCommandId:null,pendingRequest:null});attempt.current=null;if(result.status==='rejected'){wanted.current=null;accept(await window.music.audioOutput());}setMessage(result.error);}
  }catch(error){if(alive.current){wanted.current=null;setMessage(String(error));try{accept(await window.music.audioOutput());}catch{/* Keep the explicit retry request. */}}}
  finally{working.current=false;if(alive.current){setBusy(false);if(wanted.current)arm();else if(latest.current){setDb(latest.current.preference.processing.volumeDb);setMuted(latest.current.preference.processing.muted);}}}
 }
 useEffect(()=>{
  alive.current=true;const off=window.music.onEvent(event=>{if(event.event==='audioOutputChanged')accept(event.payload as AudioOutputView);});
  void window.music.audioOutput().then(accept).catch(error=>{if(alive.current)setMessage(String(error));});
  return()=>{alive.current=false;off();if(timer.current)clearTimeout(timer.current);timer.current=null;wanted.current=null;};
 },[]);
 const pending=Boolean(view?.pendingCommandId),preparing=playback.state==='preparing'||playback.interruption?.status==='sleeping',disabled=!view||view.preference.mode==='exclusive'||pending||preparing;
 const replanning=view?.preference.mode==='exclusive-convert'&&['playing','paused'].includes(playback.state)&&!playback.tail&&
  (playback.actualOutput?.format!=='f32'||playback.actualOutput.applicationIntegerPath);
 const controlHint=preparing?'正在准备播放，请稍后调整':disabled?'原始格式模式禁用软件音量，或设置尚未确认':replanning?'调整音量将重新打开音频并启用数字处理，保留曲目、位置和暂停状态':'平滑调整播放音量';
 return <div className="player-volume" aria-busy={busy}>
  <button aria-label={muted?'取消静音':'静音'} aria-pressed={muted} disabled={disabled} title={controlHint} onClick={()=>change(db,!muted)}>{muted?'静音':'音量'}</button>
  <input aria-label="播放音量" title={controlHint} type="range" min={-60} max={0} step={1} value={db} disabled={disabled} onChange={event=>change(Number(event.target.value),muted)}/><output>{db.toFixed(db%1?1:0)} dB</output>
  {replanning&&!message&&!pending&&<small className="volume-message" title={controlHint}>调整时启用数字处理</small>}
  {pending&&attempt.current?.commandId===view?.pendingCommandId&&<button disabled={busy} onClick={()=>void submit(true)}>核对保存</button>}
  {message&&!pending&&<button disabled={busy} onClick={()=>void window.music.audioOutput().then(value=>{accept(value);if(alive.current)setMessage('');}).catch(error=>{if(alive.current)setMessage(String(error));})}>重读音量</button>}
  {(message||pending)&&<span className="volume-message" role="status" title={message||'请在输出设置核对保存结果'}>{message||'请在输出设置核对保存结果'}</span>}
 </div>;
}

export function PlayerVolume({playback}:{playback:PlaybackState}):React.JSX.Element{
 const [backend,setBackend]=useState<'wasapi'|'asio'|null>(null),revision=useRef(-1);
 useEffect(()=>{let alive=true;const accept=(value:import('../shared/audio-backend').AudioBackendView)=>{if(alive&&value.preference.revision>=revision.current){revision.current=value.preference.revision;setBackend(value.preference.backend);}};const off=window.music.onEvent(event=>{if(event.event==='audioBackendChanged')accept(event.payload as import('../shared/audio-backend').AudioBackendView);});void window.music.audioBackend().then(accept).catch(()=>{});return()=>{alive=false;off();};},[]);
 if(backend===null)return <div className="player-volume" aria-busy="true">正在读取音量设置…</div>;
 if(playback.asioDsd&&['playing','paused','preparing'].includes(playback.state))return <div className="player-volume"><span title="原始 DSD 不应用软件音量、静音或 ReplayGain。需要数字处理时，请先在输出设置明确选择转 PCM。">设备硬件音量</span></div>;
 return backend==='asio'?<AsioPlayerVolume playback={playback}/>:<WasapiPlayerVolume playback={playback}/>;
}
