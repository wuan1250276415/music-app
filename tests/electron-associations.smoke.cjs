const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
const {LibraryDatabase}=require('../dist/main/library/database.js'),{scanRoot}=require('../dist/main/library/scanner.js');
async function until(check,label){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,70));}throw new Error(`Timed out: ${label}`);}
function wav(filename){
  const pcm=Buffer.alloc(44100*6*4),h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(pcm.length+36,4);h.write('WAVEfmt ',8);
  h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(2,22);h.writeUInt32LE(44100,24);h.writeUInt32LE(44100*4,28);
  h.writeUInt16LE(4,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);fs.writeFileSync(filename,Buffer.concat([h,pcm]));
}
async function close(app){
  const pid=await app.evaluate(()=>process.pid);let timer;
  try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('close timeout')),10000);})]);}
  catch(error){console.error('APP CLOSE:',error);process.exitCode=1;if(Number.isSafeInteger(pid)&&pid>0)require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});}
  finally{clearTimeout(timer);}
}
async function main(){
  const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-associations-ui-'));
  const data=path.join(scratch,'userdata'),music=path.join(scratch,'music'),filename=path.join(data,'library','library.db');
  fs.mkdirSync(path.join(data,'library'),{recursive:true});
  for(const folder of ['original','copy','reissue'])fs.mkdirSync(path.join(music,folder),{recursive:true});
  require('./tagged-mp3.cjs').writeTaggedMp3(path.join(music,'original','song.mp3'));
  require('./tagged-mp3.cjs').writeTaggedMp3(path.join(music,'reissue','song.mp3'),{title:'再版作品',date:'2020-05'});
  wav(path.join(music,'copy','合作作品.wav'));
  const db=new LibraryDatabase(filename),rootId=db.addRoot(music);await scanRoot(db,rootId,()=>{});
  const items=db.list({view:'all'}).items,a=items.find(i=>i.path.endsWith(path.join('original','song.mp3'))),b=items.find(i=>i.path.endsWith('.wav'));
  db.user.setState({itemId:b.id,favorite:true,rating:4,baseRevision:0,commandId:randomUUID()});
  db.user.create('版本歌单',randomUUID(),[b.id,a.id,b.id]);db.close();
  const legacy=new DatabaseSync(filename);require('./legacy-schema.cjs').stripV7(legacy);legacy.close();
  const exe=process.env.AURAL_ASSOCIATIONS_EXE,launch=()=>_electron.launch({executablePath:exe||path.join(root,'node_modules','electron','dist','electron.exe'),
    args:exe?[]:[root],env:{...process.env,AURAL_TEST:'1',AURAL_TEST_DATA_DIR:data}});
  let app;
  try{
    app=await launch();let win=await app.firstWindow();win.setDefaultTimeout(15000);await win.locator('.track-row').first().waitFor();
    assert.equal(fs.readdirSync(path.join(data,'library')).filter(n=>n.includes('.pre-v7-')).length,1);
    const row=()=>win.locator(`[data-item-id="${b.id}"]`);
    await row().getByRole('button',{name:'整理关联 合作作品',exact:true}).click();
    let dialog=win.getByRole('dialog',{name:'整理曲库关联'});
    await dialog.getByRole('button').filter({hasText:path.join('original','song.mp3')}).click();
    await dialog.getByRole('button',{name:'确认关联',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await until(async()=>{const found=await win.evaluate(()=>window.music.list({view:'all'}));return found.items.find(i=>i.id===a.id).catalog.releaseTrackId===found.items.find(i=>i.id===b.id).catalog.releaseTrackId;},'version association');
    await win.getByLabel('折叠同一发行曲目的文件版本').check();
    await until(async()=>await win.locator('.track-row').count()===2,'folded version rows');
    await win.getByRole('button',{name:'选择版本 合作作品',exact:true}).click();
    dialog=win.getByRole('dialog',{name:'选择音乐版本'});
    await dialog.getByRole('button').filter({hasText:'合作作品.wav'}).click();
    await until(async()=>(await win.evaluate(()=>window.music.playback())).itemId===b.id&&(await win.evaluate(()=>window.music.playback())).state==='playing','selected WAV version plays');
    await win.evaluate(()=>window.music.pause());
    await win.getByLabel('折叠同一发行曲目的文件版本').uncheck();
    await until(async()=>await row().count()===1,'unfolded WAV row');
    await row().getByRole('button',{name:'整理关联 合作作品',exact:true}).click();
    dialog=win.getByRole('dialog',{name:'整理曲库关联'});
    await dialog.getByLabel('关联方式').selectOption('group');await dialog.getByLabel('专辑概念名称').fill('合作专辑');
    await dialog.getByLabel('查找关联目标').fill('再版作品');
    await dialog.getByRole('button').filter({hasText:path.join('reissue','song.mp3')}).click();
    await dialog.getByRole('button',{name:'确认关联',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await win.locator('.nav-item').filter({hasText:'专辑'}).click();await win.getByLabel('专辑视图').selectOption('albumGroups');
    await win.locator('[data-facet-id]').filter({hasText:'合作专辑'}).click();
    await until(async()=>await win.locator('.track-row').count()===3,'release-group browsing');
    const change=(await win.evaluate(()=>window.music.catalogChanges())).items.find(c=>c.action==='group');
    await win.getByRole('button',{name:'曲库修订记录',exact:true}).click();dialog=win.getByRole('dialog',{name:'曲库修订记录'});
    await dialog.locator(`[data-change-id="${change.id}"]`).getByRole('button',{name:'撤销此修订'}).click();await dialog.waitFor({state:'hidden'});
    assert.equal((await win.evaluate(()=>window.music.facets('albumGroups'))).length,0);
    await win.locator('.nav-item').filter({hasText:'全部音乐'}).click();await row().waitFor();
    await row().getByRole('button',{name:'整理关联 合作作品',exact:true}).click();dialog=win.getByRole('dialog',{name:'整理曲库关联'});
    await dialog.getByLabel('关联方式').selectOption('reset');await dialog.getByRole('button',{name:'确认恢复候选',exact:true}).click();await dialog.waitFor({state:'hidden'});
    const reset=(await win.evaluate(()=>window.music.catalogChanges())).items.find(c=>c.action==='reset');
    await win.getByRole('button',{name:'曲库修订记录',exact:true}).click();dialog=win.getByRole('dialog',{name:'曲库修订记录'});
    await dialog.locator(`[data-change-id="${reset.id}"]`).getByRole('button',{name:'撤销此修订'}).click();await dialog.waitFor({state:'hidden'});
    await win.getByLabel('折叠同一发行曲目的文件版本').check();await until(async()=>await win.locator('.track-row').count()===2,'undo restores folded versions');
    if(process.env.AURAL_ASSOCIATIONS_SCREENSHOT){await (await app.browserWindow(win)).evaluate(w=>w.show());await win.screenshot({path:process.env.AURAL_ASSOCIATIONS_SCREENSHOT,timeout:20000});}
    await win.evaluate(()=>window.music.stop());await close(app);app=null;
    app=await launch();win=await app.firstWindow();await win.locator('.track-row').first().waitFor({timeout:15000});
    const restored=await win.evaluate(async()=>({rows:await window.music.list({view:'all',collapseVersions:true}),favorites:await window.music.list({view:'favorites'}),playlists:await window.music.playlists(),changes:await window.music.catalogChanges()}));
    assert.equal(restored.rows.total,2);assert.equal(restored.favorites.items[0].rating,4);assert.equal(restored.playlists[0].count,3);assert.equal(restored.changes.total,5);
    console.log('v6 migration, manual versions, selected WAV playback, release groups, reset/undo, history and restart passed');
  }catch(error){console.error('ASSOCIATION CHECK:',error);throw error;}finally{
    if(app)await close(app);assert.equal(path.dirname(scratch),os.tmpdir());
    try{fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:300});}catch(error){console.error('TEMP CLEANUP:',error);process.exitCode=1;}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
