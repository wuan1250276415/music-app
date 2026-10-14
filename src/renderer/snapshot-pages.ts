import {useCallback,useEffect,useRef,useState} from 'react';
export type SnapshotPage<T>={version:1;status:'ready'|'stale';snapshot:string;offset:number;total:number;items:T[]};
type Config<T,Q>={size:number;cachePages:number;read:(query:Q,offset:number,snapshot?:string)=>Promise<SnapshotPage<T>>};
type Page<T>={items:T[];used:number};
type Session<T,Q>={key:string;query:Q;active:boolean;pages:Map<number,Page<T>>;wanted:number[];snapshot:string|null;total:number;clock:number;stales:number;error:string};
type State<T>={key:string;generation:number;total:number;items:T[];loading:boolean;error:string;snapshot:string|null};
const empty=<T,>(key:string):State<T>=>({key,generation:0,total:0,items:[],loading:true,error:'',snapshot:null});
export function useSnapshotPages<T,Q>(query:Q,revision:number,config:Config<T,Q>){
 const key=JSON.stringify([query,revision]),session=useRef<Session<T,Q>|null>(null),flight=useRef<Promise<void>|null>(null),pump=useRef<()=>void>(()=>{});
 const [state,setState]=useState<State<T>>(()=>empty<T>(key));
 const publish=(s:Session<T,Q>)=>{if(!s.active||session.current!==s)return;setState(previous=>({key:s.key,generation:previous.generation+1,total:s.total,items:[...s.pages.entries()].sort(([a],[b])=>a-b).flatMap(([,p])=>p.items),loading:!s.snapshot,error:s.error,snapshot:s.snapshot}));};
 pump.current=()=>{
  const s=session.current;if(!s?.active||flight.current||s.error)return;
  const page=s.snapshot?s.wanted.find(index=>!s.pages.has(index)&&index*config.size<s.total):s.wanted[0]??0;if(page===undefined)return;
  const request={query:s.query,offset:page*config.size,...(s.snapshot?{snapshot:s.snapshot}:{})};
  const running=config.read(s.query,request.offset,request.snapshot).then((result:SnapshotPage<T>)=>{
   if(!s.active||session.current!==s)return;
   if(result.version!==1||!['ready','stale'].includes(result.status)||!/^[a-f0-9]{64}$/.test(result.snapshot)||result.offset!==request.offset||!Number.isSafeInteger(result.total)||result.total<0||result.total>1_000_000_000||!Array.isArray(result.items)||result.items.length>config.size)throw new Error('曲库分页回执无效');
   if(result.status==='stale'){
    s.pages.clear();s.snapshot=null;s.stales++;s.error=s.stales>=3?'曲库持续变化，已暂停读取，请稍后刷新。':'';publish(s);return;
   }
   if(request.snapshot&&result.snapshot!==request.snapshot||s.snapshot&&result.total!==s.total||result.items.length!==Math.min(config.size,Math.max(0,result.total-result.offset)))throw new Error('曲库分页范围不一致，请刷新');
   s.snapshot=result.snapshot;s.total=result.total;s.pages.set(page,{items:result.items,used:++s.clock});
   while(s.pages.size>config.cachePages){const victim=[...s.pages.entries()].filter(([p])=>!s.wanted.includes(p)).sort(([,a],[,b])=>a.used-b.used)[0];if(!victim)throw new Error('曲库分页缓存预算超限');s.pages.delete(victim[0]);}
   publish(s);
  }).catch(e=>{if(s.active&&session.current===s){s.error=String(e instanceof Error?e.message:e).slice(0,512);publish(s);}}).finally(()=>{if(flight.current===running)flight.current=null;pump.current();});
  flight.current=running;
 };
 useEffect(()=>{
  const old=session.current,preserve=old&&JSON.stringify(old.query)===JSON.stringify(query);
  const s:Session<T,Q>={key,query,active:true,pages:new Map(),wanted:preserve?[...old.wanted]:[0],snapshot:null,total:preserve?old.total:0,clock:0,stales:0,error:''};session.current=s;setState({...empty<T>(key),total:s.total});pump.current();return()=>{s.active=false;if(session.current?.key===key)session.current.active=false;};
 },[key]);
 const range=useCallback((start:number,end:number,focused?:number|null)=>{
  const s=session.current;if(!s?.active||s.key!==key||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start)return;
  const first=Math.floor(start/config.size),last=Math.min(first+config.cachePages-2,Math.floor(Math.max(start,end-1)/config.size));
  const wanted=Array.from({length:last-first+1},(_,i)=>first+i);
  if(focused!==undefined&&focused!==null&&Number.isSafeInteger(focused)&&focused>=0){const page=Math.floor(focused/config.size);if(!wanted.includes(page)&&wanted.length<config.cachePages-1)wanted.push(page);}s.wanted=wanted;
  for(const p of wanted){const value=s.pages.get(p);if(value)value.used=++s.clock;}pump.current();
 },[key,config.size,config.cachePages]);
 const itemAt=useCallback((index:number):T|undefined=>{const s=session.current;return s?.active&&s.key===key?s.pages.get(Math.floor(index/config.size))?.items[index%config.size]:undefined;},[key,config.size]);
 const retry=useCallback(()=>{const old=session.current;if(!old?.active||old.key!==key)return;old.active=false;const s:Session<T,Q>={...old,active:true,pages:new Map(),wanted:[...old.wanted],snapshot:null,clock:0,stales:0,error:''};session.current=s;publish(s);pump.current();},[key]);
 const find=useCallback((match:(item:T)=>boolean)=>{
  const s=session.current;if(!s?.active||s.key!==key||!s.snapshot||s.error)throw new Error('请等待当前浏览结果读取完成');
  for(const [page,value] of s.pages){const at=value.items.findIndex(match);if(at>=0)return {query:s.query,snapshot:s.snapshot,index:page*config.size+at,item:value.items[at]};}
  throw new Error('条目已离开当前浏览范围，请重新选择');
 },[key,config.size]);
 const pendingState={...empty<T>(key),total:session.current&&JSON.stringify(session.current.query)===JSON.stringify(query)?state.total:0};
 return {...(state.key===key?state:pendingState),key,range,itemAt,retry,find};
}
