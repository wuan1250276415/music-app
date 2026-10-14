const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function main(){
 const project=path.resolve(__dirname,'..'),parent=path.resolve('D:/CodexTestData');fs.mkdirSync(parent,{recursive:true});const scratch=fs.mkdtempSync(path.join(parent,'aural-caa-ipc-mvp-')),data=path.join(scratch,'userdata');
 const report={version:require('../package.json').version,scope:'actual Main/preload/Library Service new IPC/provider setting guards and persistence; no valid MusicBrainz candidate/network match',completed:false,cases:[],scratch};let app,pid;
 try{
  app=await _electron.launch({executablePath:path.join(project,'node_modules/electron/dist/electron.exe'),args:[project],env:{...process.env,AURAL_TEST:'1',AURAL_TEST_DATA_DIR:data}});pid=app.process().pid;
  const win=await app.firstWindow();win.setDefaultTimeout(30000);await win.locator('.sidebar-footer').waitFor();await win.waitForFunction(()=>typeof window.music?.coverArtSourceIndex==='function');
  const results=await win.evaluate(async()=>{
   const rejected=async(work)=>{try{await work();return '';}catch(error){return String(error);}},states=await window.music.providers(),state=states.find(s=>s.manifest.id==='cover-art-archive');
   const request={itemId:'fixture-unknown-item',token:'11111111-1111-1111-1111-111111111111',requestId:crypto.randomUUID(),fingerprint:'a'.repeat(64),fresh:false};
   const disabled=await rejected(()=>window.music.coverArtSourceIndex(request));
   const imageRequest={...request,imageId:'829521842'};
   const imageDisabled=await rejected(()=>window.music.coverArtImagePreview(imageRequest));
   const setting={providerId:'cover-art-archive',commandId:crypto.randomUUID(),revision:state.revision,enabled:true};await window.music.configureProvider(setting);await window.music.configureProvider(setting);
   const saved=(await window.music.providers()).find(s=>s.manifest.id==='cover-art-archive');
   await window.music.setMetadataNetworkEnabled(true);
   const expired=await rejected(()=>window.music.coverArtSourceIndex({...request,requestId:crypto.randomUUID()}));
   const imageExpired=await rejected(()=>window.music.coverArtImagePreview({...imageRequest,requestId:crypto.randomUUID()}));
   const imageMalformed=await rejected(()=>window.music.coverArtImagePreview({...imageRequest,imageId:'../private'}));
   const badPreviewRelease=await rejected(()=>window.music.releaseCoverArtImagePreview('https://evil.invalid/image.jpg'));
   const badLocalRelease=await rejected(()=>window.music.releaseCoverArtImagePreview('aural-artwork://image/'+'a'.repeat(64)+'.jpg'));
   await window.music.releaseCoverArtImagePreview('aural-artwork://preview/'+'a'.repeat(64)+'.jpg');
   const malformed=await rejected(()=>window.music.coverArtSourceIndex({...request,requestId:'not-uuid'}));
   const oversized=await rejected(()=>window.music.coverArtSourceIndex({...request,itemId:'x'.repeat(129)}));
   const badSource=await rejected(()=>window.music.openMetadataSource('https://musicbrainz.org.evil.invalid/release/11111111-1111-1111-1111-111111111111/cover-art'));
   const badSuffix=await rejected(()=>window.music.openMetadataSource('https://musicbrainz.org/release/11111111-1111-1111-1111-111111111111/cover-art?target=private'));
   await window.music.clearMetadataNetworkCache();await window.music.setMetadataNetworkEnabled(false);
   const paused=await rejected(()=>window.music.coverArtSourceIndex({...request,requestId:crypto.randomUUID()}));
   return {disabled,imageDisabled,imageExpired,imageMalformed,badPreviewRelease,badLocalRelease,saved,expired,malformed,oversized,badSource,badSuffix,paused,settingRevision:state.revision,manifest:state.manifest};
  });
  assert.match(results.disabled,/启用/);assert.equal(results.saved.revision,results.settingRevision+1);assert.equal(results.saved.enabled,true);assert.equal(results.manifest.capabilities[0].label,'封面来源查询与图片选择');assert.match(results.expired,/过期/);assert.match(results.malformed,/无效封面来源查询/);assert.match(results.oversized,/无效封面来源查询/);assert.match(results.badSource,/无效来源地址/);assert.match(results.badSuffix,/无效来源地址/);assert.match(results.paused,/启用/);
  report.cases.push('real narrow preload route','default source disabled','source setting command replay is idempotent','real service rejects unavailable candidate','malformed request and size guard','source URL domain and suffix guard','network pause disables source query');report.results=results;
  assert.match(results.imageDisabled,/启用/);assert.match(results.imageExpired,/过期/);assert.match(results.imageMalformed,/无效封面图片预览/);assert.match(results.badPreviewRelease,/无效在线图片预览地址/);assert.match(results.badLocalRelease,/无效在线图片预览地址/);report.cases.push('real image preview route disabled/expired candidate guards','image identity shape guard','preview release cannot address external or local library assets');
  await win.getByRole('button',{name:'数据源设置',exact:false}).first().click();const dialog=win.getByRole('dialog',{name:'数据源设置'});await dialog.waitFor();const card=dialog.getByRole('region',{name:'Cover Art Archive 数据源'});await card.getByText('封面来源查询与图片选择',{exact:true}).waitFor();assert.ok((await card.innerText()).includes('导出未开放'));report.cases.push('actual app source settings text');
  await dialog.getByRole('button',{name:'关闭数据源设置'}).click();
  report.fingerprints=Object.fromEntries(['src/main/main.ts','src/main/preload.ts','src/library/service.ts','src/library/providers.ts','src/shared/contracts.ts','dist/main/main/main.js','dist/main/main/preload.js','dist/main/library/service.js'].map(name=>[name,hash(fs.readFileSync(path.join(project,name)))]));
  await app.close();app=null;
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.join(data,'library/library.db'),{readOnly:true});try{const row=db.prepare("SELECT enabled,revision FROM provider_setting WHERE provider_id='cover-art-archive'").get();assert.equal(row.enabled,1);assert.equal(row.revision,results.settingRevision+1);assert.equal(db.prepare('PRAGMA user_version').get().user_version,74);report.persistedSetting=row;report.schema=74;}finally{db.close();}
  report.completed=true;
 }finally{
  if(app){let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('owned IPC close timeout')),10000);})]);}catch(error){report.completed=false;report.closeError=String(error);if(Number.isSafeInteger(pid)&&pid>0)require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});process.exitCode=1;}finally{clearTimeout(timer);}}
  if(process.env.AURAL_CAA_IPC_REPORT)fs.writeFileSync(process.env.AURAL_CAA_IPC_REPORT,JSON.stringify(report,null,2));
  if(report.completed&&path.dirname(scratch)===parent&&path.basename(scratch).startsWith('aural-caa-ipc-mvp-')&&fs.realpathSync(scratch)===scratch)fs.rmSync(scratch,{recursive:true,force:true});
 }console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
