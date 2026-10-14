// Optional large-catalog MVP: the real Main and Library utility process upgrade
// an isolated copy. Never point the application at the supplied original file.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{performance}=require('node:perf_hooks'),{DatabaseSync}=require('node:sqlite');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
const tables=['media_file','playable_item','recording','release','release_track','artist','metadata_override','item_user_state','playlist_item','playback_history','cue_document','search_latin','item_sort_key'];
async function digest(file){const hash=createHash('sha256');for await(const bytes of fs.createReadStream(file))hash.update(bytes);return hash.digest('hex');}
function inspect(file){const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});try{return {schema:Number(db.prepare('PRAGMA user_version').get().user_version),counts:Object.fromEntries(tables.map(table=>[table,Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n)]))};}finally{db.close();}}
async function main(){
 const project=path.resolve(__dirname,'..'),source=path.resolve(process.env.AURAL_UPGRADE_SOURCE_DB||'');
 if(!process.env.AURAL_UPGRADE_SOURCE_DB)throw new Error('AURAL_UPGRADE_SOURCE_DB must explicitly identify the controlled schema72 fixture');
 const original=fs.lstatSync(source,{bigint:true});assert.ok(original.isFile()&&!original.isSymbolicLink()&&original.nlink===1n);
 const before=inspect(source);assert.equal(before.schema,72);assert.equal(before.counts.playable_item,100000);
 const parent=path.resolve(process.env.AURAL_UPGRADE_SCRATCH_PARENT||os.tmpdir());fs.mkdirSync(parent,{recursive:true});
 const space=fs.statfsSync(parent,{bigint:true});assert.ok(space.bavail*space.bsize>=original.size*3n+256n*1024n*1024n,'insufficient room for isolated copy, verified upgrade snapshot and indexes');
 const scratch=fs.mkdtempSync(path.join(parent,'aural-startup-upgrade-mvp-')),data=path.join(scratch,'userdata'),library=path.join(data,'library'),filename=path.join(library,'library.db');
 const report={appVersion:require('../package.json').version,scope:'actual Electron Main/Library startup; copied synthetic 100k schema72 catalog, no physical scan, OS cold or hardware certification',sourceName:path.basename(source),scratch,completed:false};
 let app,pid,diagnostics='',launchCount=0;
 const close=async()=>{if(!app)return;let timer;const owned=app;app=null;try{await Promise.race([owned.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('actual Electron close timed out')),15000);})]);}catch(error){if(owned.process().exitCode===null&&Number.isSafeInteger(pid)&&pid>0)require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});throw error;}finally{clearTimeout(timer);}};
 const launch=async()=>{
  const started=performance.now(),run=launchCount++,trace=path.join(scratch,`startup-${run}.json`);
  app=await _electron.launch({executablePath:path.join(project,'node_modules/electron/dist/electron.exe'),args:[project],timeout:900000,env:{...process.env,AURAL_TEST:'1',AURAL_STARTUP_TEST:'1',AURAL_STARTUP_TRACE:trace,AURAL_TEST_DATA_DIR:data}});pid=app.process().pid;
  app.process().stderr?.on('data',bytes=>{diagnostics=(diagnostics+String(bytes)).slice(-65536);});
  const first=await app.firstWindow({timeout:900000});
  if(run===0){
   await first.getByRole('button',{name:'退出',exact:true}).waitFor({timeout:60000});
   assert.equal(await first.evaluate(()=>typeof window.music),'undefined','startup document must not receive the music bridge');
   await first.waitForFunction(()=>['snapshot-save','snapshot-verify','index-update','index-verify'].includes(document.body.dataset.phase),{},{timeout:120000});
   const elapsedBefore=await first.locator('#elapsed').textContent();
   await first.waitForFunction(previous=>document.getElementById('elapsed').textContent!==previous,elapsedBefore,{timeout:5000});
   assert.ok(app.windows().every(page=>page===first),'main window appeared before the migration completed');
   report.startupVisibleMs=performance.now()-started;report.startupResponsiveDuringMigration=true;
   if(process.env.AURAL_STARTUP_SCREENSHOT){await (await app.browserWindow(first)).evaluate(window=>{window.webContents.setBackgroundThrottling(false);window.show();window.focus();});await first.screenshot({path:process.env.AURAL_STARTUP_SCREENSHOT});}
   console.log('Real startup window responds during database migration and exposes no music bridge');
  }
  let win;const end=performance.now()+900000;
  while(performance.now()<end){win=app.windows().find(page=>page!==first&&page.url().startsWith('file:'));if(win)break;await new Promise(resolve=>setTimeout(resolve,200));}
  assert.ok(win,'real startup window did not hand off to the main document');
  await win.getByRole('textbox',{name:'搜索音乐',exact:true}).waitFor({timeout:120000});
  await win.locator('.track-row').first().waitFor({timeout:120000});
  if(!first.isClosed())await first.waitForEvent('close',{timeout:120000});
  assert.ok(first.isClosed(),'startup window remained after the main window was ready');
  const timing=JSON.parse(fs.readFileSync(trace,'utf8'));assert.equal(timing.phase,'ready');
  if(run===0){for(const phase of ['library-open','snapshot-save','snapshot-verify','index-update','index-verify','library-runtime','preferences','output','queue','desktop','interface','ready'])assert.ok(timing.stages.some(row=>row.phase===phase),phase);report.upgradeStartupTrace=timing;}
  else {assert.ok(!timing.stages.some(row=>row.phase.startsWith('snapshot-')||row.phase.startsWith('index-')),'hot reopening repeated migration');report.reopenStartupTrace=timing;}
  const page=await win.evaluate(()=>window.music.list({view:'all',limit:100}));assert.equal(page.total,100000);assert.equal(page.items.length,100);assert.equal(new Set(page.items.map(item=>item.id)).size,100);
  const exact=await win.evaluate(()=>window.music.list({view:'all',query:'夜曲',limit:100}));assert.equal(exact.items[0].title,'夜曲');
  return {win,readyMs:performance.now()-started};
 };
 try{
  report.originalSha256=await digest(source);fs.mkdirSync(library,{recursive:true});fs.copyFileSync(source,filename);assert.equal(await digest(filename),report.originalSha256);
  console.log('Isolated schema72 copy verified; starting the actual application and waiting for real library readiness');
  let loaded=await launch();report.upgradeReadyMs=loaded.readyMs;
  assert.equal((await loaded.win.evaluate(()=>window.music.searchIndexState())).status,'ready');
  if(process.env.AURAL_UPGRADE_SCREENSHOT){await (await app.browserWindow(loaded.win)).evaluate(window=>{window.webContents.setBackgroundThrottling(false);window.showInactive();});await loaded.win.screenshot({path:process.env.AURAL_UPGRADE_SCREENSHOT});}
  await close();const upgraded=inspect(filename);assert.equal(upgraded.schema,73);assert.deepEqual(upgraded.counts,before.counts);
  const snapshots=fs.readdirSync(library).filter(name=>name.startsWith('library.db.pre-v73-')&&name.endsWith('.bak'));assert.equal(snapshots.length,1);
  const snapshot=path.join(library,snapshots[0]);assert.deepEqual(inspect(snapshot),before);report.snapshot={name:snapshots[0],bytes:fs.statSync(snapshot).size,sha256:await digest(snapshot)};
  console.log('Actual upgraded application ready:',JSON.stringify({readyMs:report.upgradeReadyMs,schema:upgraded.schema,items:upgraded.counts.playable_item}));
  loaded=await launch();report.reopenReadyMs=loaded.readyMs;await close();assert.equal(fs.readdirSync(library).filter(name=>name.startsWith('library.db.pre-v73-')).length,1);assert.deepEqual(inspect(filename).counts,before.counts);
  assert.equal(await digest(source),report.originalSha256);report.originalUnchanged=true;
  assert.ok(!/音乐库初始化失败|音乐库服务超时：init|音乐库服务尚未就绪|帧响应过大/.test(diagnostics),diagnostics);
  report.completed=true;console.log('Real Main/Library schema72 upgrade, 100k catalog/precise query, exact preserved counts/snapshot, idempotent application reopening and unchanged original passed');
 }catch(error){report.error=String(error.stack||error);throw error;}
 finally{
  try{await close();}finally{
   report.diagnostics=diagnostics;if(process.env.AURAL_UPGRADE_REPORT)fs.writeFileSync(path.resolve(process.env.AURAL_UPGRADE_REPORT),JSON.stringify(report,null,2)+'\n');
   // Preserve failed fixtures. Success cleanup touches only this freshly owned
   // directory; the original 72 snapshot and 73 benchmark remain untouched.
   if(report.completed&&path.dirname(scratch)===parent&&path.basename(scratch).startsWith('aural-startup-upgrade-mvp-')&&fs.realpathSync(scratch)===scratch)fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
