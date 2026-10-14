const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
const {LibraryDatabase}=require('../dist/main/library/database.js'),{scanRoot}=require('../dist/main/library/scanner.js');
const {MediaParser}=require('../dist/main/library/media-worker-client.js'),{mediaStat}=require('../dist/main/library/media-worker-protocol.js');
const {tag,wav,dsf,largeRf64}=require('./helpers/artwork-containers.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function until(check,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,80));}throw new Error('Timed out: '+label);}
async function main(){
 const project=path.resolve(__dirname,'..'),parent=path.resolve(process.env.AURAL_ARTWORK_SCRATCH_PARENT||'D:/CodexTestData');fs.mkdirSync(parent,{recursive:true});
 const scratch=fs.mkdtempSync(path.join(parent,'aural-artwork-matrix-mvp-')),music=path.join(scratch,'music'),data=path.join(scratch,'userdata');fs.mkdirSync(music);fs.mkdirSync(path.join(data,'library'),{recursive:true});
 const red=fs.readFileSync(path.join(__dirname,'fixtures/embedded-red.png')),blue=fs.readFileSync(path.join(__dirname,'fixtures/sidecar-blue.png'));
 const report={appVersion:require('../package.json').version,scope:'actual supervised media worker and painted Electron artwork on generated WAV/DSF/RF64; sparse RF64 metadata beyond4GiB; only short WAV/DSF PCM playback, no RF64 long playback or ASIO/DSD bitstream hardware certification',scratch,completed:false,workerCases:[],uiCases:[]};let app,db,pid,diagnostics='';
 const fixtures=[];
 const add=(name,bytes,expected,error=false)=>{const folder=path.join(music,name);fs.mkdirSync(folder);const ext=name.startsWith('DSF')?'.dsf':'.wav',file=path.join(folder,name+ext);fs.writeFileSync(file,bytes);fs.writeFileSync(path.join(folder,'cover.png'),blue);const result={name,file,expected,error};fixtures.push(result);return result;};
 try{
  report.sourceFingerprint=Object.fromEntries(['src/library/id3-artwork.ts','src/library/artwork-worker.ts','src/library/artwork.ts','dist/main/library/id3-artwork.js','dist/main/library/artwork-worker.js','dist/main/library/artwork.js','native/media-worker/build/media-worker.exe','native/audio-host/build/audio-host.exe'].map(name=>[name,hash(fs.readFileSync(path.join(project,name)))]));
  add('WAV-v3-front',wav(tag(3,[{bytes:blue,type:4},{bytes:red,type:3}],'WAV 正面优先')),'embedded');
  add('WAV-v4-front',wav(tag(4,[{bytes:red,type:3}],'WAV 四版标签')),'embedded');
  add('DSF-v3-front',dsf(tag(3,[{bytes:blue,type:4},{bytes:red,type:3}],'DSF 正面优先')),'embedded');
  add('DSF-v4-other',dsf(tag(4,[{bytes:red,type:4}],'DSF 其他内嵌图')),'embedded');
  add('WAV-no-picture',wav(null),'sidecar');add('DSF-no-picture',dsf(null),'sidecar');
  add('RF64-table-front',wav(tag(3,[{bytes:red}]),{rf64:true,table:true}),'embedded');
  add('RF64-no-picture',wav(null,{rf64:true}),'sidecar');
  const brokenImage=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);add('RF64-rejected-image',wav(tag(4,[{bytes:brokenImage}]),{rf64:true}),'sidecar');
  const corruptWav=wav(tag(3,[{bytes:red}]));const tagAt=corruptWav.indexOf('ID3');corruptWav.fill(127,tagAt+6,tagAt+10);add('WAV-invalid-tag',corruptWav,null,true);
  const corruptDsf=dsf(tag(3,[{bytes:red}]));corruptDsf.writeBigUInt64LE(100n,20);add('DSF-invalid-pointer',corruptDsf,null,true);
  const missingTable=wav(tag(3,[{bytes:red}]),{rf64:true,table:true});missingTable.write('JUNK',12);add('RF64-missing-ds64',missingTable,null,true);
  const compressed=wav(tag(3,[{bytes:red,flags:128}]),{rf64:true});add('RF64-unsupported-apic',compressed,null,true);
  const large=add('RF64-large-front',Buffer.alloc(0),'embedded');
  assert.equal(fs.realpathSync(path.dirname(large.file)),path.dirname(large.file));
  execFileSync('fsutil',['sparse','setflag',large.file],{windowsHide:true});report.largeFixture=largeRf64(large.file,tag(3,[{bytes:red}],'RF64 超大文件封面'));assert.ok(report.largeFixture.metadataAt>0xffffffff);
  const before=Object.fromEntries(fixtures.map(f=>[f.name,{size:fs.statSync(f.file).size,mtime:fs.statSync(f.file).mtimeMs}]));
  const parser=new MediaParser(),signal=new AbortController().signal;
  for(const fixture of fixtures){
   const handle=await fs.promises.open(fixture.file,'r');try{
    const rootPath=path.dirname(fixture.file),request={rootPath,realRootPath:await fs.promises.realpath(rootPath),fullPath:fixture.file,relativePath:path.basename(fixture.file),before:mediaStat(await handle.stat()),thumbnailSize:256,rejectedTokens:[]};
    let candidate,error;try{candidate=await parser.artwork({...request,artworkSource:'embedded'},signal);if(!candidate)candidate=await parser.artwork({...request,artworkSource:'sidecar'},signal);}catch(cause){error=String(cause);}
    if(fixture.error){assert.ok(error,'incomplete embedded read must stay an error: '+fixture.name);report.workerCases.push({name:fixture.name,incompleteRejected:true});}
    else{assert.equal(error,undefined,error);assert.equal(candidate?.sourceKind,fixture.expected,fixture.name);assert.equal(candidate.token,hash(fixture.expected==='embedded'?red:blue),fixture.name);assert.match(candidate.url,/^data:image\/jpeg;base64,/);report.workerCases.push({name:fixture.name,sourceKind:candidate.sourceKind,token:candidate.token});}
   }finally{await handle.close();}
  }
  // Fault files are outside the scanned root; valid rows still use real import.
  const valid=path.join(scratch,'valid');fs.mkdirSync(valid);
  for(const fixture of fixtures.filter(f=>!f.error))fs.renameSync(path.dirname(fixture.file),path.join(valid,fixture.name));
  for(const fixture of fixtures.filter(f=>!f.error))fixture.file=path.join(valid,fixture.name,path.basename(fixture.file));
  db=new LibraryDatabase(path.join(data,'library/library.db'));let scan;await scanRoot(db,db.addRoot(valid),state=>scan=state);assert.equal(scan.phase,'complete');const rows=db.list({view:'all',limit:100}).items;assert.equal(rows.length,fixtures.filter(f=>!f.error).length,JSON.stringify({scan,rows:rows.map(r=>r.path)}));report.import={rows:rows.length,issues:scan.errors};db.close();db=null;
  const installed=process.env.AURAL_ARTWORK_MATRIX_EXE;
  if(installed)report.packagedExecutableSha256=hash(fs.readFileSync(path.resolve(installed)));
  app=await _electron.launch({executablePath:installed||path.join(project,'node_modules/electron/dist/electron.exe'),args:installed?[]:[project],env:{...process.env,AURAL_TEST:'1',AURAL_TEST_DATA_DIR:data}});pid=app.process().pid;
  report.packagedInterface=await app.evaluate(({app})=>app.isPackaged);assert.equal(report.packagedInterface,Boolean(installed));
  app.process().stderr.on('data',chunk=>{diagnostics=(diagnostics+String(chunk)).slice(-65536);});const win=await app.firstWindow();win.setDefaultTimeout(30000);
  await (await app.browserWindow(win)).evaluate(w=>{w.webContents.setBackgroundThrottling(false);w.show();w.focus();});
  await until(async()=>(await win.evaluate(()=>window.music.scanJobs())).items.every(job=>!['queued','running','cancelling'].includes(job.status)),'startup scan settled');
  const actualRows=await win.evaluate(()=>window.music.list({view:'all',limit:100}));assert.equal(actualRows.items.length,10);
  report.tagMetadata=[];
  for(const name of ['WAV-v3-front','WAV-v4-front','DSF-v3-front','DSF-v4-other']){const fixture=fixtures.find(f=>f.name===name),item=actualRows.items.find(r=>r.path===fixture.file);assert.ok(item);assert.equal(item.artist,'格式验证歌手');assert.equal(item.album,'格式验证专辑');assert.notEqual(item.title,name);report.tagMetadata.push({name,title:item.title,artist:item.artist,album:item.album});}
  const painted=async(image,channel)=>{await image.waitFor({timeout:60000});await image.scrollIntoViewIfNeeded();await until(()=>image.evaluate(e=>e.complete&&e.naturalWidth>0),'decoded artwork');const bounds=await image.boundingBox();assert.ok(bounds);await until(async()=>{const png=(await win.screenshot({clip:bounds})).toString('base64');const pixel=await app.evaluate(({nativeImage},encoded)=>{const image=nativeImage.createFromBuffer(Buffer.from(encoded,'base64')),size=image.getSize(),bytes=image.toBitmap(),offset=(Math.floor(size.height/2)*size.width+Math.floor(size.width/2))*4;return {red:bytes[offset+2],blue:bytes[offset]};},png);return pixel[channel]>180&&pixel[channel==='red'?'blue':'red']<80;},'painted '+channel+' artwork');};
  for(const fixture of fixtures.filter(f=>!f.error)){
   const item=rows.find(row=>row.path===fixture.file);assert.ok(item);const row=win.locator(`[data-item-id="${item.id}"]`);await row.waitFor();await row.scrollIntoViewIfNeeded();await painted(row.locator('.track-art img'),fixture.expected==='embedded'?'red':'blue');
   const result=await win.evaluate(id=>window.music.artworkCandidate(id,[],1024,true),item.id);assert.equal(result.sourceKind,fixture.expected);assert.equal(result.token,hash(fixture.expected==='embedded'?red:blue));report.uiCases.push({name:fixture.name,libraryPixels:true,largeThumbnail:true,sourceKind:result.sourceKind});
  }
  const muted=await win.evaluate(async()=>{const {preference:p}=await window.music.audioOutput();return window.music.configureAudioOutput({commandId:crypto.randomUUID(),baseRevision:p.revision,deviceId:p.deviceId,mode:'shared',dsdPolicy:'pcm',processing:{...p.processing,muted:true}});});assert.equal(muted.status,'saved',muted.error);report.playback=[];
  for(const name of ['WAV-v3-front','DSF-v3-front']){
   const fixture=fixtures.find(f=>f.name===name),item=rows.find(r=>r.path===fixture.file),row=win.locator(`[data-item-id="${item.id}"]`);await row.locator('.track-play').click();await until(async()=>{const p=await win.evaluate(()=>window.music.playback());if(p.state==='error')throw new Error(JSON.stringify(p));return p.itemId===item.id&&p.state==='playing';},'muted '+name+' playback');
   const playback=await win.evaluate(()=>window.music.playback());await win.getByRole('button',{name:'暂停',exact:true}).click();await painted(win.locator('.player-cover img'),'red');await win.getByRole('button',{name:'打开播放详情',exact:true}).click();const detail=win.getByRole('region',{name:'播放详情'});await detail.waitFor();await painted(detail.locator('.detail-art img'),'red');await win.keyboard.press('Escape');await detail.waitFor({state:'hidden'});await win.evaluate(()=>window.music.stop());report.playback.push({name,playing:true,playerPixels:true,detailPixels:true,actualOutput:playback.actualOutput});
  }
  for(const fixture of fixtures){assert.equal(fs.statSync(fixture.file).size,before[fixture.name].size);assert.equal(fs.statSync(fixture.file).mtimeMs,before[fixture.name].mtime);}report.mediaUnchanged=true;report.completed=true;console.log('Artwork formats MVP passed:',JSON.stringify({workerCases:report.workerCases.length,uiCases:report.uiCases.length,playback:report.playback.map(p=>p.name),largeMetadataAt:report.largeFixture.metadataAt}));
 }catch(error){report.error=String(error.stack||error);throw error;}
 finally{
  db?.close();if(app){let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Electron close timed out')),15000))]);}catch(error){report.completed=false;report.cleanupError=String(error);process.exitCode=1;if(app.process().exitCode===null&&Number.isSafeInteger(pid))execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});}finally{clearTimeout(timer);}}
  report.diagnostics=diagnostics;if(process.env.AURAL_ARTWORK_MATRIX_REPORT)fs.writeFileSync(path.resolve(process.env.AURAL_ARTWORK_MATRIX_REPORT),JSON.stringify(report,null,2)+'\n');
  if(report.completed&&path.dirname(scratch)===parent&&path.basename(scratch).startsWith('aural-artwork-matrix-mvp-')&&fs.realpathSync(scratch)===scratch)fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:200});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
