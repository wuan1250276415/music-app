const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
const {LibraryDatabase}=require('../dist/main/library/database.js');
const {scanRoot}=require('../dist/main/library/scanner.js');
const {writeTaggedFlac}=require('./tagged-flac.cjs');
async function until(check,label){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,70));}throw new Error(`Timed out: ${label}`);}
async function main(){
  const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-flac-cue-'));
  const data=path.join(scratch,'userdata'),music=path.join(scratch,'music');let db,app,pid,shutdownDiagnostics='';
  try{
    fs.mkdirSync(path.join(data,'library'),{recursive:true});fs.mkdirSync(music);
    const fixture=path.join(__dirname,'fixtures'),pictures=[{type:4,path:path.join(fixture,'sidecar-blue.png')},{type:3,path:path.join(fixture,'embedded-red.png')}];
    const source=rate=>path.join(root,'native','audio-host','testdata',`cue-gold-${rate}-${rate===44100?16:24}bit.flac`);
    const proofs=[
      writeTaggedFlac(source(44100),path.join(music,'standalone16.flac'),{TITLE:'无损封面样本',ARTIST:'无损歌手',ALBUM:'无损专辑',GENRE:'Jazz'},pictures),
      writeTaggedFlac(source(48000),path.join(music,'image24.flac'),{TITLE:'整轨音频',ARTIST:'文件歌手',ALBUM:'文件专辑',GENRE:'Jazz'},pictures)
    ];
    console.log('MVP FLAC fixture identity:',JSON.stringify(proofs));
    fs.copyFileSync(path.join(fixture,'sidecar-blue.png'),path.join(music,'cover.png'));
    fs.writeFileSync(path.join(music,'album.cue'),'PERFORMER "编排歌手"\nTITLE "编排专辑"\nFILE "image24.flac" WAVE\n  TRACK 01 AUDIO\n    TITLE "编排第一曲"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE "编排第二曲"\n    INDEX 00 00:00:50\n    INDEX 01 00:01:00\n','utf8');
    const albumLrc='[00:00.00]第一轨歌词\n[00:00.75]前隙歌词\n[00:01.50]第二轨歌词\n[00:02.50]第二轨尾句\n';
    fs.writeFileSync(path.join(music,'image24.lrc'),albumLrc,'utf8');
    fs.writeFileSync(path.join(music,'image24.txt'),'未标时间的整轨文本不能分配给某一首歌曲\n','utf8');
    db=new LibraryDatabase(path.join(data,'library','library.db'));let scan;
    await scanRoot(db,db.addRoot(music),state=>{scan=state;});
    const issues=scan?.jobId?db.scanJobs.issues(scan.jobId).items:[];
    assert.equal(scan?.phase,'complete',JSON.stringify({scan,issues}));assert.equal(scan.errors,0,JSON.stringify(issues));
    const rows=db.list({view:'all'}).items,standalone=rows.find(item=>item.path.endsWith('standalone16.flac'));
    const tracks=rows.filter(item=>item.kind==='cue').sort((a,b)=>a.trackNumber-b.trackNumber);
    assert.ok(standalone,JSON.stringify(rows));assert.equal(rows.length,3);assert.equal(tracks.length,2);
    assert.equal(standalone.bitsPerSample,16);assert.equal(standalone.sampleRate,44100);assert.equal(standalone.durationSeconds,3);
    assert.deepEqual(tracks.map(item=>item.title),['编排第一曲','编排第二曲']);
    assert.ok(tracks.every(item=>item.artist==='编排歌手'&&item.album==='编排专辑'&&item.bitsPerSample===24&&item.sampleRate===48000));
    assert.deepEqual(tracks.map(item=>item.durationSeconds),[1,2]);
    assert.equal(tracks[0].sourceStartCueFrame,0);assert.equal(tracks[0].sourceEndCueFrame,75);
    assert.equal(tracks[1].sourceStartCueFrame,75);assert.equal(tracks[1].cue.index00Frame,50);assert.equal(tracks[1].cue.index01Frame,75);
    console.log('MVP imported FLAC/CUE:',JSON.stringify(rows.map(item=>({title:item.title,kind:item.kind,rate:item.sampleRate,bits:item.bitsPerSample,duration:item.durationSeconds,start:item.sourceStartCueFrame,end:item.sourceEndCueFrame}))));
    db.close();db=null;
    app=await _electron.launch({executablePath:path.join(root,'node_modules','electron','dist','electron.exe'),args:[root],env:{...process.env,AURAL_TEST:'1',AURAL_TEST_DATA_DIR:data}});pid=app.process().pid;
    app.process().stderr?.on('data',chunk=>{shutdownDiagnostics=(shutdownDiagnostics+String(chunk)).slice(-32768);console.error('ELECTRON:',String(chunk));});
    const win=await app.firstWindow();win.setDefaultTimeout(15000);
    await (await app.browserWindow(win)).evaluate(window=>{window.webContents.setBackgroundThrottling(false);window.showInactive();});
    win.on('pageerror',error=>console.error('FLAC/CUE PAGE:',error));
    await until(async()=>(await win.evaluate(()=>window.music.scanJobs())).items.every(job=>!['queued','running','cancelling'].includes(job.status)),'startup scans settled');
    const firstBundle=await win.evaluate(id=>window.music.lyricsBundle(id),tracks[0].id);
    assert.deepEqual(firstBundle.sources.map(source=>source.label),['image24.lrc']);
    assert.deepEqual(firstBundle.sources[0].lines,[{atSeconds:0,text:'第一轨歌词'},{atSeconds:0.75,text:'前隙歌词'}]);
    const volume=await win.evaluate(async()=>{const {preference:p}=await window.music.audioOutput();return window.music.configureAudioVolume({commandId:crypto.randomUUID(),baseRevision:p.revision,deviceId:p.deviceId,mode:p.mode,dsdPolicy:p.dsdPolicy,processing:{...p.processing,muted:true}});});
    assert.equal(volume.status,'saved',volume.error);assert.equal(volume.preference.processing.muted,true);
    async function redCover(image){
      await image.waitFor({timeout:60000});await image.scrollIntoViewIfNeeded();
      await until(()=>image.evaluate(element=>element.complete&&element.naturalWidth>0),'FLAC cover decoded');
      assert.match(await image.getAttribute('src'),/^aural-artwork:\/\/image\/[0-9a-f]{64}\.jpg$/);
      const bounds=await image.boundingBox();assert.ok(bounds);let pixel;
      await until(async()=>{const png=(await win.screenshot({clip:bounds})).toString('base64');pixel=await app.evaluate(({nativeImage},png)=>{const image=nativeImage.createFromBuffer(Buffer.from(png,'base64')),size=image.getSize(),bytes=image.toBitmap(),at=(Math.floor(size.height/2)*size.width+Math.floor(size.width/2))*4;return {red:bytes[at+2],blue:bytes[at],green:bytes[at+1]};},png);return pixel.red>180&&pixel.blue<80;},'FLAC front cover visibly red');
    }
    for(const item of [standalone,...tracks]){
      const row=win.locator(`[data-item-id="${item.id}"]`);await row.waitFor();await row.locator('.track-art').evaluate(element=>element.scrollIntoView({block:'center',inline:'nearest'}));
      await redCover(row.locator('.track-art img'));
    }
    const play=async item=>{
      await win.locator(`[data-item-id="${item.id}"] .track-play`).click();
      await until(async()=>{const p=await win.evaluate(()=>window.music.playback());return p.itemId===item.id&&p.state==='playing';},`play ${item.title}`);
      const playing=await win.evaluate(()=>window.music.playback());assert.equal(playing.actualOutput.backend,'wasapi');assert.equal(playing.actualOutput.mode,'shared');
      assert.match(playing.decodedSource.codec,/flac/i);assert.equal(playing.decodedSource.sampleRate,item.sampleRate);assert.equal(playing.decodedSource.media.validBits,item.bitsPerSample);assert.equal(playing.processingPlan.settings.muted,true);
      await win.getByRole('button',{name:'暂停',exact:true}).click();
      console.log('MVP FLAC playback:',JSON.stringify({title:item.title,source:playing.decodedSource,span:playing.pipelinePlan.span,output:playing.actualOutput}));
      return playing;
    };
    await play(standalone);await redCover(win.locator('.player-cover img'));
    await win.getByRole('button',{name:'打开播放详情',exact:true}).click();const detail=win.getByRole('region',{name:'播放详情'});await detail.waitFor();await redCover(detail.locator('.detail-art img'));
    await detail.locator('.detail-fields').first().getByRole('button',{name:'无损歌手',exact:true}).click();await detail.waitFor({state:'hidden'});
    assert.equal(await win.locator('.hero h1').textContent(),'无损歌手');assert.equal(await win.locator('.track-row').count(),1);
    await win.getByRole('button',{name:'打开播放详情',exact:true}).click();await detail.locator('.detail-fields').first().getByRole('button',{name:'无损专辑',exact:true}).click();
    assert.equal(await win.locator('.hero h1').textContent(),'无损专辑');
    await win.locator('.nav-item').filter({hasText:'全部音乐'}).click();
    await until(async()=>await win.locator('.track-row').count()===3,'all music after FLAC information links');
    const cue=await play(tracks[1]);assert.equal(cue.pipelinePlan.span.startFrame,'48000');assert.equal(cue.durationSeconds,2);
    await win.getByRole('button',{name:'打开播放详情',exact:true}).click();await redCover(detail.locator('.detail-art img'));
    const info=detail.locator('.detail-fields').first();await info.getByRole('button',{name:'编排歌手',exact:true}).waitFor();await info.getByRole('button',{name:'编排专辑',exact:true}).waitFor();
    const lines=detail.locator('.detail-lyric-line');await lines.filter({hasText:'第二轨歌词'}).waitFor();
    assert.deepEqual(await lines.allTextContents(),['第二轨歌词','第二轨尾句']);
    const albumSeekGeneration=(await win.evaluate(()=>window.music.playback())).clock.generation;
    await lines.filter({hasText:'第二轨歌词'}).click();
    await until(async()=>{const p=await win.evaluate(()=>window.music.playback());return p.itemId===tracks[1].id&&p.state==='paused'&&p.clock.generation>albumSeekGeneration&&Math.abs(p.positionSeconds-0.5)<0.002;},'CUE source lyric maps to track-relative seek');
    await lines.filter({hasText:'第二轨歌词'}).and(detail.locator('.detail-lyric-line.active')).waitFor();
    const albumBundle=await win.evaluate(id=>window.music.lyricsBundle(id),tracks[1].id);
    assert.deepEqual(albumBundle.sources.find(source=>source.label==='image24.lrc').lines,[{atSeconds:0.5,text:'第二轨歌词'},{atSeconds:1.5,text:'第二轨尾句'}]);
    const versions=await win.evaluate(id=>window.music.localLyricsVersions(id),tracks[1].id);assert.ok(versions.items.length>0);
    const saved=await win.evaluate(({itemId,id})=>window.music.localLyricsVersion(itemId,id),{itemId:tracks[1].id,id:versions.items[0].id});
    assert.equal(Buffer.from(saved.rawBase64,'base64').toString('utf8'),albumLrc);assert.equal(saved.preview.scopeSnapshot.localSidecar.timeBasis,'audio-absolute');
    assert.deepEqual(saved.preview.document.lines,albumBundle.sources.find(source=>source.label==='image24.lrc').lines);
    await win.screenshot({path:process.env.AURAL_FLAC_CUE_SCREENSHOT||path.join(scratch,'flac-cue-detail.png')});
    await info.getByRole('button',{name:'编排专辑',exact:true}).click();assert.equal(await win.locator('.hero h1').textContent(),'编排专辑');
    await until(async()=>await win.locator('.track-row').count()===2,'precise CUE album search');
    await win.evaluate(()=>window.music.stop());
    // Change gap ownership through the real source command and scan lifecycle.
    const changed=await win.evaluate(async id=>{const source=await window.music.cueSourceForItem(id);return window.music.configureCueSource({commandId:crypto.randomUUID(),fileId:source.id,baseRevision:source.revision,latestVersion:source.latestVersion,encoding:source.encoding,gapPolicy:'current'});},tracks[1].id);
    assert.equal(changed.status,'saved',changed.error);
    const rescan=await win.evaluate(rootId=>window.music.rescanRoot(rootId,crypto.randomUUID()),changed.source.rootId);
    await until(async()=>['succeeded','failed','cancelled'].includes((await win.evaluate(id=>window.music.scanJob(id),rescan.jobId)).status),'CUE gap policy scan settled');
    const job=await win.evaluate(id=>window.music.scanJob(id),rescan.jobId);assert.equal(job.status,'succeeded',JSON.stringify(job));
    const withGap=await win.evaluate(id=>window.music.item(id),tracks[1].id);assert.equal(withGap.sourceStartCueFrame,50);assert.equal(withGap.cue.index01Frame,75);
    fs.writeFileSync(path.join(music,'编排第二曲.lrc'),'[00:00.00]标题歌词\n[00:00.20]标题下一句\n','utf8');
    fs.writeFileSync(path.join(music,'image24.en.lrc'),'[00:01.50]English second track\n','utf8');
    const gapBundle=await win.evaluate(id=>window.music.lyricsBundle(id),withGap.id);
    assert.deepEqual(gapBundle.sources.map(source=>source.label),['编排第二曲.lrc','image24.lrc','image24.en.lrc']);
    assert.ok(Math.abs(gapBundle.sources[0].lines[0].atSeconds-1/3)<1e-9);
    assert.deepEqual(gapBundle.sources[1].lines.map(line=>line.text),['前隙歌词','第二轨歌词','第二轨尾句']);
    assert.ok(Math.abs(gapBundle.sources[1].lines[0].atSeconds-1/12)<1e-9);assert.equal(gapBundle.sources[2].language,'en');
    const gapVersions=await win.evaluate(id=>window.music.localLyricsVersions(id),withGap.id);assert.equal(gapVersions.items.length,4);
    for(const version of gapVersions.items){const history=await win.evaluate(({itemId,id})=>window.music.localLyricsVersion(itemId,id),{itemId:withGap.id,id:version.id});assert.equal(history.summary.id,version.id);}
    const gapPlayback=await play(withGap);assert.equal(gapPlayback.pipelinePlan.span.startFrame,'32000');assert.ok(Math.abs(gapPlayback.durationSeconds-7/3)<1e-9);
    await win.getByRole('button',{name:'打开播放详情',exact:true}).click();await lines.filter({hasText:'标题歌词'}).waitFor();
    const titleSeekGeneration=(await win.evaluate(()=>window.music.playback())).clock.generation;await lines.filter({hasText:'标题歌词'}).click();
    await until(async()=>{const p=await win.evaluate(()=>window.music.playback());return p.state==='paused'&&p.clock.generation>titleSeekGeneration&&Math.abs(p.positionSeconds-1/3)<0.002;},'title-relative lyric maps beyond pregap');
    await lines.filter({hasText:'标题歌词'}).and(detail.locator('.detail-lyric-line.active')).waitFor();
    const fastTransitions=await win.evaluate(async id=>{
      await window.music.pause();const resumed=await window.music.seek(0.6,id);
      await window.music.pause();const paused=await window.music.seek(0.2,id);
      return {resumed,paused};
    },withGap.id);
    assert.equal(fastTransitions.resumed.state,'playing');assert.ok(Math.abs(fastTransitions.resumed.positionSeconds-0.6)<0.002);
    assert.equal(fastTransitions.paused.state,'paused');assert.ok(Math.abs(fastTransitions.paused.positionSeconds-0.2)<0.002);
    await win.evaluate(()=>window.music.stop());
    console.log('FLAC16/24 scan, CUE INDEX00/01 and changed pregap ranges, hidden whole-file, front-before-back/sidecar artwork pixels, shared muted playback, source spans, album and title lyric time mapping, multilingual discovery, immutable history reopening, artist/album links and immediate resume/pause followed by seek passed');
  }finally{
    db?.close();if(app){let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Electron close timeout')),10000);})]);}
      catch(error){console.error('FLAC/CUE CLEANUP:',error);process.exitCode=1;if(Number.isSafeInteger(pid)&&pid>0)require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});}
      finally{clearTimeout(timer);}}
    if(path.dirname(scratch)===path.resolve(os.tmpdir())&&path.basename(scratch).startsWith('aural-flac-cue-'))fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});
    assert.doesNotMatch(shutdownDiagnostics,/Error occurred in handler for '(?:library:(?:lyrics-bundle|artwork-candidate|artwork-lease)|analysis:enabled)'/,'Late display cleanup failed during normal close');
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
