const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
const {LibraryDatabase}=require('../dist/main/library/database.js');
const {scanRoot}=require('../dist/main/library/scanner.js');

async function until(check,label){
  const end=Date.now()+10000;
  while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,70));}
  throw new Error(`Timed out: ${label}`);
}
function writeWav(filename){
  const pcm=Buffer.alloc(44100*6*4),header=Buffer.alloc(44);
  header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);
  header.writeUInt32LE(44100,24);header.writeUInt32LE(44100*4,28);header.writeUInt16LE(4,32);
  header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  fs.writeFileSync(filename,Buffer.concat([header,pcm]));
}

async function main(){
  const root=path.resolve(__dirname,'..');
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-detail-'));
  const data=path.join(scratch,'userdata');
  const music=path.join(scratch,'music');
  fs.mkdirSync(path.join(data,'library'),{recursive:true});fs.mkdirSync(music);
  fs.copyFileSync(path.join(__dirname,'fixtures','embedded-cover.mp3'),path.join(music,'song.mp3'));
  fs.copyFileSync(path.join(__dirname,'fixtures','sidecar-blue.png'),path.join(music,'cover.png'));
  fs.writeFileSync(path.join(music,'song.lrc'),'[00:00.10]第一句\n[00:01.00]第二句\n[00:02.00]第三句','utf8');
  writeWav(path.join(music,'滚动歌词测试.wav'));
  fs.writeFileSync(path.join(music,'滚动歌词测试.lrc'),Array.from({length:51},(_,i)=>`[00:${(i/10).toFixed(2).padStart(5,'0')}]滚动歌词 ${i}`).join('\n'),'utf8');
  const db=new LibraryDatabase(path.join(data,'library','library.db'));
  let lastScan;
  await scanRoot(db,db.addRoot(music),state=>{lastScan=state;});
  const rows=db.list({view:'all'}).items;
  const scanIssues=lastScan?.jobId?db.scanJobs.issues(lastScan.jobId).items:[];
  const song=rows.find(item=>item.path.endsWith('song.mp3')),longSong=rows.find(item=>item.path.endsWith('.wav'));
  db.close();
  if(!song||!longSong){
    const message=`Detail MVP setup did not import both fixtures: ${JSON.stringify({scan:lastScan,issues:scanIssues,items:rows.map(item=>({path:item.path,title:item.title}))})}`;
    if(path.dirname(scratch)===os.tmpdir()&&path.basename(scratch).startsWith('aural-detail-'))fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});
    throw new Error(message);
  }
  const installed=process.env.AURAL_DETAIL_EXE;
  const app=await _electron.launch({executablePath:installed||path.join(root,'node_modules','electron','dist','electron.exe'),
    args:installed?[]:[root],env:{...process.env,AURAL_TEST:'1',AURAL_TEST_DATA_DIR:data}});
  let shutdownDiagnostics='';
  try{
    app.process().stderr?.on('data',d=>{shutdownDiagnostics=(shutdownDiagnostics+String(d)).slice(-32768);console.error('ELECTRON:',String(d));});
    const win=await app.firstWindow();
    // Visible rendering is part of this MVP check; a hidden window can skip Chromium painting.
    // Real pixel assertions require a painted, foreground window. Windows can
    // occlude an inactive test window even with background throttling disabled.
    await (await app.browserWindow(win)).evaluate(window=>{window.webContents.setBackgroundThrottling(false);window.show();window.focus();});
    win.on('pageerror',error=>console.error('DETAIL PAGE:',error));
    win.on('console',message=>{if(message.type()==='error')console.error('DETAIL CONSOLE:',message.text());});
    win.on('requestfailed',request=>console.error('DETAIL RESOURCE:',request.url(),request.failure()));
    await until(async()=>(await win.evaluate(()=>window.music.scanJobs())).items.every(job=>!['queued','running','cancelling'].includes(job.status)),'startup scans settled');
    const cover=async(image,channel)=>{
      await image.waitFor({timeout:60000});
      await image.scrollIntoViewIfNeeded();
      await until(()=>image.evaluate(element=>element.complete&&element.naturalWidth>0),'thumbnail resource decoded');
      assert.match(await image.getAttribute('src'),/^aural-artwork:\/\/image\/[0-9a-f]{64}\.jpg$/);
      const bounds=await image.boundingBox();assert.ok(bounds,'cover has visible bounds');
      let pixel;
      await until(async()=>{
      const png=(await win.screenshot({clip:bounds})).toString('base64');
      pixel=await app.evaluate(({nativeImage},encoded)=>{
        const decoded=nativeImage.createFromBuffer(Buffer.from(encoded,'base64')),size=decoded.getSize(),bytes=decoded.toBitmap();
        const index=(Math.floor(size.height/2)*size.width+Math.floor(size.width/2))*4;
        return {red:bytes[index+2],blue:bytes[index],green:bytes[index+1]};
      },png);
      return pixel[channel]>180&&pixel[channel==='red'?'blue':'red']<80;
      },`${channel} cover painted`);
      assert.ok(pixel[channel]>180&&pixel[channel==='red'?'blue':'red']<80,JSON.stringify(pixel));
    };
    win.setDefaultTimeout(10000);
    assert.ok((await win.locator('.sidebar-footer').textContent()).includes(require('../package.json').version));
    const row=win.locator(`[data-item-id="${song.id}"]`);
    await row.waitFor({timeout:15000});
    await row.locator('.track-art').evaluate(element=>element.scrollIntoView({block:'center',inline:'nearest'}));
    try{await row.locator('.track-art img').waitFor({timeout:15000});}
    catch(error){
      console.error('DETAIL ARTWORK GEOMETRY:',await row.locator('.track-art').evaluate(element=>({rect:element.getBoundingClientRect().toJSON(),busy:element.getAttribute('aria-busy'),width:innerWidth,height:innerHeight,contentScroll:document.querySelector('.content-scroll')?.scrollTop})));
      console.error('DETAIL ARTWORK STATUS:',await row.locator('.track-art').getAttribute('title'));
      console.error('DETAIL ARTWORK READ:',await win.evaluate(async id=>{try{return await window.music.artworkCandidate(id,[],256,true);}catch(error){return {error:String(error)};}},song.id));
      throw error;
    }
    await cover(row.locator('.track-art img'),'red');
    await win.locator(`[data-item-id="${longSong.id}"] .track-art`).evaluate(element=>element.scrollIntoView({block:'center',inline:'nearest'}));
    const fallback=win.locator(`[data-item-id="${longSong.id}"] .track-art img`);
    await fallback.waitFor();
    await cover(fallback,'blue');
    const stale=await win.evaluate(async()=>{
      const before=await window.music.queue(),page=await window.music.browse({query:{view:'all'},offset:0});
      if(page.status!=='ready')throw new Error('Stale playback check requires a ready fixture page');
      const snapshot=(page.snapshot[0]==='0'?'1':'0')+page.snapshot.slice(1);
      let error='';try{await window.music.playBrowse({query:{view:'all'},snapshot,index:0,itemId:page.items[0].id,command:{commandId:crypto.randomUUID(),baseRevision:before.revision}});}catch(cause){error=String(cause);}
      return {before,after:await window.music.queue(),error};
    });
    assert.match(stale.error,/AURAL_BROWSE_STALE/);
    assert.deepEqual(stale.after,stale.before,'stale browse rejection preserves the queue');
    await row.locator('.track-play').click();
    await until(async()=>(await win.evaluate(()=>window.music.playback())).state==='playing','MP3 playback');
    const mp3Output=(await win.evaluate(()=>window.music.playback())).actualOutput;
    assert.equal(mp3Output?.backend,'wasapi');assert.equal(mp3Output.mode,'shared');
    assert.ok(mp3Output.sampleRate>0&&mp3Output.channels>0);
    console.log('MVP MP3 actual output:',JSON.stringify({device:mp3Output.deviceName,mode:mp3Output.mode,format:mp3Output.format,sampleRate:mp3Output.sampleRate,channels:mp3Output.channels,adapterConversion:mp3Output.adapterConversion,hardwareVerified:mp3Output.hardwareVerified}));
    await win.getByRole('button',{name:'暂停',exact:true}).click();
    await cover(win.locator('.player-cover img'),'red');
    await win.getByRole('button',{name:'打开播放详情'}).click();
    const detail=win.getByRole('region',{name:'播放详情'});
    await detail.waitFor();
    await cover(detail.locator('.detail-art img'),'red');
    await detail.locator('.detail-lyric-line').first().click();
    await detail.locator('.detail-lyric-line.active').first().waitFor({timeout:4000});
    assert.equal(await detail.locator('.detail-queue-item').count(),2);
    if(process.env.AURAL_DETAIL_SCREENSHOT){await (await app.browserWindow(win)).evaluate(window=>window.show());await win.screenshot({path:process.env.AURAL_DETAIL_SCREENSHOT});}
    await detail.locator('.detail-modes button').first().click();
    await detail.getByRole('button',{name:'随机：开'}).waitFor({timeout:5000});
    assert.equal((await win.evaluate(()=>window.music.queue())).shuffle,true);
    await detail.getByRole('combobox',{name:'播放模式',exact:true}).selectOption('all');
    await until(async()=>(await win.evaluate(()=>window.music.queue())).repeat==='all','list repeat saved');
    await detail.getByRole('combobox',{name:'播放模式',exact:true}).selectOption('one');
    await until(async()=>(await win.evaluate(()=>window.music.queue())).repeat==='one','single repeat saved');
    assert.equal((await win.evaluate(()=>window.music.queue())).repeat,'one');
    await detail.getByRole('combobox',{name:'播放模式',exact:true}).selectOption('off');
    await until(async()=>(await win.evaluate(()=>window.music.queue())).repeat==='off','repeat disabled');
    await detail.getByRole('tab',{name:'播放列表 · 2',exact:true}).click();
    await detail.locator('.detail-queue-item').filter({hasText:'滚动歌词测试'}).click();
    await until(async()=>{const state=await win.evaluate(()=>window.music.playback());return state.itemId===longSong.id&&state.state==='playing';},'detail queue selects WAV');
    const wavOutput=(await win.evaluate(()=>window.music.playback())).actualOutput;
    assert.equal(wavOutput?.backend,'wasapi');assert.equal(wavOutput.mode,'shared');
    assert.ok(wavOutput.sampleRate>0&&wavOutput.channels>0);
    console.log('MVP WAV actual output:',JSON.stringify({device:wavOutput.deviceName,mode:wavOutput.mode,format:wavOutput.format,sampleRate:wavOutput.sampleRate,channels:wavOutput.channels,adapterConversion:wavOutput.adapterConversion,hardwareVerified:wavOutput.hardwareVerified}));
    await win.getByRole('button',{name:'暂停',exact:true}).click();
    await detail.getByRole('tab',{name:'歌词',exact:true}).click();
    await detail.locator('[data-line="40"]').click();
    await until(async()=>Math.abs((await win.evaluate(()=>window.music.playback())).positionSeconds-4)<0.25,'lyric seek');
    await until(async()=>detail.locator('[data-line="40"]').evaluate(line=>{
      const box=line.getBoundingClientRect(),container=line.parentElement.getBoundingClientRect();
      return line.classList.contains('active')&&box.top>=container.top&&box.bottom<=container.bottom&&line.parentElement.scrollTop>0;
    }),'active lyric scrolls into view');
    await detail.getByRole('tab',{name:'播放列表 · 2',exact:true}).click();
    await detail.locator('.detail-queue-item').filter({hasText:song.title}).click();
    await until(async()=>{const state=await win.evaluate(()=>window.music.playback());return state.itemId===song.id&&state.state==='playing';},'detail queue returns to MP3');
    await win.getByRole('button',{name:'暂停',exact:true}).click();
    await detail.locator('.detail-fields').first().getByRole('button',{name:'测试歌手',exact:true}).click();
    await detail.waitFor({state:'hidden'});
    assert.equal(await win.locator('.hero h1').textContent(),'测试歌手');
    await win.getByRole('button',{name:'打开播放详情'}).click();
    await detail.locator('.detail-fields').first().getByRole('button',{name:'测试专辑',exact:true}).click();
    assert.equal(await win.locator('.hero h1').textContent(),'测试专辑');
    await win.getByRole('button',{name:'打开播放详情'}).click();
    await win.keyboard.press('Escape');
    await detail.waitFor({state:'hidden'});
    await win.evaluate(()=>window.music.stop());
    console.log('MP3/WAV import, embedded/sidecar/player/detail artwork pixels, stale browse queue protection, lyric seek/scroll, detail queue playback, shuffle/repeat, artist/album browse and Escape passed');
  }finally{
    const pid=await app.evaluate(()=>process.pid);let closeTimer;
    try{await Promise.race([app.close(),new Promise((_,reject)=>{closeTimer=setTimeout(()=>reject(new Error('Electron close timeout')),10000);})]);}
    catch(error){console.error('ELECTRON CLEANUP:',error);process.exitCode=1;if(Number.isSafeInteger(pid)&&pid>0)require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});}
    finally{clearTimeout(closeTimer);}
    if(path.dirname(scratch)===os.tmpdir()&&path.basename(scratch).startsWith('aural-detail-')){
      try{fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
      catch(error){console.error('TEMP CLEANUP:',error);process.exitCode=1;}
    }
    assert.doesNotMatch(shutdownDiagnostics,/Error occurred in handler for 'library:artwork-lease'/,'Artwork lease IPC failed during normal close');
    console.log('Normal Electron close completed without artwork lease IPC failure');
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
