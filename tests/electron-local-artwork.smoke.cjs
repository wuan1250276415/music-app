// Opt-in MVP reproduction on a copy of a user-selected FLAC. Never writes tags
// or imports the user's whole download directory. Source media is not archived.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
const {LibraryDatabase}=require('../dist/main/library/database.js'),{scanRoot}=require('../dist/main/library/scanner.js');
const hash=filename=>createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
async function until(check,label){const end=Date.now()+20000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,70));}throw new Error(`Timed out: ${label}`);}
function flacPictures(filename){
 const fd=fs.openSync(filename,'r'),head=Buffer.alloc(4);let at=4,pictures=0;
 try{assert.equal(fs.readSync(fd,head,0,4,0),4);assert.equal(head.toString('ascii'),'fLaC');
  for(let i=0;i<1000;i++){assert.equal(fs.readSync(fd,head,0,4,at),4);at+=4;const length=head.readUIntBE(1,3),type=head[0]&127;if(type===6)pictures++;at+=length;if(head[0]&128)return pictures;}
  throw new Error('FLAC metadata block limit exceeded');
 }finally{fs.closeSync(fd);}
}
async function main(){
 assert.ok(process.env.AURAL_ARTWORK_FILE,'Set AURAL_ARTWORK_FILE to the user-selected FLAC');
 const source=path.resolve(process.env.AURAL_ARTWORK_FILE),before=hash(source),pictures=flacPictures(source);
 const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-local-artwork-')),data=path.join(scratch,'userdata'),music=path.join(scratch,'music');let db,app,pid,diagnostics='';
 const report={appVersion:require('../package.json').version,sourceName:path.basename(source),sourceSha256:before,flacPictureBlocks:pictures,scope:'isolated copied FLAC, local artwork and actual Electron library/player/detail; no online cover lookup or tag write',completed:false};
 const save=()=>{if(process.env.AURAL_ARTWORK_REPORT)fs.writeFileSync(path.resolve(process.env.AURAL_ARTWORK_REPORT),JSON.stringify(report,null,2)+'\n');};
 try{
  fs.mkdirSync(path.join(data,'library'),{recursive:true});fs.mkdirSync(music);fs.copyFileSync(source,path.join(music,path.basename(source)));
  db=new LibraryDatabase(path.join(data,'library/library.db'));let scan;await scanRoot(db,db.addRoot(music),state=>scan=state);assert.equal(scan.phase,'complete');assert.equal(scan.errors,0);const rows=db.list({view:'all'}).items;assert.equal(rows.length,1);const item=rows[0];report.item={title:item.title,artist:item.artist,album:item.album,sampleRate:item.sampleRate,bits:item.bitsPerSample};db.close();db=null;
  app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],env:{...process.env,AURAL_TEST:'1',AURAL_TEST_DATA_DIR:data}});pid=app.process().pid;
  app.process().stderr?.on('data',chunk=>{diagnostics=(diagnostics+String(chunk)).slice(-32768);console.error('ELECTRON:',String(chunk));});
  const win=await app.firstWindow();win.setDefaultTimeout(20000);await (await app.browserWindow(win)).evaluate(window=>{window.webContents.setBackgroundThrottling(false);window.showInactive();});
  await until(async()=>(await win.evaluate(()=>window.music.scanJobs())).items.every(job=>!['queued','running','cancelling'].includes(job.status)),'startup scans settled');
  const row=win.locator(`[data-item-id="${item.id}"]`);await row.waitFor();await row.scrollIntoViewIfNeeded();
  const candidate=await win.evaluate(id=>window.music.artworkCandidate(id,[],256,true),item.id);report.artwork=candidate?{sourceKind:candidate.sourceKind,label:candidate.label}:null;
  if(pictures)assert.equal(candidate?.sourceKind,'embedded');else assert.equal(candidate,null);
  const check=async artwork=>{await until(async()=>await artwork.getAttribute('aria-busy')==='false','artwork read settled');if(candidate)await until(()=>artwork.locator('img').evaluate(image=>image.complete&&image.naturalWidth>0),'embedded artwork decoded');else{assert.equal(await artwork.locator('img').count(),0);assert.match(await artwork.getAttribute('title'),/未找到可显示的本地封面/);}};
  await check(row.locator('.track-art'));
  const muted=await win.evaluate(async()=>{const {preference:p}=await window.music.audioOutput();return window.music.configureAudioVolume({commandId:crypto.randomUUID(),baseRevision:p.revision,deviceId:p.deviceId,mode:p.mode,dsdPolicy:p.dsdPolicy,processing:{...p.processing,muted:true}});});assert.equal(muted.status,'saved',muted.error);
  await row.locator('.track-play').click();await until(async()=>{const p=await win.evaluate(()=>window.music.playback());return p.itemId===item.id&&p.state==='playing';},'actual copied FLAC playback');await win.getByRole('button',{name:'暂停',exact:true}).click();await check(win.locator('.player-cover'));
  await win.getByRole('button',{name:'打开播放详情',exact:true}).click();const detail=win.getByRole('region',{name:'播放详情'});await detail.waitFor();await check(detail.locator('.detail-art'));report.detailStatus=await detail.locator('.detail-art-source').textContent();
  if(process.env.AURAL_ARTWORK_SCREENSHOT)await win.screenshot({path:path.resolve(process.env.AURAL_ARTWORK_SCREENSHOT)});
  await detail.locator('.detail-fields').first().getByRole('button',{name:item.artist,exact:true}).click();await detail.waitFor({state:'hidden'});assert.equal(await win.locator('.hero h1').textContent(),item.artist);
  await win.evaluate(()=>window.music.stop());report.completed=true;save();console.log('User-selected FLAC import, local cover presence/absence, muted playback, player/detail and artist retrieval passed');
 }catch(error){report.error=String(error.stack||error);save();throw error;}
 finally{
  db?.close();if(app){let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Electron close timeout')),10000))]);}catch(error){console.error('LOCAL ARTWORK CLEANUP:',error);process.exitCode=1;if(Number.isSafeInteger(pid)&&pid>0)require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});}finally{clearTimeout(timer);}}
  report.sourceUnchanged=hash(source)===before;report.shutdownDiagnostics=diagnostics;save();assert.equal(report.sourceUnchanged,true,'Original media changed');
  if(path.dirname(scratch)===path.resolve(os.tmpdir())&&path.basename(scratch).startsWith('aural-local-artwork-'))fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
