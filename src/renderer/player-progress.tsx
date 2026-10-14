import React,{useEffect,useRef,useState} from 'react';
import type {PlaybackState} from '../shared/contracts';

type Draft={context:string;itemId:string;position:number};
const seekKeys=['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'];
function time(seconds:number|null):string{
  if(seconds===null||!Number.isFinite(seconds))return '—';
  const whole=Math.max(0,Math.floor(seconds));
  return `${Math.floor(whole/60)}:${String(whole%60).padStart(2,'0')}`;
}

export function PlayerProgress({playback,entryId,seek}:{playback:PlaybackState;entryId:string|null;seek:(position:number,itemId:string)=>void}):React.JSX.Element{
  const live=playback.state==='playing'||playback.state==='paused';
  const context=JSON.stringify([playback.itemId,entryId,playback.asioDsd?.generation??playback.asio?.generation??playback.clock?.generation??null,live]);
  const [draft,setDraft]=useState<Draft|null>(null);
  const pending=useRef<Draft|null>(null),gesture=useRef<string|null>(null);
  const canSeek=Boolean(live&&playback.itemId&&playback.durationSeconds&&playback.durationSeconds>0.01);
  const max=Math.max(0,(playback.durationSeconds??0)-0.01);
  useEffect(()=>{
    pending.current=null;setDraft(null);
    // Keep the original gesture identity until release, so a drag spanning a
    // track/session change cannot create a fresh seek on the replacement track.
  },[context]);
  function cancel():void{pending.current=null;gesture.current=null;setDraft(null);}
  function commit():void{
    const target=pending.current;
    cancel();
    if(target&&target.context===context&&canSeek&&target.itemId===playback.itemId)
      seek(Math.min(target.position,max),target.itemId);
  }
  const position=draft?.context===context?draft.position:playback.positionSeconds;
  return <div className="progress"><span>{time(position)}</span><input className="progress-rail seek-slider" type="range" aria-label="播放进度，松开后跳转" min={0} max={max} step={0.01} value={Math.min(Math.max(0,position),max)} disabled={!canSeek}
    onPointerDown={()=>{gesture.current=context;}}
    onChange={event=>{
      if(!canSeek||!playback.itemId||gesture.current!==null&&gesture.current!==context)return;
      const value={context,itemId:playback.itemId,position:Number(event.target.value)};
      pending.current=value;setDraft(value);
    }}
    onPointerUp={commit} onPointerCancel={cancel}
    onKeyDown={event=>{if(seekKeys.includes(event.key)&&gesture.current===null)gesture.current=context;}}
    onKeyUp={event=>{if(seekKeys.includes(event.key))commit();}} onBlur={commit}/><span>{time(playback.durationSeconds)}</span></div>;
}
