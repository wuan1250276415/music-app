const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto'),{DatabaseSync}=require('node:sqlite'),{_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
const {LibraryDatabase}=require('../dist/main/library/database.js'),{scanRoot}=require('../dist/main/library/scanner.js'),{PlaybackQueue}=require('../dist/main/main/queue.js');
async function until(check,label){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,70));}throw new Error(`Timed out: ${label}`);}
const mainPids=new WeakMap();
async function close(app){const pid=mainPids.get(app);let timer;try{await app.evaluate(({app})=>{setImmediate(()=>app.quit());});await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('close timeout')),10000);})]);}catch(error){console.error('APP CLOSE:',error);process.exitCode=1;if(Number.isSafeInteger(pid)&&pid>0)require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});}finally{clearTimeout(timer);}}
async function main(){
  const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-releases-ui-')),data=path.join(scratch,'userdata'),filename=path.join(data,'library','library.db');
  fs.mkdirSync(path.dirname(filename),{recursive:true});const db=new LibraryDatabase(filename),roots=[];
  for(const [folder,titles] of [['one',['首发曲目','首发副本','首发续曲']],['two',['目标曲目']]]){
    const music=path.join(scratch,folder);fs.mkdirSync(music);for(const title of titles)require('./tagged-mp3.cjs').writeTaggedMp3(path.join(music,title+'.mp3'),{title});
    const rootId=db.addRoot(music);roots.push(rootId);await scanRoot(db,rootId,()=>{});
  }
  let songs=db.list({view:'all'}).items;const a=songs.find(item=>item.title==='首发曲目'),v=songs.find(item=>item.title==='首发副本'),b=songs.find(item=>item.title==='目标曲目');
  db.associations.link({action:'version',items:[{itemId:v.id,revision:v.catalog.revision}],target:{itemId:a.id,revision:a.catalog.revision},commandId:randomUUID()});
  db.user.setState({itemId:a.id,favorite:true,rating:5,baseRevision:0,commandId:randomUUID()});db.user.create('重复曲目',randomUUID(),[a.id,b.id,a.id]);
  const queue=new PlaybackQueue();queue.start(a.id,[a.id,b.id,a.id]);db.saveQueue(queue.snapshot(),0);songs=db.list({view:'all'}).items;db.close();
  const legacy=new DatabaseSync(filename);require('./legacy-schema.cjs').stripV9(legacy);legacy.close();
  const exe=process.env.AURAL_RELEASES_EXE,launch=async()=>{const app=await _electron.launch({executablePath:exe||path.join(root,'node_modules','electron','dist','electron.exe'),args:exe?[]:[root],env:{...process.env,AURAL_TEST:'1',AURAL_TEST_DATA_DIR:data}});mainPids.set(app,await app.evaluate(()=>process.pid));return app;};
  let app;
  try{
    app=await launch();let win=await app.firstWindow();win.setDefaultTimeout(15000);await win.locator('.track-row').first().waitFor();
    assert.equal(fs.readdirSync(path.dirname(filename)).filter(name=>name.includes('pre-v9')).length,1);
    async function rows(){return (await win.evaluate(()=>window.music.list({view:'all'}))).items;}
    async function open(){await win.locator(`[data-item-id="${a.id}"]`).getByRole('button',{name:'整理关联 首发曲目',exact:true}).click();await win.getByRole('dialog',{name:'整理曲库关联'}).getByRole('button',{name:'整理发行版',exact:true}).click();const dialog=win.getByRole('dialog',{name:'整理发行版'});await dialog.locator('.release-tracks>div').first().waitFor();return dialog;}
    let dialog=await open();await dialog.locator(`[data-release-id="${b.catalog.releaseId}"]`).click();
    assert.equal(await dialog.getByLabel('目标碟号 2',{exact:true}).inputValue(),'2');
    if(process.env.AURAL_RELEASES_SCREENSHOT){await (await app.browserWindow(win)).evaluate(window=>window.show());await win.screenshot({path:process.env.AURAL_RELEASES_SCREENSHOT,timeout:20000});}
    if(process.env.AURAL_RELEASES_NARROW_SCREENSHOT){await (await app.browserWindow(win)).evaluate(window=>{window.setSize(920,620);window.show();});await win.screenshot({path:process.env.AURAL_RELEASES_NARROW_SCREENSHOT,timeout:20000});await (await app.browserWindow(win)).evaluate(window=>window.setSize(1320,850));}
    const queueBefore=await win.evaluate(()=>window.music.queue());
    await dialog.getByRole('button',{name:'确认合并发行版',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await until(async()=>new Set((await rows()).map(item=>item.catalog.releaseId)).size===1,'whole releases merge');
    let merged=await rows(),mergedRelease=merged[0].catalog.releaseId;assert.equal(merged.find(item=>item.id===a.id).catalog.mediumDiscNumber,2);
    assert.deepEqual(merged.map(item=>[item.id,item.fileId,item.catalog.recordingId]).sort(),songs.map(item=>[item.id,item.fileId,item.catalog.recordingId]).sort());
    assert.deepEqual((await win.evaluate(()=>window.music.queue())).entries,queueBefore.entries);
    await win.locator(`[data-item-id="${a.id}"] .track-play`).click();await until(async()=>(await win.evaluate(()=>window.music.playback())).state==='playing','merged item playback');await win.getByRole('button',{name:'暂停',exact:true}).click();
    async function split(){const dialog=await open();await dialog.getByLabel('发行整理方式').selectOption('release-split');await dialog.getByLabel('新发行名称').fill('拆分发行');const item=(await rows()).find(item=>item.id===a.id);await dialog.locator(`[data-release-track-id="${item.catalog.releaseTrackId}"] input`).check();await dialog.getByRole('button',{name:'确认拆分发行版',exact:true}).click();await dialog.waitFor({state:'hidden'});await until(async()=>new Set((await rows()).map(item=>item.catalog.releaseId)).size===2,'logical track split');}
    await split();let splitRows=await rows();assert.equal(splitRows.find(item=>item.id===a.id).catalog.releaseId,splitRows.find(item=>item.id===v.id).catalog.releaseId);
    await win.getByRole('button',{name:'打开播放详情'}).click();const detail=win.getByRole('region',{name:'播放详情'});await detail.getByRole('button',{name:'拆分发行',exact:true}).click();await until(async()=>await win.locator('.track-row').count()===2,'detail album link uses curated release');
    await win.locator('.nav-item').filter({hasText:'全部音乐'}).click();const change=(await win.evaluate(()=>window.music.catalogChanges())).items.find(change=>change.action==='release-split');
    await win.getByRole('button',{name:'曲库修订记录',exact:true}).click();dialog=win.getByRole('dialog',{name:'曲库修订记录'});await dialog.locator(`[data-change-id="${change.id}"]`).getByRole('button',{name:'撤销此修订'}).click();await dialog.waitFor({state:'hidden'});
    await until(async()=>(await rows()).every(item=>item.catalog.releaseId===mergedRelease),'history undo restores merged release');await split();
    const file=path.join(scratch,'one','首发曲目.mp3');fs.utimesSync(file,new Date(),new Date(Date.now()+2000));
    await win.evaluate(rootId=>{window.__releaseScanDone=false;window.__releaseScanOff=window.music.onEvent(message=>{if(message.event==='scan'&&message.payload.rootId===rootId&&message.payload.phase==='complete')window.__releaseScanDone=true;});},roots[0]);
    await win.locator('.root-rescan').first().click();await until(async()=>await win.evaluate(()=>window.__releaseScanDone),'real rescan');await win.evaluate(()=>window.__releaseScanOff());
    await win.evaluate(()=>window.music.stop());await close(app);app=null;app=await launch();win=await app.firstWindow();await win.locator('.track-row').first().waitFor({timeout:15000});
    const restored=await rows(),favorite=restored.find(item=>item.id===a.id);assert.equal(favorite.catalog.releaseTitle,'拆分发行');assert.equal(favorite.favorite,true);assert.equal(favorite.rating,5);
    assert.equal(restored.find(item=>item.id===v.id).catalog.releaseId,favorite.catalog.releaseId);assert.equal((await win.evaluate(()=>window.music.playlists()))[0].count,3);assert.equal((await win.evaluate(()=>window.music.catalogChanges())).total,5);
    console.log('v8 migration, release merge/disc mapping, version-preserving split, detail album browse, history undo, user/queue references, real playback/rescan and restart passed');
  }catch(error){console.error('RELEASE TEST:',error);throw error;}finally{if(app)await close(app);assert.equal(path.dirname(scratch),os.tmpdir());try{fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:300});}catch(error){console.error('TEMP CLEANUP:',error);process.exitCode=1;}}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
