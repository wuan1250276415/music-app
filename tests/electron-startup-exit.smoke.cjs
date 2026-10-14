// Actual startup UI exit while SQLite is saving a large upgrade snapshot.
// Retain the interrupted private copy for subsequent restart/fault validation.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{performance}=require('node:perf_hooks'),{DatabaseSync}=require('node:sqlite');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
async function hash(file){const h=createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
const tables=['media_file','playable_item','recording','release','release_track','artist','metadata_override','item_user_state','playlist_item','playback_history','cue_document','search_latin','item_sort_key'];
function inspect(file,integrity=false){const db=new DatabaseSync(file,{allowExtension:false});try{db.function('aural_cue_path_key_v1',{deterministic:true},require('../dist/main/library/cue-history.js').cuePathKey);return {schema:Number(db.prepare('PRAGMA user_version').get().user_version),counts:Object.fromEntries(tables.map(table=>[table,Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n)])),...(integrity?{integrity:db.prepare('PRAGMA integrity_check(1)').get().integrity_check,foreignKeyViolation:db.prepare('PRAGMA foreign_key_check').get()??null}:{})};}finally{db.close();}}
async function main(){
 assert.ok(process.env.AURAL_UPGRADE_SOURCE_DB&&process.env.AURAL_UPGRADE_SCRATCH_PARENT,'controlled schema72 source and scratch parent must be explicit');
 const project=path.resolve(__dirname,'..'),source=path.resolve(process.env.AURAL_UPGRADE_SOURCE_DB),parent=path.resolve(process.env.AURAL_UPGRADE_SCRATCH_PARENT);
 const stat=fs.lstatSync(source,{bigint:true});assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n);
 const space=fs.statfsSync(parent,{bigint:true});assert.ok(space.bavail*space.bsize>=stat.size*3n+256n*1024n*1024n);
 const scratch=fs.mkdtempSync(path.join(parent,'aural-startup-exit-mvp-')),data=path.join(scratch,'userdata'),library=path.join(data,'library'),file=path.join(library,'library.db');
 const report={appVersion:require('../package.json').version,scope:'actual startup document exit during snapshot save; private synthetic100k copy integrity after real process exit; no resumed migration or full fault matrix proof',scratch,completed:false};
 let app,pid,diagnostics='';
 try {
  report.originalSha256=await hash(source);fs.mkdirSync(library,{recursive:true});fs.copyFileSync(source,file);assert.equal(await hash(file),report.originalSha256);
  // Inspect only the private copy; the original is strictly read-only.
  const before=inspect(file);assert.equal(before.schema,72);assert.equal(before.counts.playable_item,100000);
  app=await _electron.launch({executablePath:path.join(project,'node_modules/electron/dist/electron.exe'),args:[project],timeout:120000,env:{...process.env,AURAL_TEST:'1',AURAL_STARTUP_TEST:'1',AURAL_TEST_DATA_DIR:data,AURAL_STARTUP_TRACE:path.join(scratch,'startup-exit.json')}});pid=app.process().pid;
  app.process().stderr?.on('data',bytes=>{diagnostics=(diagnostics+String(bytes)).slice(-65536);});
  const win=await app.firstWindow({timeout:120000});await win.getByRole('button',{name:'退出',exact:true}).waitFor({timeout:60000});
  await win.waitForFunction(()=>document.body.dataset.phase==='snapshot-save',{},{timeout:120000});
  const utility=await app.evaluate(({app})=>app.getAppMetrics().find(metric=>metric.type==='Utility'&&metric.name==='Aural Library Service')?.pid);
  assert.ok(Number.isSafeInteger(utility)&&utility>0,'actual Library utility PID must be observed before exit');report.libraryPid=utility;
  const began=performance.now(),closed=app.waitForEvent('close',{timeout:15000});
  await win.getByRole('button',{name:'退出',exact:true}).click();await closed;report.quitMs=performance.now()-began;app=null;
  const end=performance.now()+15000;let gone=false;
  while(performance.now()<end){try{process.kill(utility,0);}catch(error){if(error.code==='ESRCH'){gone=true;break;}throw error;}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(gone,'Library process survived the actual application exit');report.utilityExited=true;
  const after=inspect(file,true);assert.equal(after.schema,72);assert.deepEqual(after.counts,before.counts);assert.equal(after.integrity,'ok');assert.equal(after.foreignKeyViolation,null);report.privateCopyAfterExit=after;
  assert.equal(JSON.parse(fs.readFileSync(path.join(scratch,'startup-exit.json'),'utf8')).phase,'closing');
  assert.ok(!/音乐库初始化失败|UnhandledPromiseRejection|uncaughtException/i.test(diagnostics),diagnostics);
  assert.equal(await hash(source),report.originalSha256);report.originalUnchanged=true;report.completed=true;
  console.log('Startup quit button, bounded actual exit, observed Library process termination, private schema72 integrity/count and unchanged original passed:',JSON.stringify({quitMs:report.quitMs,scratch}));
 }catch(error){report.error=String(error.stack||error);throw error;}
 finally {
  if(app){try{await app.close();}catch{if(app.process().exitCode===null&&Number.isSafeInteger(pid))require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});}}
  report.diagnostics=diagnostics;if(process.env.AURAL_STARTUP_EXIT_REPORT)fs.writeFileSync(path.resolve(process.env.AURAL_STARTUP_EXIT_REPORT),JSON.stringify(report,null,2)+'\n');
  // Intentionally retain this owned interrupted fixture, never delete source.
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
