const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{performance}=require('node:perf_hooks'),{DatabaseSync}=require('node:sqlite');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
async function digest(file){const h=createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
async function until(check,label){const end=performance.now()+120000;while(performance.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(label);}
async function main(){
 assert.ok(process.env.AURAL_STARTUP_SOURCE_DB&&process.env.AURAL_STARTUP_SCRATCH_PARENT,'controlled schema73 corpus and parent must be explicit');
 const project=path.resolve(__dirname,'..'),source=path.resolve(process.env.AURAL_STARTUP_SOURCE_DB),parent=path.resolve(process.env.AURAL_STARTUP_SCRATCH_PARENT);
 const stat=fs.lstatSync(source,{bigint:true});assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n);
 const space=fs.statfsSync(parent,{bigint:true});assert.ok(space.bavail*space.bsize>=stat.size*2n+256n*1024n*1024n);
 const scratch=fs.mkdtempSync(path.join(parent,'aural-startup-profile-mvp-')),data=path.join(scratch,'userdata'),folder=path.join(data,'library'),file=path.join(folder,'library.db');
 const report={appVersion:require('../package.json').version,scope:'actual Electron startup, visible DOM/first rows and UI search; copied synthetic100k schema73 catalog, instrumented method timing, no OS cold or full performance acceptance',scratch,completed:false,runs:[]};let app,pid;
 const close=async()=>{if(!app)return;const current=app;app=null;let timer;try{await Promise.race([current.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Electron close timeout')),15000);})]);}catch(error){if(current.process().exitCode===null&&Number.isSafeInteger(pid))require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});throw error;}finally{clearTimeout(timer);}};
 try {
  report.originalSha256=await digest(source);fs.mkdirSync(folder,{recursive:true});fs.copyFileSync(source,file);assert.equal(await digest(file),report.originalSha256);
  const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});try{assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version),73);assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM playable_item').get().n),100000);}finally{db.close();}
  report.sourceFingerprint=Object.fromEntries(['src/main/main.ts','src/main/startup-window.ts','src/main/preload.ts','src/main/catalog-library-lifecycle.ts','src/platform/startup-rpc-trace.ts','src/library/service.ts','src/library/database.ts','src/library/catalog.ts','src/library/library-stats.ts','src/renderer/main.tsx','dist/main/main/main.js','dist/main/library/service.js','dist/main/library/database.js','dist/main/library/library-stats.js','dist/main/library/catalog.js'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(project,name))).digest('hex')]));
  const failureOnly=process.argv.includes('--failure-only');
  for(let run=0;run<(failureOnly?0:3);run++){
   let diagnostics='';const trace=path.join(scratch,`startup-${run}.json`),started=performance.now();
   app=await _electron.launch({executablePath:path.join(project,'node_modules/electron/dist/electron.exe'),args:[project],timeout:120000,env:{...process.env,AURAL_TEST:'1',AURAL_STARTUP_TEST:'1',AURAL_STARTUP_PROFILE:'1',AURAL_STARTUP_TRACE:trace,AURAL_TEST_DATA_DIR:data}});pid=app.process().pid;
   app.process().stderr?.on('data',bytes=>{diagnostics=(diagnostics+String(bytes)).slice(-131072);});
   await app.firstWindow();const win=await until(()=>app.windows().find(page=>page.url().startsWith('file:')),'main document missing');
   const input=win.getByRole('textbox',{name:'搜索音乐',exact:true});await input.waitFor({timeout:120000});const interfaceMs=performance.now()-started;
   const ticket=await win.evaluate(()=>window.music.startupTicket());assert.equal(typeof ticket,'string');assert.equal(ticket.length,36);
   assert.equal(await win.evaluate(()=>window.music.startupInterfaceReady('00000000-0000-0000-0000-000000000000','ready')),false,'a foreign ticket must not release startup');
   assert.equal(await win.evaluate(async ticket=>{try{await window.music.startupInterfaceReady(ticket,'unknown');return false;}catch{return true;}},ticket),true,'unknown acknowledgment status must be rejected');
   assert.ok(app.windows().some(page=>page.url().startsWith('data:')),'invalid acknowledgments closed the startup window');
   await win.locator('.track-row').first().waitFor({timeout:120000});const firstRowsMs=performance.now()-started;
   const page=await win.evaluate(()=>window.music.list({view:'all',limit:100}));assert.equal(page.total,100000);assert.equal(page.items.length,100);assert.equal(new Set(page.items.map(item=>item.id)).size,100);
   const searchStarted=performance.now();await input.fill('夜曲');await win.getByRole('heading',{name:'搜索结果 · 1 首',exact:true}).waitFor({timeout:120000});await win.locator('.track-row').filter({hasText:'夜曲'}).first().waitFor({timeout:120000});assert.equal(await win.locator('.track-row').count(),1);const searchMs=performance.now()-searchStarted;
   await until(()=>fs.existsSync(trace),'startup trace missing');const timing=JSON.parse(fs.readFileSync(trace,'utf8'));assert.equal(timing.phase,'ready');assert.ok(!app.windows().some(page=>page.url().startsWith('data:')),'startup window remained after first-page handoff');
   assert.equal(await win.evaluate(ticket=>window.music.startupInterfaceReady(ticket,'ready'),ticket),false,'completed startup ticket must be rejected');
   await close();const rpc=[...diagnostics.matchAll(/AURAL_STARTUP_RPC (\{[^\r\n]+\})/g)].map(match=>JSON.parse(match[1]));assert.ok(rpc.some(row=>row.method==='stats'),'RPC stats timing absent');
   assert.ok(!/音乐库初始化失败|UnhandledPromiseRejection|音乐库服务超时/.test(diagnostics),diagnostics);
   report.runs.push({run,interfaceMs,firstRowsMs,searchMs,ticketGuards:{foreignRejected:true,unknownStatusRejected:true,startupRetained:true,completedRejected:true},startupTrace:timing,rpc});console.log('Actual startup profile:',JSON.stringify({run,interfaceMs,firstRowsMs,searchMs,slowest:rpc.filter(row=>row.source==='library').sort((a,b)=>b.durationMs-a.durationMs).slice(0,5)}));
  }
  // Explicit fault run, separate from performance samples and their acceptance.
  if(failureOnly){
  app=await _electron.launch({executablePath:path.join(project,'node_modules/electron/dist/electron.exe'),args:[project],timeout:120000,env:{...process.env,AURAL_TEST:'1',AURAL_STARTUP_TEST:'1',AURAL_TEST_DATA_DIR:data}});pid=app.process().pid;
  const startup=await app.firstWindow(),faultDocument=await until(()=>app.windows().find(page=>page.url().startsWith('file:')),'fault-case main document missing');
  await faultDocument.getByRole('textbox',{name:'搜索音乐',exact:true}).waitFor({timeout:120000});
  assert.ok(app.windows().some(page=>page===startup),'fault must occur before startup handoff');
  const rendererPids=await app.evaluate(({BrowserWindow})=>{const windows=BrowserWindow.getAllWindows(),main=windows.find(window=>window.webContents.getURL().startsWith('file:')),startup=windows.find(window=>window.webContents.getURL().startsWith('data:'));if(!main||!startup)throw new Error('fault-case windows missing');return {main:main.webContents.getOSProcessId(),startup:startup.webContents.getOSProcessId()};});
  assert.ok(Number.isSafeInteger(rendererPids.main)&&rendererPids.main>0&&rendererPids.main!==rendererPids.startup&&rendererPids.main!==pid,'fault must target this app main renderer only');
  const failureBegan=performance.now();process.kill(rendererPids.main,'SIGKILL');
  await until(()=>{try{process.kill(rendererPids.main,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}},'owned renderer did not terminate');
  await startup.waitForFunction(()=>document.body.dataset.phase==='failed',{},{timeout:130000,polling:100});
  assert.equal(await startup.evaluate(()=>typeof window.music),'undefined');
  const closed=app.waitForEvent('close',{timeout:15000});await startup.getByRole('button',{name:'退出',exact:true}).click();await closed;app=null;
  report.rendererFailure={actualOwnedRendererTermination:true,startupFailed:true,isolatedBridge:true,quitCompleted:true,failureObservedMs:performance.now()-failureBegan};
  }else report.rendererFailureTested=false;
  assert.equal(await digest(source),report.originalSha256);report.originalUnchanged=true;report.completed=true;
 }catch(error){report.error=String(error.stack||error);throw error;}
 finally {
  try{await close();}finally{
   if(process.env.AURAL_STARTUP_PROFILE_REPORT)fs.writeFileSync(path.resolve(process.env.AURAL_STARTUP_PROFILE_REPORT),JSON.stringify(report,null,2)+'\n');
   if(report.completed&&path.dirname(scratch)===parent&&path.basename(scratch).startsWith('aural-startup-profile-mvp-')&&fs.realpathSync(scratch)===scratch)fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
