const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
const {DatabaseSync}=require('node:sqlite');
const {LibraryDatabase}=require('../dist/main/library/database.js');
const {scanRoot}=require('../dist/main/library/scanner.js');

async function until(check,label){const end=Date.now()+10000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,70));}throw new Error(`Timed out: ${label}`);}
async function closeApp(app){
  const pid=await app.evaluate(()=>process.pid);let timer;
  try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Electron close timeout')),10000);})]);}
  catch(error){console.error('CLOSE:',error);process.exitCode=1;if(Number.isSafeInteger(pid)&&pid>0)require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});}
  finally{clearTimeout(timer);}
}
async function main(){
  const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-collections-'));
  const data=path.join(scratch,'userdata'),music=path.join(scratch,'music');
  fs.mkdirSync(path.join(data,'library'),{recursive:true});fs.mkdirSync(music);
  fs.copyFileSync(path.join(__dirname,'fixtures','embedded-cover.mp3'),path.join(music,'song.mp3'));
  const filename=path.join(data,'library','library.db');
  const db=new LibraryDatabase(filename);await scanRoot(db,db.addRoot(music),()=>{});db.close();
  const raw=new DatabaseSync(filename);require('./legacy-schema.cjs').stripV5(raw);raw.close();
  const executable=process.env.AURAL_COLLECTIONS_EXE;
  const launch=()=>_electron.launch({executablePath:executable||path.join(root,'node_modules','electron','dist','electron.exe'),args:executable?[]:[root],env:{...process.env,AURAL_TEST:'1',AURAL_TEST_DATA_DIR:data}});
  let app;
  try{
    app=await launch();let win=await app.firstWindow();win.setDefaultTimeout(10000);
    await win.locator('.track-row').first().waitFor({timeout:15000});
    assert.equal(fs.readdirSync(path.join(data,'library')).filter(name=>name.includes('.pre-v5-')).length,1);
    await win.locator('.track-actions').first().getByRole('button',{name:'收藏 封面测试',exact:true}).click();
    await win.getByRole('button',{name:'取消收藏 封面测试',exact:true}).waitFor();
    await win.locator('.nav-item').filter({hasText:'收藏'}).click();
    await until(async()=>await win.locator('.track-row').count()===1,'favorite view');
    await win.getByRole('button',{name:'加入歌单 封面测试',exact:true}).click();
    let dialog=win.getByRole('dialog',{name:'加入歌单',exact:true});
    await dialog.getByLabel('歌单名称').fill('桌面歌单');
    await dialog.getByRole('button',{name:'创建并添加',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await win.getByRole('button',{name:'加入歌单 封面测试',exact:true}).click();
    dialog=win.getByRole('dialog',{name:'加入歌单',exact:true});
    await dialog.getByRole('button',{name:'加入所选歌单',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await win.locator('.nav-item').filter({hasText:'歌单'}).click();
    await win.locator('.playlist-card').filter({hasText:'桌面歌单'}).click();
    await until(async()=>await win.locator('.track-row').count()===2,'duplicate playlist entries');
    const secondId=await win.locator('.track-row').nth(1).getAttribute('data-entry-id');
    await win.locator('.track-row').nth(1).locator('.track-play').click();
    await until(async()=>{const q=await win.evaluate(()=>window.music.queue());return q.entries.find(e=>e.id===q.currentEntryId)?.playlistEntryId===secondId;},'selected repeated occurrence');
    await win.locator('.track-row').nth(1).getByRole('button',{name:'上移 封面测试',exact:true}).click();
    await until(async()=>await win.locator('.track-row').first().getAttribute('data-entry-id')===secondId,'playlist reorder');
    await win.locator('.track-row').nth(1).getByRole('button',{name:'从歌单移除 封面测试',exact:true}).click();
    await until(async()=>await win.locator('.track-row').count()===1,'playlist entry removal');
    await win.getByRole('button',{name:'重命名歌单',exact:true}).click();
    dialog=win.getByRole('dialog',{name:'重命名歌单',exact:true});
    await dialog.getByLabel('歌单名称').fill('重启保留歌单');await dialog.getByRole('button',{name:'保存名称',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    await win.getByRole('button',{name:'打开播放详情',exact:true}).click();
    await win.getByLabel('歌曲评分').selectOption('3');
    await until(async()=>(await win.evaluate(()=>window.music.list({view:'favorites'}))).items[0]?.rating===3,'rating saved');
    await win.getByRole('button',{name:'关闭播放详情',exact:true}).click();
    await win.evaluate(()=>window.music.stop());
    if(process.env.AURAL_COLLECTIONS_SCREENSHOT){
      await (await app.browserWindow(win)).evaluate(window=>window.show());
      await win.screenshot({path:process.env.AURAL_COLLECTIONS_SCREENSHOT,timeout:20000});
    }
    await closeApp(app);app=null;
    app=await launch();win=await app.firstWindow();win.setDefaultTimeout(10000);
    await win.locator('.track-row').first().waitFor({timeout:15000});
    const restored=await win.evaluate(async()=>({favorites:await window.music.list({view:'favorites'}),playlists:await window.music.playlists(),recent:await window.music.list({view:'recent'})}));
    assert.equal(restored.favorites.total,1);assert.equal(restored.favorites.items[0].rating,3);
    assert.equal(restored.playlists[0].name,'重启保留歌单');assert.equal(restored.playlists[0].count,1);
    assert.equal(restored.recent.items[0].addedAt,null);
    await win.locator('.nav-item').filter({hasText:'歌单'}).click();
    await win.locator('.playlist-card').filter({hasText:'重启保留歌单'}).click();
    await until(async()=>await win.locator('.track-row').count()===1,'reopened playlist view');
    assert.equal(await win.locator('.track-row').first().getAttribute('data-entry-id'),secondId);
    console.log('v4 migration, favorites, ratings, duplicate playlist playback, reorder/remove/rename and restart passed');
  }catch(error){console.error('COLLECTIONS TEST:',error);throw error;}finally{
    if(app)await closeApp(app);
    assert.equal(path.dirname(scratch),os.tmpdir());
    try{fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
    catch(error){console.error('TEMP CLEANUP:',error);process.exitCode=1;}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
