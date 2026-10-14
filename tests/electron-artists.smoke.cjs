const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
const {LibraryDatabase}=require('../dist/main/library/database.js'),{scanRoot}=require('../dist/main/library/scanner.js');
const mainPids=new WeakMap();
async function until(check,label){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,70));}throw new Error(`Timed out: ${label}`);}
async function close(app){
  const pid=mainPids.get(app);let timer;
  try{
    // Quit the actual Electron main process before closing the Windows shell wrapper.
    await app.evaluate(({app})=>{setImmediate(()=>app.quit());});
    await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('close timeout')),10000);})]);
  }
  catch(error){console.error('APP CLOSE:',error);process.exitCode=1;if(Number.isSafeInteger(pid)&&pid>0)require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});}
  finally{clearTimeout(timer);}
}
async function main(){
  const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-artists-ui-')),data=path.join(scratch,'userdata'),filename=path.join(data,'library','library.db');
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  const db=new LibraryDatabase(filename),roots=[];
  for(const [folder,title] of [['one','首发合作'],['two','再版合作']]){
    const music=path.join(scratch,folder);fs.mkdirSync(music);require('./tagged-mp3.cjs').writeTaggedMp3(path.join(music,'song.mp3'),{title});
    const rootId=db.addRoot(music);roots.push(rootId);await scanRoot(db,rootId,()=>{});
  }
  const songs=db.list({view:'all'}).items,a=songs.find(item=>item.title==='首发合作'),b=songs.find(item=>item.title==='再版合作');
  const source=db.artists.candidates('甲').items.find(candidate=>candidate.context===path.join(scratch,'one')),target=db.artists.candidates('甲').items.find(candidate=>candidate.context===path.join(scratch,'two'));
  db.user.setState({itemId:a.id,favorite:true,rating:4,baseRevision:0,commandId:randomUUID()});db.user.create('重复合作',randomUUID(),[a.id,b.id,a.id]);db.close();
  const legacy=new DatabaseSync(filename);require('./legacy-schema.cjs').stripV8(legacy);legacy.close();
  const exe=process.env.AURAL_ARTISTS_EXE,launch=async()=>{const app=await _electron.launch({executablePath:exe||path.join(root,'node_modules','electron','dist','electron.exe'),args:exe?[]:[root],env:{...process.env,AURAL_TEST:'1',AURAL_TEST_DATA_DIR:data}});mainPids.set(app,await app.evaluate(()=>process.pid));return app;};
  let app;
  try{
    app=await launch();let win=await app.firstWindow();win.on('crash',()=>console.error('ARTIST RENDERER CRASH'));win.on('pageerror',error=>console.error('ARTIST PAGE ERROR:',error));win.setDefaultTimeout(15000);await win.locator('.track-row').first().waitFor();
    assert.equal(fs.readdirSync(path.dirname(filename)).filter(name=>name.includes('.pre-v8-')).length,1);
    async function open(){
      await win.locator(`[data-item-id="${a.id}"]`).getByRole('button',{name:'整理关联 首发合作',exact:true}).click();
      await win.getByRole('dialog',{name:'整理曲库关联'}).getByRole('button',{name:'整理艺人与署名',exact:true}).click();
      return win.getByRole('dialog',{name:'整理艺人与署名'});
    }
    let dialog=await open();await dialog.getByLabel('跨目录艺人身份').check();
    await dialog.locator(`[data-artist-id="${source.id}"]`).click();await dialog.getByLabel('艺人选择位置').selectOption('target');
    await dialog.locator(`[data-artist-id="${target.id}"]`).click();await dialog.getByRole('button',{name:'确认艺人身份',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await until(async()=>{const items=await win.evaluate(()=>window.music.list({view:'all'}));return items.items[0].catalog.artists[0].id===items.items[1].catalog.artists[0].id;},'confirmed performer identity');
    await win.locator(`[data-item-id="${a.id}"] .track-play`).click();
    await until(async()=>(await win.evaluate(()=>window.music.playback())).state==='playing','confirmed item plays');
    await win.getByRole('button',{name:'暂停',exact:true}).click();await win.getByRole('button',{name:'打开播放详情'}).click();
    await win.getByRole('region',{name:'播放详情'}).getByRole('button',{name:'甲',exact:true}).click();
    await until(async()=>await win.locator('.track-row').count()===2,'identity detail link finds both directories');
    dialog=await open();await dialog.getByLabel('连接词 1',{exact:true}).fill(' with ');await dialog.getByLabel('连接词 2',{exact:true}).fill('');
    await dialog.getByLabel('署名角色 3',{exact:true}).selectOption('composer');
    await dialog.getByRole('button',{name:'下移署名 1',exact:true}).click();await dialog.getByRole('button',{name:'上移署名 2',exact:true}).click();
    if(process.env.AURAL_ARTISTS_SCREENSHOT){await (await app.browserWindow(win)).evaluate(window=>window.show());await win.screenshot({path:process.env.AURAL_ARTISTS_SCREENSHOT,timeout:20000});}
    if(process.env.AURAL_ARTISTS_NARROW_SCREENSHOT){
      await (await app.browserWindow(win)).evaluate(window=>{window.setSize(920,620);window.show();});
      await win.screenshot({path:process.env.AURAL_ARTISTS_NARROW_SCREENSHOT,timeout:20000});
      await (await app.browserWindow(win)).evaluate(window=>window.setSize(1320,850));
    }
    await dialog.getByRole('button',{name:'确认保存署名',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await until(async()=>{const rows=await win.evaluate(()=>window.music.list({view:'all'}));return rows.items.find(item=>item.id===a.id).artist==='甲 with 乙';},'credit display and role edits');
    const edited=(await win.evaluate(()=>window.music.list({view:'all'}))).items.find(item=>item.id===a.id);
    assert.equal(edited.catalog.artists.find(member=>member.name==='AC/DC').role,'composer');assert.equal(edited.favorite,true);assert.equal(edited.rating,4);
    const creditChange=(await win.evaluate(()=>window.music.catalogChanges())).items.find(change=>change.action==='artist-credit');
    dialog=await open();await dialog.getByRole('button',{name:'恢复本地署名',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await until(async()=>{const rows=await win.evaluate(()=>window.music.list({view:'all'}));return rows.items.find(item=>item.id===a.id).catalog.creditConfirmed===false;},'reset local credit');
    const reset=(await win.evaluate(()=>window.music.catalogChanges())).items.find(change=>change.action==='credit-reset');
    await win.getByRole('button',{name:'曲库修订记录',exact:true}).click();dialog=win.getByRole('dialog',{name:'曲库修订记录'});
    await dialog.locator(`[data-change-id="${reset.id}"]`).getByRole('button',{name:'撤销此修订'}).click();await dialog.waitFor({state:'hidden'});
    assert.equal((await win.evaluate(()=>window.music.catalogChanges())).total,4);assert.ok(creditChange);
    // Force a real tag reread; confirmed credit must outlive a scanner update.
    const file=path.join(scratch,'one','song.mp3');fs.utimesSync(file,new Date(),new Date(Date.now()+2000));
    await win.evaluate(rootId=>{window.__artistScanDone=false;window.__artistScanOff=window.music.onEvent(message=>{
      if(message.event==='scan'&&message.payload.rootId===rootId&&message.payload.phase==='complete')window.__artistScanDone=true;
    });},roots[0]);
    await win.locator('.root-rescan').first().click();
    await until(async()=>await win.evaluate(()=>window.__artistScanDone),'source root really completes rescan');
    await win.evaluate(()=>window.__artistScanOff());
    await win.evaluate(()=>window.music.stop());await close(app);app=null;
    app=await launch();win=await app.firstWindow();await win.locator('.track-row').first().waitFor({timeout:15000});
    const restored=await win.evaluate(async()=>({rows:await window.music.list({view:'all'}),playlists:await window.music.playlists(),changes:await window.music.catalogChanges()}));
    assert.equal(restored.rows.items.find(item=>item.id===a.id).artist,'甲 with 乙');assert.equal(restored.rows.items.find(item=>item.id===a.id).rating,4);assert.equal(restored.playlists[0].count,3);assert.equal(restored.changes.total,4);
    console.log('v7 migration, identity confirmation/detail browse, ordered credits/roles, reset/undo, rescan and restart passed');
  }catch(error){console.error('ARTIST CHECK:',error);if(app){try{console.error('ARTIST WINDOW STATE:',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({id:w.id,destroyed:w.isDestroyed(),webDestroyed:w.webContents.isDestroyed(),url:w.webContents.getURL()}))));}catch(inspectError){console.error('ARTIST INSPECTION:',inspectError);}}throw error;}finally{
    if(app)await close(app);assert.equal(path.dirname(scratch),os.tmpdir());
    try{fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:300});}catch(error){console.error('TEMP CLEANUP:',error);process.exitCode=1;}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
