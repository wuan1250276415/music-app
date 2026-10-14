/// <reference lib="dom" />
import {ipcRenderer} from 'electron';
import type {StartupState} from '../shared/startup-progress.js';

// Sandboxed Electron preloads cannot require local modules. Only this type-only
// dependency remains; no Node API or general music bridge is exposed to the page.
window.addEventListener('DOMContentLoaded',()=>{
  const title=document.getElementById('title'),detail=document.getElementById('detail'),elapsed=document.getElementById('elapsed'),quit=document.getElementById('quit') as HTMLButtonElement|null;
  const progress=document.querySelector('[role="progressbar"]');let base=0,observed=performance.now(),alive=true,sequence=0;
  const render=(state:StartupState)=>{
    if(!alive||!state||state.version!==1||!Number.isFinite(state.elapsedMs)||state.elapsedMs<0||typeof state.title!=='string'||typeof state.detail!=='string')return;
    sequence++;base=state.elapsedMs;observed=performance.now();
    if(title)title.textContent=state.title;if(detail)detail.textContent=state.detail;
    document.body.dataset.phase=state.phase;progress?.setAttribute('aria-valuetext',state.title);
  };
  const event=(_event:Electron.IpcRendererEvent,state:StartupState)=>render(state);ipcRenderer.on('aural-startup:event',event);
  // Subscribe before reading; a delayed old snapshot must not replace a newer
  // event received while the invoke was pending.
  const initial=sequence;void ipcRenderer.invoke('aural-startup:state').then(state=>{if(sequence===initial)render(state);}).catch(()=>{});
  const tick=()=>{if(elapsed)elapsed.textContent=`已等待 ${Math.floor((base+performance.now()-observed)/1000)} 秒`;};tick();const timer=setInterval(tick,1000);
  quit?.addEventListener('click',()=>{if(!alive)return;quit.disabled=true;ipcRenderer.send('aural-startup:quit');});
  window.addEventListener('unload',()=>{alive=false;clearInterval(timer);ipcRenderer.removeListener('aural-startup:event',event);},{once:true});
});
