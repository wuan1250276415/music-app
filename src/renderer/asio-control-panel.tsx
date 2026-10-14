import React,{useEffect,useRef,useState} from 'react';
import {asioPanelActive,type AsioPanelState,type AsioPanelRequest} from '../shared/asio-panel';
import {sameAsioDriver,type AsioDriverIdentity} from '../shared/asio-output';
export function AsioControlPanel({driver,disabled,onReleased}:{driver:AsioDriverIdentity|null;disabled:boolean;onReleased:(driver:AsioDriverIdentity)=>void}):React.JSX.Element{
 const [state,setState]=useState<AsioPanelState|null>(null),[busy,setBusy]=useState(false),[cancelling,setCancelling]=useState(false),[error,setError]=useState(''),[unconfirmed,setUnconfirmed]=useState(false);
 const alive=useRef(true),working=useRef(false),cancelWorking=useRef(false),revision=useRef(-1),attempt=useRef<AsioPanelRequest|null>(null),released=useRef<string|null>(null),observedActive=useRef<string|null>(null),callback=useRef(onReleased);callback.current=onReleased;
 function accept(next:AsioPanelState):void{
  if(!alive.current||next.revision<revision.current)return;revision.current=next.revision;setState(next);
  if(attempt.current?.commandId===next.operationId){attempt.current=null;setUnconfirmed(false);}
  if(!next.processReleased)observedActive.current=next.operationId;
  if(next.processReleased&&next.driverReleased&&next.driver&&next.operationId&&next.operationId===observedActive.current&&next.operationId!==released.current&&next.phase==='closed'){released.current=next.operationId;callback.current(next.driver);}
 }
 async function cancel(operationId:string):Promise<void>{
  if(cancelWorking.current)return;cancelWorking.current=true;setCancelling(true);setError('');
  try{accept(await window.music.cancelAsioControlPanel(operationId));}catch(e){if(alive.current)setError(String(e));}
  finally{cancelWorking.current=false;if(alive.current)setCancelling(false);}
 }
 async function run(action:()=>Promise<AsioPanelState>):Promise<void>{
  if(working.current)return;working.current=true;setBusy(true);setError('');
  try{accept(await action());}catch(e){if(alive.current){setError(String(e));if(attempt.current)setUnconfirmed(true);try{accept(await window.music.asioControlPanel());}catch{/* Keep the original UUID for explicit reconciliation. */}}}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 useEffect(()=>{alive.current=true;void run(()=>window.music.asioControlPanel());const off=window.music.onEvent(event=>{if(event.event==='asioPanelChanged')accept(event.payload as AsioPanelState);});return()=>{alive.current=false;off();};},[]);
 function open(retry=false):void{if(!driver&&!retry)return;const r=retry?attempt.current:{commandId:crypto.randomUUID(),driver:{registryName:driver!.registryName,clsid:driver!.clsid}};if(!r)return;attempt.current=r;void run(()=>window.music.openAsioControlPanel(r));}
 const active=Boolean(state&&asioPanelActive(state)),current=state?.driver;
 return <section className="output-actual" aria-label="ASIO 厂商控制面板"><h4>厂商控制面板</h4>
  {error&&<p role="alert">{error}</p>}{state&&<p role="status">{state.message}{active&&current?` · ${current.description||current.registryName}`:''}</p>}
  {!active&&<p>停止播放后打开所选驱动的厂商设置。面板会话占用驱动期间，不能开始播放或查询设备格式。</p>}
  {active&&<p>请在厂商窗口中完成设置；若调用已返回，请点击“完成设置并释放驱动”。关闭此设置页不会结束面板会话。单次会话最多 15 分钟。</p>}
  <div className="asio-actions">
   {unconfirmed?<button disabled={busy||cancelling} onClick={()=>open(true)}>核对原面板请求</button>:<button disabled={busy||cancelling||disabled||active||!state||!driver} onClick={()=>open()}>打开所选驱动面板</button>}
   {active&&state?.operationId&&<><button disabled={busy||cancelling||state.phase!=='returned'} onClick={()=>void run(()=>window.music.finishAsioControlPanel(state.operationId!))}>完成设置并释放驱动</button><button disabled={cancelling} onClick={()=>void cancel(state.operationId!)}>{cancelling?'正在取消…':'取消面板会话'}</button></>}
   <button disabled={busy} onClick={()=>void run(()=>window.music.asioControlPanel())}>刷新面板状态</button>
  </div>
  {!active&&state?.driver&&driver&&!sameAsioDriver(state.driver,driver)&&<small>上一次面板会话属于 {state.driver.description||state.driver.registryName}。</small>}
 </section>;
}
