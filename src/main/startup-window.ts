import {app,BrowserWindow,ipcMain} from 'electron';
import {performance} from 'node:perf_hooks';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import type {StartupPhase,StartupState} from '../shared/startup-progress.js';

const labels:Record<StartupPhase,[string,string]>={
  admission:['正在准备音乐库','正在核对本地音乐资料。'],
  'library-open':['正在读取音乐库','正在打开本地音乐资料。'],
  'snapshot-save':['正在保存升级前的资料','首次升级大型曲库可能需要几分钟。'],
  'snapshot-verify':['正在核对升级前的资料','正在确认保存的资料完整可用。'],
  'index-update':['正在更新检索资料','首次升级大型曲库可能需要几分钟。'],
  'index-verify':['正在核对更新结果','正在确认音乐和个人资料保持完整。'],
  'library-runtime':['正在准备音乐库服务','正在恢复本地任务和文件监测。'],
  preferences:['正在读取你的设置','正在恢复外观和窗口位置。'],
  output:['正在准备播放设置','正在读取音频输出偏好。'],
  queue:['正在恢复播放列表','正在读取播放列表和播放记录。'],
  desktop:['正在准备桌面功能','正在恢复桌面偏好和媒体按键。'],
  interface:['正在打开音乐库','音乐资料已就绪，正在准备主界面。'],
  ready:['音乐库已就绪',''],failed:['音乐库未能打开','界面未能准备完成，可退出后重新打开音乐库。'],closing:['正在退出','正在结束音乐库服务。']
};
// No application bridge, external content or dynamic HTML. The isolated preload
// updates fixed elements using textContent and has only state/quit IPC authority.
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Aural · 正在启动</title><style>
:root{color-scheme:light dark;font:15px/1.6 'Segoe UI','Microsoft YaHei',sans-serif;background:#eaf0ec;color:#173327}body{margin:0;padding:36px 40px}h1{font-size:24px;line-height:1.4;margin:18px 0 10px}p{margin:8px 0}.brand{letter-spacing:.24em;font-weight:700;color:#467026}.activity{height:5px;overflow:hidden;border-radius:5px;background:#cdded1;margin:26px 0 14px}.activity::before{content:'';display:block;width:35%;height:100%;background:#467026;animation:wait 1.8s ease-in-out infinite}footer{display:flex;align-items:center;justify-content:space-between;margin-top:22px}.muted{color:#557361}button{font:inherit;color:inherit;border:1px solid #96ad9e;border-radius:8px;background:transparent;padding:7px 20px;cursor:pointer}button:focus-visible{outline:3px solid #467026;outline-offset:3px}@keyframes wait{0%{transform:translateX(-100%)}100%{transform:translateX(390%)}}@media(prefers-reduced-motion:reduce){.activity::before{animation:none;width:100%}}@media(prefers-color-scheme:dark){:root{background:#13221b;color:#e5efe7}.muted{color:#a5b7aa}.brand{color:#aad087}.activity{background:#334d3d}.activity::before{background:#aad087}button{border-color:#718977}}
</style></head><body><div class="brand">AURAL</div><h1 id="title" role="status" aria-live="polite">正在准备音乐库</h1><p id="detail">正在核对本地音乐资料。</p><div class="activity" role="progressbar" aria-label="正在启动" aria-valuetext="正在准备音乐库"></div><footer><span id="elapsed" class="muted">已等待 0 秒</span><button id="quit" type="button">退出</button></footer></body></html>`;

export class StartupWindow {
  private window:BrowserWindow|null=null;
  private readonly began=performance.now();
  private phase:StartupPhase='admission';
  private ended=false;
  private readonly stages:Array<{phase:StartupPhase;elapsedMs:number}>=[];
  constructor(){this.record('admission');}
  get active():boolean {return !this.ended;}
  private record(phase:StartupPhase):void{if(this.stages.length<64)this.stages.push({phase,elapsedMs:performance.now()-this.began});}
  snapshot():StartupState {const [title,detail]=labels[this.phase];return {version:1,phase:this.phase,title,detail,elapsedMs:Math.max(0,performance.now()-this.began)};}
  update(phase:StartupPhase):void {
    if(this.ended||this.phase===phase)return;this.phase=phase;this.record(phase);
    if(this.window&&!this.window.isDestroyed())this.window.webContents.send('aural-startup:event',this.snapshot());
  }
  open():void {
    // Existing AURAL_TEST clients select the first application window. Opt-in
    // startup MVPs exercise this real isolated window and the subsequent handoff.
    if(this.ended||this.window||(process.env.AURAL_TEST==='1'&&process.env.AURAL_STARTUP_TEST!=='1'))return;
    const created=new BrowserWindow({width:560,height:430,minWidth:440,minHeight:380,resizable:true,maximizable:false,show:false,title:'Aural · 正在启动',backgroundColor:'#eaf0ec',webPreferences:{preload:path.join(__dirname,'startup-preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    this.window=created;
    const trusted=(event:Electron.IpcMainInvokeEvent|Electron.IpcMainEvent)=>{
      if(this.ended||this.window!==created||created.isDestroyed()||event.sender!==created.webContents||event.senderFrame!==created.webContents.mainFrame)throw new Error('启动窗口已变化');
    };
    ipcMain.handle('aural-startup:state',event=>{trusted(event);return this.snapshot();});
    ipcMain.on('aural-startup:quit',event=>{try{trusted(event);app.quit();}catch{/* Ignore obsolete or foreign documents. */}});
    created.webContents.setWindowOpenHandler(()=>({action:'deny'}));created.webContents.on('will-navigate',event=>event.preventDefault());
    created.once('ready-to-show',()=>{if(!this.ended&&this.window===created&&process.env.AURAL_TEST!=='1')created.show();});
    created.on('close',event=>{if(!this.ended){event.preventDefault();app.quit();}});
    void created.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(()=>{if(!this.ended)app.quit();});
  }
  focus():boolean {if(this.ended||!this.window||this.window.isDestroyed())return false;if(this.window.isMinimized())this.window.restore();this.window.show();this.window.focus();return true;}
  finish(phase:'ready'|'failed'|'closing'):void {
    if(this.ended)return;this.update(phase);this.ended=true;
    ipcMain.removeHandler('aural-startup:state');ipcMain.removeAllListeners('aural-startup:quit');
    const created=this.window;this.window=null;if(created&&!created.isDestroyed())created.destroy();
    const trace=process.env.AURAL_STARTUP_TRACE;
    if(process.env.AURAL_TEST==='1'&&trace&&path.isAbsolute(trace))try{writeFileSync(trace,JSON.stringify({version:1,phase,elapsedMs:performance.now()-this.began,scope:'Main phases and document-bound React first-page/initial-read acknowledgment; excludes process launch, OS cold cache and later end-to-end searches',stages:this.stages},null,2)+'\n');}catch{/* Diagnostics cannot turn a completed startup into a failure. */}
  }
}
