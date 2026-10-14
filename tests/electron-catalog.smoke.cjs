const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
const {LibraryDatabase}=require('../dist/main/library/database.js');
const {scanRoot}=require('../dist/main/library/scanner.js');
async function until(check,label){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,75));}throw new Error(`Timed out: ${label}`);}
async function main(){
  const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-catalog-ui-'));
  const data=path.join(scratch,'userdata'),music=path.join(scratch,'music');fs.mkdirSync(path.join(data,'library'),{recursive:true});
  for(const folder of ['box/CD1','box/CD2','reissue'])fs.mkdirSync(path.join(music,folder),{recursive:true});
  const write=require('./tagged-mp3.cjs').writeTaggedMp3;
  write(path.join(music,'box/CD1/song.mp3'),{title:'碟一作品',disc:1,date:'2000'});
  write(path.join(music,'box/CD2/song.mp3'),{title:'碟二作品',disc:2,date:'2000'});
  write(path.join(music,'reissue/song.mp3'),{title:'再版作品',date:'2020-05'});
  const filename=path.join(data,'library','library.db');
  const db=new LibraryDatabase(filename);const rootId=db.addRoot(music);await scanRoot(db,rootId,()=>{});
  const item=db.list({view:'all'}).items.find(i=>i.title==='碟一作品');
  db.user.setState({itemId:item.id,favorite:true,rating:4,baseRevision:0,commandId:randomUUID()});
  db.user.create('旧版歌单',randomUUID(),[item.id,item.id]);db.close();
  const old=new DatabaseSync(filename);require('./legacy-schema.cjs').stripV6(old);old.close();
  const executable=process.env.AURAL_CATALOG_EXE;
  const app=await _electron.launch({executablePath:executable||path.join(root,'node_modules','electron','dist','electron.exe'),
    args:executable?[]:[root],env:{...process.env,AURAL_TEST:'1',AURAL_TEST_DATA_DIR:data}});
  app.process().stderr?.on('data',chunk=>console.error('ELECTRON:',String(chunk)));
  const electronPid=await app.evaluate(()=>process.pid);
  try{
    const win=await app.firstWindow();win.setDefaultTimeout(15000);await win.locator('.track-row').first().waitFor();
    assert.equal(fs.readdirSync(path.join(data,'library')).filter(n=>n.includes('.pre-v6-')).length,1);
    await win.getByRole('button',{name:'重新扫描 music',exact:true}).click();
    await until(async()=>(await win.evaluate(()=>window.music.facets('albums'))).some(a=>a.subtitle.includes('2020-05')),'full tag rescan after upgrade');
    await win.locator('.nav-item').filter({hasText:'专辑'}).click();
    await until(async()=>await win.locator('[data-facet-id]').count()===2,'distinct release chips');
    await win.locator('[data-facet-id]').filter({hasText:'2020-05'}).click();
    await until(async()=>await win.locator('.track-row').count()===1,'reissue exact ID filter');
    assert.ok((await win.locator('.track-row').textContent()).includes('再版作品'));
    await win.locator('.nav-item').filter({hasText:'歌手'}).click();
    await win.getByLabel('艺人角色').selectOption('composer');
    await win.locator('[data-facet-id]').filter({hasText:'作曲家'}).click();
    await until(async()=>await win.locator('.track-row').count()===3,'composer facet');
    await win.getByLabel('艺人角色').selectOption('album_artist');
    await win.locator('[data-facet-id]').filter({hasText:'合集艺人'}).click();
    await until(async()=>await win.locator('.track-row').count()===3,'album artist facet');
    await win.locator('.track-row').filter({hasText:'碟一作品'}).locator('.track-play').click();
    await until(async()=>(await win.evaluate(()=>window.music.playback())).state==='playing','native playback');
    await win.getByRole('button',{name:'打开播放详情',exact:true}).click();
    const detail=win.getByRole('region',{name:'播放详情'});
    await detail.locator('.detail-art img').waitFor();
    await detail.locator('.detail-secondary > summary').filter({hasText:'更多歌曲资料'}).click();
    for(const name of ['甲','乙','AC/DC','作曲家','指挥家','合集艺人','Jazz','电子'])await detail.locator('.detail-fields').getByRole('button',{name,exact:true}).waitFor();
    if(process.env.AURAL_CATALOG_SCREENSHOT){
      await (await app.browserWindow(win)).evaluate(window=>window.show());
      await win.screenshot({path:process.env.AURAL_CATALOG_SCREENSHOT,timeout:20000});
    }
    await detail.getByRole('button',{name:'同名专辑',exact:true}).click();
    await until(async()=>await win.locator('.track-row').count()===2,'detail precise release ID');
    assert.deepEqual(await win.locator('.track-names strong').allTextContents(),['碟一作品','碟二作品']);
    await win.getByRole('button',{name:'打开播放详情',exact:true}).click();
    await detail.getByRole('button',{name:'乙',exact:true}).click();
    assert.equal(await win.getByLabel('艺人角色').inputValue(),'performer');
    await until(async()=>await win.locator('.track-row').count()===3,'secondary performer browse');
    const user=await win.evaluate(async()=>({favorites:await window.music.list({view:'favorites'}),playlists:await window.music.playlists()}));
    assert.equal(user.favorites.items[0].rating,4);assert.equal(user.playlists[0].count,2);
    await win.evaluate(()=>window.music.stop());
    console.log('v5 upgrade, rescan, precise editions, multi-disc order, artist roles, detail links and retained user data passed');
  }catch(error){console.error('CATALOG CHECK:',error);throw error;}finally{
    let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('close timeout')),10000);})]);}
    catch(error){
      console.error('APP CLOSE:',error);process.exitCode=1;
      if(Number.isSafeInteger(electronPid)&&electronPid>0)require('node:child_process').execFileSync('taskkill',['/PID',String(electronPid),'/T','/F'],{windowsHide:true});
    }finally{clearTimeout(timer);}
    assert.equal(path.dirname(scratch),os.tmpdir());
    try{fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
    catch(error){console.error('TEMP CLEANUP:',error);process.exitCode=1;}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
