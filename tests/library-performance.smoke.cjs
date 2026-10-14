// Production database/index/query path at scale. Synthetic catalog records;
// this benchmark does not measure physical file scanning or hardware playback.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks'),{createHash}=require('node:crypto');
const {backup}=require('node:sqlite');
const {LibraryDatabase}=require('../dist/main/library/database.js');
const {browseLibrary}=require('../dist/main/library/library-browse.js');
const {SEARCH_ALGORITHM}=require('../dist/main/library/search-text.js');
const truth=require('./fixtures/search-mvp-truth.json');
const count=Number(process.env.AURAL_BENCH_COUNT||100000),rounds=Number(process.env.AURAL_BENCH_ROUNDS||12);
assert.ok(Number.isSafeInteger(count)&&count>=1000&&count<=1000000);
assert.ok(Number.isSafeInteger(rounds)&&rounds>=3&&rounds<=100);
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const summary=values=>({samples:values.length,p50Ms:percentile(values,.5),p95Ms:percentile(values,.95),p99Ms:percentile(values,.99),maxMs:Math.max(...values)});
const corpusManifest={version:1,kind:'synthetic-catalog-v1',count,truth,fillers:{titleFamilies:['星河','远行','夏日','晚风','夜色','山水','旅途','晨光'],performerCount:500,tracksPerAlbum:20,tracksPerDisc:10,secondaryCreditEvery:7,dateYears:20,genres:['Rock','流行','Jazz','Electronic']}};
async function main(){
 const reuse=process.env.AURAL_BENCH_REUSE_DB?path.resolve(process.env.AURAL_BENCH_REUSE_DB):null;
 if(reuse){assert.match(path.basename(reuse),/^aural-benchmark-\d+\.db$/);const manifest=JSON.parse(fs.readFileSync(reuse+'.manifest.json','utf8'));assert.equal(manifest.kind,'aural-synthetic-performance-fixture-v1');assert.equal(manifest.corpusSha256,createHash('sha256').update(JSON.stringify(corpusManifest)).digest('hex'));}
 const scratch=reuse?null:fs.mkdtempSync(path.join(os.tmpdir(),'aural-library-bench-')),filename=reuse||path.join(scratch,'library.db');let db;
 const fingerprintFiles=['src/library/database.ts','src/library/library-query-plan.ts','src/library/genre-query.ts','src/library/natural-sort.ts','src/library/search-spelling.ts','src/library/query-index-migration.ts','dist/main/library/library-query-plan.js','dist/main/library/search-spelling.js'];
 const report={version:1,appVersion:require('../package.json').version,algorithm:SEARCH_ALGORITHM,completed:false,sourceFingerprint:Object.fromEntries(fingerprintFiles.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(__dirname,'..',file))).digest('hex')])),scope:'production database ingestion and query; synthetic catalog, no physical media scan, Electron IPC/UI or cold OS cache',corpus:corpusManifest,corpusSha256:createHash('sha256').update(JSON.stringify(corpusManifest)).digest('hex'),environment:{platform:process.platform,release:os.release(),arch:process.arch,cpu:os.cpus()[0]?.model,cpuCount:os.cpus().length,memoryBytes:os.totalmem(),node:process.version,sqlite:process.versions.sqlite},rounds,measurements:[],correctness:[],budgets:{regularCoreP95Ms:200,complexFuzzyCoreP95Ms:500},budgetFailures:[]};
 const save=()=>{if(process.env.AURAL_BENCH_REPORT)fs.writeFileSync(path.resolve(process.env.AURAL_BENCH_REPORT),JSON.stringify(report,null,2)+'\n');};
 try{
  const opened=performance.now();db=new LibraryDatabase(filename);report.emptyInitializationMs=performance.now()-opened;report.schemaAfterOpen=Number(db.db.prepare('PRAGMA user_version').get().user_version);
  if(!reuse){
  const root=db.addRoot(path.join(scratch,'catalog-source'));fs.mkdirSync(path.join(scratch,'catalog-source'));
  const base={size:4096,mtimeMs:1,durationSeconds:180,codec:'FLAC',sampleRate:44100,bitsPerSample:24,trackNumber:1,discNumber:1};
  const ingestStart=performance.now();
  for(const track of truth.tracks)db.upsertFile(root,{...base,relativePath:`truth/${track.key}.flac`,title:track.title,artist:track.artist,album:track.album,genre:track.genre,catalog:{artists:[track.artist],albumArtists:[track.artist],genres:[track.genre]}},1);
  const families=corpusManifest.fillers.titleFamilies,genres=corpusManifest.fillers.genres;
  for(let start=0;start<count-truth.tracks.length;start+=100){
   db.db.exec('BEGIN IMMEDIATE');try{
    for(let i=start;i<Math.min(count-truth.tracks.length,start+100);i++){
     const album=Math.floor(i/20),artist=i%500===0?'周杰伦':`目录艺人 ${i%500}`,title=`${families[i%families.length]} ${String(i).padStart(6,'0')}`;
     db.upsertFile(root,{...base,relativePath:`filler/album-${album}/${i}.flac`,title,artist,album:`资料专辑 ${album}`,genre:genres[i%4],discNumber:1+Math.floor((i%20)/10),trackNumber:1+i%10,catalog:{artists:i%7===0?[artist,'合作者']: [artist],albumArtists:[`专辑艺人 ${album%500}`],genres:[genres[i%4]],date:String(2000+album%20)}},1);
    }
    db.db.exec('COMMIT');
   }catch(error){db.db.exec('ROLLBACK');throw error;}
   if((start+100)%1000===0||start+100>=count-truth.tracks.length){report.ingested=Math.min(count,start+100+truth.tracks.length);save();console.log(`Catalog ingested ${report.ingested}/${count}; ${Math.round(performance.now()-ingestStart)} ms`);await new Promise(resolve=>setImmediate(resolve));}
  }
  report.ingestionMs=performance.now()-ingestStart;
  }else{report.reusedSyntheticFixture=path.basename(reuse);report.ingestionMs=null;}
  let state=db.searchIndex.state();while(state.status==='building')state=db.searchIndex.step();assert.equal(state.status,'ready',JSON.stringify(state));
  assert.equal(db.db.prepare('PRAGMA foreign_key_check').get(),undefined);
  assert.equal(db.db.prepare('SELECT COUNT(*) count FROM playable_item').get().count,count);
  if(process.env.AURAL_BENCH_EXPORT_DB){const target=path.resolve(process.env.AURAL_BENCH_EXPORT_DB);assert.equal(path.basename(target),`aural-benchmark-${count}.db`);assert.ok(!fs.existsSync(target),'Refuse to overwrite an existing benchmark fixture');await backup(db.db,target);fs.writeFileSync(target+'.manifest.json',JSON.stringify({kind:'aural-synthetic-performance-fixture-v1',corpus:corpusManifest,corpusSha256:report.corpusSha256},null,2)+'\n');report.exportedSyntheticFixture=path.basename(target);save();console.log('Consistent synthetic fixture exported:',path.basename(target));}
  report.databaseBytes=fs.statSync(filename).size;report.databaseWalBytes=fs.existsSync(filename+'-wal')?fs.statSync(filename+'-wal').size:0;
  const hydrate=db.getItems.bind(db),hydrationSizes=[];db.getItems=ids=>{hydrationSizes.push(ids.length);assert.ok(ids.length<=100,'A browse page hydrated more than the page limit');return hydrate(ids);};
  const first=browseLibrary(db,{query:{view:'all'},offset:0});assert.equal(first.total,count);assert.equal(first.items.length,100);
  const last=browseLibrary(db,{query:{view:'all'},offset:Math.floor((count-100)/100)*100,snapshot:first.snapshot});assert.equal(last.status,'ready');assert.equal(last.total,count);assert.equal(last.items.length,100);
  assert.deepEqual(hydrationSizes,[100,100]);report.pageHydrationSizes=hydrationSizes.slice();db.getItems=hydrate;
  const representative=db.db.prepare("SELECT p.id FROM playable_item p JOIN media_file f ON f.id=p.file_id WHERE f.relative_path='filler/album-0/0.flac'").get();assert.ok(representative);const sample=db.getItem(representative.id);assert.deepEqual(sample.catalog.artists.filter(member=>member.role==='performer').map(member=>member.name),['周杰伦','合作者']);
  const album=db.list({view:'albums',facetId:sample.catalog.releaseId,limit:100});assert.equal(album.total,20);assert.deepEqual(album.items.map(item=>[item.discNumber,item.trackNumber]),Array.from({length:20},(_,i)=>[1+Math.floor(i/10),1+i%10]));report.correctness.push('multi-artist credit and two-disc album ordering in scaled corpus');
  assert.equal(new Set([...first.items,...last.items].map(item=>item.id)).size,200);report.correctness.push('catalog-size total and bounded distinct first/deep snapshot pages');save();console.log('Bounded first/deep browse pages checked');
  for(const test of truth.cases){const {name,expected,first:expectedFirst,...request}=test,start=performance.now();console.log('Checking truth:',name);const response=db.list({view:'all',limit:100,...request});console.log('Truth checked:',name,Math.round(performance.now()-start),'ms');
   // Filler artists deliberately share 周杰伦, while all unique truth items must remain searchable.
   const actual=response.items.filter(item=>item.path.includes(path.sep+'truth'+path.sep)).map(item=>path.basename(item.path,'.flac'));
   if(!['周','周杰','zhoujielun','zhou jie lun','zjl'].includes(request.query))assert.deepEqual([...actual].sort(),[...expected].sort(),name);
   else assert.ok(response.total>=expected.length,name);
   if(expectedFirst)assert.equal(path.basename(response.items[0].path,'.flac'),expectedFirst,name);
  }
  report.correctness.push('truth query identities and precise ranking within large catalog');
  const requests=[
   {name:'browse-first',request:{view:'all'}},
   {name:'browse-deep',request:{view:'all',offset:count-100}},
   {name:'title-exact',request:{view:'all',query:'夜曲'},budget:'regular'},
   {name:'traditional-title',request:{view:'all',query:'后来'},budget:'regular'},
   {name:'short-Han-rare',request:{view:'all',query:'周'},budget:'short-large'},
   {name:'short-Han-broad',request:{view:'all',query:'辑'},budget:'short-large'},
   {name:'pinyin-full',request:{view:'all',query:'zhoujielun'},budget:'regular'},
   {name:'pinyin-initials-short',request:{view:'all',query:'zjl'},budget:'regular'},
   {name:'English-accent',request:{view:'all',query:'beyonce'},budget:'regular'},
   {name:'English-transposition',request:{view:'all',query:'rhpasody'},budget:'fuzzy'},
   {name:'genre-fuzzy-scope',request:{view:'genres',value:'Rock',query:'rhpasody'},budget:'fuzzy'},
   {name:'regular-filter',request:{view:'genres',value:'Rock',query:'星河'},budget:'regular'},
  ];
  for(const entry of requests){const run=()=>db.list({...entry.request,limit:100});const coldStart=performance.now(),cold=run(),firstCallMs=performance.now()-coldStart;const values=[];
   for(let i=0;i<rounds;i++){const start=performance.now(),response=run();values.push(performance.now()-start);assert.equal(response.total,cold.total);assert.ok(response.items.length<=100);}
   const metric={name:entry.name,request:entry.request,total:cold.total,firstCallMs,...summary(values),cache:'warm production indexes; first call not OS cold cache'};report.measurements.push(metric);
   const budget=entry.budget==='regular'?200:entry.budget==='fuzzy'?500:null;if(budget&&metric.p95Ms>budget)report.budgetFailures.push({name:entry.name,p95Ms:metric.p95Ms,budgetMs:budget});
   save();console.log(JSON.stringify(metric));await new Promise(resolve=>setImmediate(resolve));
  }
  db.close();db=null;const reopen=performance.now();db=new LibraryDatabase(filename);report.databaseReopenMs=performance.now()-reopen;assert.equal(db.list({view:'all',query:'夜曲'}).items[0].title,'夜曲');report.correctness.push('database reopened with derived index and catalog');report.processMemory=process.memoryUsage();
  report.correctnessComplete=true;save();console.log('Performance report:',JSON.stringify({count,rounds,ingestionMs:report.ingestionMs,databaseReopenMs:report.databaseReopenMs,budgetFailures:report.budgetFailures}));
  assert.equal(report.budgetFailures.length,0,'Architecture core search budgets exceeded; see report');
  report.completed=true;save();
 }catch(error){report.error=String(error.stack||error);save();throw error;}
 finally{db?.close();if(scratch&&path.dirname(scratch)===path.resolve(os.tmpdir())&&path.basename(scratch).startsWith('aural-library-bench-'))fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
