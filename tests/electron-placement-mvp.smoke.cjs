const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
const {readWindowPlacementPreference}=require('../dist/main/shared/window-placement.js');
async function digest(file){const h=createHash('sha256');for await(const bytes of fs.createReadStream(file))h.update(bytes);return h.digest('hex');}
function preference(file){const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});try{const row=db.prepare("SELECT value FROM app_setting WHERE key='window_placement'").get();return row?readWindowPlacementPreference(JSON.parse(row.value)):null;}finally{db.close();}}
async function until(check,label){const end=Date.now()+30000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(label);}
async function main(){
 if(!process.env.AURAL_PLACEMENT_SOURCE_DB)throw new Error('explicit controlled schema73 catalog required');
 const project=path.resolve(__dirname,'..'),source=path.resolve(process.env.AURAL_PLACEMENT_SOURCE_DB),parent=path.resolve(process.env.AURAL_PLACEMENT_SCRATCH_PARENT||os.tmpdir());
 const ordinary=fs.lstatSync(source);assert.ok(ordinary.isFile()&&!ordinary.isSymbolicLink());fs.mkdirSync(parent,{recursive:true});
 const scratch=fs.mkdtempSync(path.join(parent,'aural-placement-mvp-')),data=path.join(scratch,'userdata'),folder=path.join(data,'library'),file=path.join(folder,'library.db');
 const report={appVersion:require('../package.json').version,scope:'actual Main geometry persistence and application reopening; isolated copied synthetic100k schema73 catalog, no installer or cold certification',scratch,completed:false};let app,pid;
 const close=async()=>{if(!app)return;const current=app;app=null;let timer;try{await Promise.race([current.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Electron close timeout')),15000);})]);}catch(error){if(current.process().exitCode===null&&Number.isSafeInteger(pid)&&pid>0)require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});throw error;}finally{clearTimeout(timer);}};
 const launch=async()=>{app=await _electron.launch({executablePath:path.join(project,'node_modules/electron/dist/electron.exe'),args:[project],env:{...process.env,AURAL_TEST:'1',AURAL_TEST_DATA_DIR:data}});pid=app.process().pid;const win=await app.firstWindow();await win.getByRole('textbox',{name:'搜索音乐',exact:true}).waitFor();assert.equal((await win.evaluate(()=>window.music.list({view:'all',limit:100}))).total,100000);return win;};
 try{
  report.originalSha256=await digest(source);fs.mkdirSync(folder,{recursive:true});fs.copyFileSync(source,file);assert.equal(await digest(file),report.originalSha256);
  let win=await launch();const window=await app.browserWindow(win),initial=await window.evaluate(w=>w.getNormalBounds());
  const target=await app.evaluate(({screen})=>{const a=screen.getPrimaryDisplay().workArea;return {x:a.x+20,y:a.y+20,width:Math.min(1080,a.width-40),height:Math.min(720,a.height-40)};});
  await window.evaluate((w,bounds)=>{w.showInactive();w.setBounds(bounds);},target);
  const actual=await window.evaluate(w=>w.getNormalBounds());assert.notDeepEqual(actual,initial);
  await until(async()=>{const saved=preference(file);return saved?.enabled&&JSON.stringify(saved.placement?.bounds)===JSON.stringify(actual);},'normal window bounds were not durably saved after resizing during 100k startup');
  assert.equal(await win.getByText(/窗口位置.*自动保存已暂停/).count(),0);report.saved=preference(file);
  await close();win=await launch();const restored=await (await app.browserWindow(win)).evaluate(w=>w.getNormalBounds());assert.deepEqual(restored,actual);report.restored=restored;
  assert.equal(await win.getByText(/窗口位置.*自动保存已暂停/).count(),0);await close();assert.equal(await digest(source),report.originalSha256);report.originalUnchanged=true;report.completed=true;
  console.log('Actual100k startup resize, durable preference, no paused autosave warning, application reopening and exact restored bounds passed');
 }catch(error){report.error=String(error.stack||error);throw error;}
 finally{try{await close();}finally{if(process.env.AURAL_PLACEMENT_REPORT)fs.writeFileSync(path.resolve(process.env.AURAL_PLACEMENT_REPORT),JSON.stringify(report,null,2)+'\n');if(report.completed&&path.dirname(scratch)===parent&&path.basename(scratch).startsWith('aural-placement-mvp-')&&fs.realpathSync(scratch)===scratch)fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:200});}}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
