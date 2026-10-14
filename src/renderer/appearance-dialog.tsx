import React,{useEffect,useRef,useState} from 'react';
import {ZOOM_PERCENTAGES,type AppearanceState,type AppearanceRequest,type AppearanceTheme} from '../shared/appearance';
import {trap,useFocus} from './dialog-focus';
export function AppearanceDialog({onClose}:{onClose:()=>void}):React.JSX.Element{
 const [state,setState]=useState<AppearanceState|null>(null),[theme,setTheme]=useState<AppearanceTheme>('system'),[zoom,setZoom]=useState(100),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[pending,setPending]=useState(false);
 const alive=useRef(true),working=useRef(false),latest=useRef<AppearanceState|null>(null),attempt=useRef<AppearanceRequest|null>(null),dirty=useRef(false),draftRevision=useRef(0),element=useRef<HTMLDivElement|null>(null);
 useFocus(element);
 function accept(value:AppearanceState,reset=false):void{
  if(!alive.current||latest.current&&value.revision<latest.current.revision)return;latest.current=value;setState(value);
  if(reset||!dirty.current&&!attempt.current){setTheme(value.preference.theme);setZoom(value.preference.zoomPercent);draftRevision.current=value.preference.revision;}
 }
 useEffect(()=>{alive.current=true;const stop=window.music.onEvent(event=>{if(event.event==='appearanceChanged')accept(event.payload as AppearanceState);});void window.music.appearance().then(value=>accept(value,true)).catch(e=>{if(alive.current)setError(String(e));});return()=>{alive.current=false;stop();};},[]);
 async function run(action:()=>Promise<void>):Promise<void>{if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');try{await action();}catch(e){if(alive.current)setError(String(e));}finally{working.current=false;if(alive.current)setBusy(false);}}
 async function refresh():Promise<void>{await run(async()=>{const value=await window.music.refreshAppearance();if(alive.current){dirty.current=false;if(value.status!=='unknown'){attempt.current=null;setPending(false);}accept(value,true);}});}
 async function submit():Promise<void>{
  if(working.current)return;
  const current=latest.current;if(!current)return;const request=attempt.current??{commandId:crypto.randomUUID(),baseRevision:dirty.current?draftRevision.current:current.preference.revision,theme,zoomPercent:zoom};attempt.current=request;setPending(true);
  await run(async()=>{const result=await window.music.configureAppearance(request);if(!alive.current)return;accept(result.state);
   if(result.status==='unknown'){setError(result.error||result.state.message);return;}attempt.current=null;setPending(false);dirty.current=false;accept(result.state,true);
   if(result.status==='rejected')setError(result.error);else setNotice(result.state.applyError||'外观与缩放已保存。');
  });
 }
 const locked=busy||state?.status==='saving'||pending||state?.status==='unknown';
 return <div className="collection-backdrop"><div className="collection-dialog appearance-dialog" ref={element} tabIndex={-1} role="dialog" aria-modal="true" aria-label="外观与缩放" onKeyDown={event=>trap(event,element.current,onClose,busy)}>
  <header><h2>外观与缩放</h2><button disabled={busy} aria-label="关闭外观设置" onClick={onClose}>×</button></header>
  {error&&<p className="collection-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <label>界面主题<select value={theme} disabled={Boolean(locked||!state)} onChange={event=>{dirty.current=true;setTheme(event.target.value as AppearanceTheme);}}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
  <label>界面缩放<select value={zoom} disabled={Boolean(locked||!state)} onChange={event=>{dirty.current=true;setZoom(Number(event.target.value));}}>{ZOOM_PERCENTAGES.map(value=><option key={value} value={value}>{value}%{value===100?'（默认）':''}</option>)}</select></label>
  <p>使用 Ctrl + 加号／减号调整缩放，Ctrl + 0 恢复 100%；macOS 使用 Command。也可使用 Ctrl + 滚轮。窗口变窄时，可从左上角打开音乐库导航。</p>
  {state&&<p role="status">当前为{state.effectiveTheme==='dark'?'深色':'浅色'}，实际缩放 {state.actualZoomPercent}%，显示器比例 {Math.round(state.displayScaleFactor*100)}%。{state.forcedColors?'系统高对比度已启用。':''}{state.status==='unknown'?state.message:''}</p>}
  {state?.applyError&&<p className="collection-error" role="alert">{state.applyError}</p>}
  {dirty.current&&state&&draftRevision.current!==state.preference.revision&&<p role="status">已保存的设置发生变化；请重新读取后再编辑。</p>}
  {(pending||state?.status==='unknown')&&<p>提交结果尚未确认。可核对原提交，或重新读取已保存设置；关闭窗口后仍可再次查看。</p>}
  <footer><button disabled={busy||state?.status==='saving'} onClick={()=>void refresh()}>重新读取</button><button disabled={Boolean(busy||!state||state.status==='saving'||!pending&&state.status==='unknown')} onClick={()=>void submit()}>{pending?'核对原提交':'保存并应用'}</button><button disabled={Boolean(locked||!state)} onClick={()=>{dirty.current=true;setZoom(100);}}>恢复默认缩放</button><button disabled={busy} onClick={onClose}>关闭</button></footer>
 </div></div>;
}
