const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks'),{randomUUID}=require('node:crypto');
const {LibraryDatabase}=require('../dist/main/library/database.js'),{scanRoot}=require('../dist/main/library/scanner.js');
const {writeTaggedFlac}=require('./tagged-flac.cjs');
const truth=require('./fixtures/search-mvp-truth.json');
const {readSearchIndexState}=require('../dist/main/shared/search-index.js');
async function until(check,label){const end=Date.now()+20000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,60));}throw new Error(`Timed out: ${label}`);}
async function main(){
 const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-search-mvp-'));
 const music=path.join(scratch,'music'),data=path.join(scratch,'userdata'),filename=path.join(data,'library/library.db');let db,app,pid;
 try{
  fs.mkdirSync(music);fs.mkdirSync(path.dirname(filename),{recursive:true});const audio=path.join(root,'native/audio-host/testdata/cue-gold-44100-16bit.flac');
  const write=track=>writeTaggedFlac(audio,path.join(music,`${track.key}.flac`),{TITLE:track.title,ARTIST:track.artist,ALBUM:track.album,GENRE:track.genre},[]);
  truth.tracks.forEach(write);db=new LibraryDatabase(filename);const rootId=db.addRoot(music);let scan;
  const rescan=async()=>{await scanRoot(db,rootId,state=>{scan=state;});assert.equal(scan.phase,'complete',JSON.stringify(scan));assert.equal(scan.errors,0,JSON.stringify(db.scanJobs.issues(scan.jobId).items));};
  await rescan();assert.equal(db.list({view:'all'}).total,truth.tracks.length);
  let index=db.searchIndex.state();while(index.status==='building')index=db.searchIndex.step();assert.equal(index.status,'ready',JSON.stringify(index));
  assert.equal(readSearchIndexState(index).status,'ready');
  const items=db.list({view:'all',limit:100}).items,byId=new Map(items.map(item=>[item.id,path.basename(item.path,'.flac')])),byKey=new Map(items.map(item=>[path.basename(item.path,'.flac'),item]));
  const results=[],failures=[];
  for(const test of truth.cases){
   const {name,expected,first,...request}=test,start=performance.now(),response=db.list({view:'all',limit:100,...request}),ms=performance.now()-start,actual=response.items.map(item=>byId.get(item.id));
   const result={name,query:request.query,ms:Number(ms.toFixed(3)),expected,actual,total:response.total,matches:response.items.map(item=>item.searchMatch)};results.push(result);
   try{assert.deepEqual([...actual].sort(),[...expected].sort());assert.equal(response.total,expected.length);if(first)assert.equal(actual[0],first);}catch(error){failures.push({...result,error:String(error.message)});}
  }
  console.log('MVP search truth results:',JSON.stringify(results));assert.equal(failures.length,0,JSON.stringify(failures,null,2));
  // A controlled prior-v2 derived index, retaining the real current catalog and media rows.
  const legacyAlgorithm='pinyin-pro-3.29.4:nfkc:phrase256:artist-surname:v2:latin-nfkd-word-bigram-trigram-osa2:v1:nfkc-lower-utf32-natural-integer-leadingzero-date-range:v1';
  db.db.exec('BEGIN IMMEDIATE; DELETE FROM search_fts; DELETE FROM search_gram;');
  try{
   const insert=db.db.prepare('INSERT INTO search_fts(item_id,title,artist,album,genre) VALUES(?,?,?,?,?)'),gram=db.db.prepare('INSERT OR IGNORE INTO search_gram(gram,item_id) VALUES(?,?)');
   for(const item of items){const fields=[item.title,item.artist,item.album,item.genre].map(value=>value.normalize('NFKC').toLowerCase().trim());insert.run(item.id,...fields);
    for(const field of fields)for(const word of field.split(/[\s\p{P}\p{S}]+/u)){const chars=[...word];for(let i=0;i<chars.length;i++){if(/\p{Script=Han}/u.test(chars[i]))gram.run(chars[i],item.id);if(i+1<chars.length&&/\p{Script=Han}/u.test(chars[i]+chars[i+1]))gram.run(chars[i]+chars[i+1],item.id);}}
   }
   db.db.prepare('UPDATE search_latin SET algorithm=?').run(legacyAlgorithm);db.db.prepare("UPDATE search_index_state SET algorithm=?,status='ready' WHERE id=1").run(legacyAlgorithm);db.db.exec('COMMIT;');
  }catch(error){db.db.exec('ROLLBACK;');throw error;}
  db.close();db=new LibraryDatabase(filename);assert.equal(db.searchIndex.state().status,'building');assert.equal(db.list({view:'all',query:'後來'}).items[0].id,byKey.get('later').id);
  index=db.searchIndex.state();while(index.status==='building')index=db.searchIndex.step();assert.equal(index.status,'ready',JSON.stringify(index));
  assert.equal(db.list({view:'all',query:'后来'}).items[0].id,byKey.get('later').id);assert.equal(db.getItem(byKey.get('later').id).title,'後來');assert.equal(db.getItem(byKey.get('later').id).artist,'劉若英');
  const retained=byKey.get('rice');db.user.setState({itemId:retained.id,favorite:true,rating:4,baseRevision:0,commandId:randomUUID()});const addedAt=db.getItem(retained.id).addedAt;
  write({...truth.tracks.find(track=>track.key==='night'),title:'晓光',artist:'更新歌手',album:'更新专辑',genre:'爵士'});await rescan();
  assert.equal(db.getItem(byKey.get('night').id).title,'晓光');assert.equal(db.list({view:'all',query:'yequ'}).total,0);
  assert.deepEqual(db.list({view:'all',query:'周杰伦'}).items.map(item=>item.id),[retained.id]);
  assert.equal(db.list({view:'genres',value:'爵士',query:'xiaoguang'}).total,1);
  fs.unlinkSync(path.join(music,'rice.flac'));await rescan();
  // Architecture section 9/14: missing files retain searchable records and user data.
  const missing=db.list({view:'all',query:'daoxiang'});assert.equal(missing.total,1);assert.equal(missing.items[0].id,retained.id);assert.equal(missing.items[0].available,false);
  assert.equal(db.getItem(retained.id).available,false);assert.equal(db.getItem(retained.id).favorite,true);assert.equal(db.getItem(retained.id).rating,4);
  write(truth.tracks.find(track=>track.key==='rice'));await rescan();assert.equal(db.list({view:'all',query:'daoxiang'}).items[0].id,retained.id);
  assert.equal(db.getItem(retained.id).addedAt,addedAt);assert.equal(db.getItem(retained.id).rating,4);
  db.close();db=new LibraryDatabase(filename);assert.equal(db.list({view:'favorites',query:'daoxiang'}).items[0].id,retained.id);db.close();db=null;
  const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
  app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],env:{...process.env,AURAL_TEST:'1',AURAL_TEST_DATA_DIR:data}});pid=app.process().pid;
  app.process().stderr?.on('data',chunk=>console.error('ELECTRON:',String(chunk)));const win=await app.firstWindow();win.setDefaultTimeout(20000);
  await (await app.browserWindow(win)).evaluate(window=>{window.webContents.setBackgroundThrottling(false);window.showInactive();});
  await until(async()=>(await win.evaluate(()=>window.music.scanJobs())).items.every(job=>!['queued','running','cancelling'].includes(job.status))&&(await win.evaluate(()=>window.music.searchIndexState())).status==='ready','startup scan and search index ready');
  const query=win.getByRole('textbox',{name:'搜索音乐',exact:true});await query.waitFor();
  await until(async()=>await win.locator('.search-index-notice').count()===0,'valid renderer search index receipt');
  const visibleKeys=async()=>win.locator('.track-row[data-item-id]').evaluateAll(rows=>rows.map(row=>row.dataset.itemId));
  const expectKeys=async keys=>{const ids=keys.map(key=>byKey.get(key).id).sort();await until(async()=>JSON.stringify((await visibleKeys()).sort())===JSON.stringify(ids),`UI search ${keys}`);};
  await query.fill('后来');await expectKeys(['later','later-remix']);assert.ok((await win.locator('.track-row').first().textContent()).includes('後來'));
  await query.fill('zjl');await expectKeys(['rice']);await query.fill('rhpasody');await expectKeys(['rhapsody']);
  await query.fill('zhoujielun');await query.fill('quene');await query.fill('beyonce');await expectKeys(['accent']);
  await query.fill('');await win.locator('.nav-item').filter({hasText:'风格'}).click();await win.locator('.genre-name').filter({hasText:'Rock'}).click();
  await query.fill('rhpasody');await expectKeys(['rhapsody']);
  assert.equal(await win.locator('.search-index-notice').count(),0);
  if(process.env.AURAL_SEARCH_SCREENSHOT)await win.screenshot({path:process.env.AURAL_SEARCH_SCREENSHOT});
  console.log('Search truth, normalized exact ranking, scoped fuzzy recall, prior-v2 derived index rebuild, real tag rescan/index replacement, missing/reappearing file identity and user state, database reopening, and Electron search/facet UI passed');
 }finally{
  db?.close();if(app){let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Electron close timeout')),10000);})]);}catch(error){console.error('SEARCH CLEANUP:',error);process.exitCode=1;if(Number.isSafeInteger(pid)&&pid>0)require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});}finally{clearTimeout(timer);}}
  if(path.dirname(scratch)===path.resolve(os.tmpdir())&&path.basename(scratch).startsWith('aural-search-mvp-'))fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
