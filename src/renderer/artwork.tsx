import React,{useEffect,useRef,useState} from 'react';
import type {ArtworkCandidate,LibraryItem} from '../shared/contracts';
import {artworkRequests} from './artwork-loader';

type Recovery={base:string;attempt:number;rejected:string[];started:number};
type ImageState={key:string;candidate:ArtworkCandidate|null;error?:string};
const MAX_RECOVERIES=9,RECOVERY_BUDGET_MS=90000;

function tone(label:string):string{
  let hash=0;for(const letter of label)hash=(hash*31+letter.charCodeAt(0))|0;
  return `hsl(${Math.abs(hash)%360} 42% 30%)`;
}

export function Artwork({item,revision,className,eager=false,onRetry,retrying=false,retryDisabled=false}:{item:LibraryItem|null|undefined;revision:string;className:string;eager?:boolean;onRetry?:()=>void;retrying?:boolean;retryDisabled?:boolean}):React.JSX.Element{
  const base=JSON.stringify([revision,item?.id,item?.fileId,item?.path,item?.available,eager?1024:256]);
  const [recovery,setRecovery]=useState<Recovery|null>(null),[image,setImage]=useState<ImageState|null>(null);
  const activeRecovery=recovery?.base===base?recovery:null;
  const attempt=activeRecovery?.attempt??0,rejected=activeRecovery?.rejected??[];
  const key=`${base}:retry:${attempt}:${rejected.join(',')}`;
  const activeKey=useRef(key);activeKey.current=key;
  const failedKey=useRef(''),element=useRef<HTMLSpanElement|null>(null);
  const [visible,setVisible]=useState(eager);
  const candidate=image?.key===key?image.candidate:null;

  useEffect(()=>{
    if(eager){setVisible(true);return;}
    if(!element.current||!('IntersectionObserver' in window)){setVisible(true);return;}
    // Release offscreen row leases as the library grows; keep the player eager.
    const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{rootMargin:'200px'});
    observer.observe(element.current);return()=>observer.disconnect();
  },[eager,item?.id]);

  function recover(failed:ArtworkCandidate|null,message:string):void{
    if(activeKey.current!==key||failedKey.current===key)return;
    failedKey.current=key;artworkRequests.clear(key);
    const started=activeRecovery?.started??Date.now();
    if(attempt>=MAX_RECOVERIES||Date.now()-started>=RECOVERY_BUDGET_MS){setImage({key,candidate:null,error:message});return;}
    // Re-register the original candidate once, preserving embedded-cover priority.
    // Only a repeated visible failure excludes its source and asks for a fallback.
    const nextRejected=attempt>0&&failed?[...new Set([...rejected,failed.token])]:rejected;
    if(nextRejected.length>=8){setImage({key,candidate:null,error:message});return;}
    if(!failed&&attempt>0){setImage({key,candidate:null,error:message});return;}
    setRecovery({base,attempt:attempt+1,rejected:nextRejected,started});
  }

  useEffect(()=>{
    if(!item||!visible){setImage(null);return;}
    failedKey.current='';
    let alive=true;const request=artworkRequests.acquire(key,item.id,eager,rejected);
    void request.promise.then(value=>{if(alive)setImage({key,candidate:value});}).catch(error=>{
      if(alive)recover(null,error instanceof Error?`${error.message}，可重新读取`:'封面读取失败，可重新读取');
    });
    return()=>{alive=false;request.release();};
  },[item?.id,key,visible,eager]);

  const loading=Boolean(item&&visible&&image?.key!==key);
  const cacheLabel=candidate?.cacheState==='offline'?' · 文件暂不可读取，显示已保存封面':candidate?.cacheState==='stale'?' · 重新读取失败，显示旧缓存':candidate?.cacheState==='stored'?' · 已保存封面':'';
  const status=loading?(attempt?'正在恢复歌曲封面…':'正在读取歌曲封面'):candidate?`${candidate.label}${cacheLabel}`:image?.key===key&&image.error?image.error:item?'未找到可显示的本地封面，可重新读取':'选择歌曲后显示封面';
  return <><span ref={element} className={className} aria-busy={loading} title={status} style={{background:tone(item?.album??'Aural')}}>{candidate?<img key={key} src={candidate.url} alt={`${item?.title??'歌曲'}的专辑封面`} draggable={false} onError={()=>recover(candidate,'封面无法显示，可重新读取')}/>:item?(item.album.slice(0,1)||'♫'):'♫'}</span>{className==='detail-art'&&<div className="detail-art-status"><p className="detail-art-source" role="status">{status}</p>{item&&onRetry&&<button className="detail-refresh" disabled={retryDisabled||retrying||loading} onClick={onRetry}>{retrying?'正在重新读取…':'重新读取封面'}</button>}</div>}</>;
}
