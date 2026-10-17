const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto');
const {LibraryDatabase}=require('../dist/main/library/database.js'),{scanRoot}=require('../dist/main/library/scanner.js'),{WaveformManager}=require('../dist/main/library/waveforms.js');
const {fingerprintSourceIdentity,FINGERPRINT_RECIPE,validAudioFingerprint}=require('../dist/main/shared/audio-fingerprint.js'),{PCM_ANALYSIS_REVISION}=require('../dist/main/shared/pcm-analysis-revision.js'),{readRecognitionMapping}=require('../dist/main/shared/recognition-mapping.js'),{validateRecognitionMappings}=require('../dist/main/library/recognition-mapping.js');
const hash=value=>createHash('sha256').update(value).digest('hex'),algorithm='minmax-f32-v4-sample-span-ma-0.11.25-ff-8.1.3-dsdpcm-v1';
async function main(){
 const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-analysis-cache-')),music=path.join(scratch,'music'),filename=path.join(scratch,'library.db'),report={version:require('../package.json').version,completed:false,scope:'actual scanner/SQLite and native waveform workers across restart; constructed valid historical cache namespace and ID-only mapping, not a historical executable upgrade or provider matching truth test',cases:[],scratch,revision:PCM_ANALYSIS_REVISION};let db,manager;
 fs.mkdirSync(music);const names=['flac-48000-24.flac','mp3-mp3-48000.mp3','aac-m4a-48000.m4a'];for(const name of names)fs.copyFileSync(path.join(root,'tests/fixtures/decoder-gold',name),path.join(music,name));
 const original=Object.fromEntries(names.map(n=>[n,hash(fs.readFileSync(path.join(music,n)))]));
 const worker=()=>new WaveformManager(db.waveforms,path.join(root,'native/audio-host/build/waveform-worker.exe'),id=>db.waveformSource(id),id=>db.itemFileId(id));
 async function analyze(item){const id=randomUUID();manager.request(item.id,id);const end=Date.now()+30000;while(Date.now()<end){const result=manager.view(id);if(['completed','failed','cancelled','interrupted'].includes(result.status)){assert.equal(result.status,'completed',result.message);return result;}await new Promise(resolve=>setTimeout(resolve,15));}throw new Error('waveform native job timeout');}
 try{
  db=new LibraryDatabase(filename);await scanRoot(db,db.addRoot(music),()=>{});const items=db.list({view:'all',limit:20}).items;assert.equal(items.length,3);const histories=[];
  for(const item of items){
   const sha=original[path.basename(item.path)],backend=item.path.endsWith('.m4a')?'ffmpeg-8.1.3':'miniaudio',codec=item.path.endsWith('.m4a')?'aac':item.path.endsWith('.flac')?'flac':'mp3';
   const summary={version:1,algorithm,sha256:sha,sampleRate:48000,channels:2,decoder:{backend,codec,certification:'pending'},startFrame:'0',endFrame:'156000',durationSeconds:3.25,peakDb:0,rmsDb:-96,invalidSamples:'0',levels:[{points:512,values:Array.from({length:512},()=>[0,0])}]};
   const oldFingerprint=hash(JSON.stringify([algorithm,item.fileId,item.path,item.kind,item.sourceStartCueFrame,item.sourceEndCueFrame,item.sourceStartSeconds,item.sourceEndSeconds,item.sourceSampleRange??null])),cacheId=hash(JSON.stringify([algorithm,sha,48000,2,'0','156000'])),id=randomUUID(),payload=JSON.stringify(summary),created=Date.now()-86400000;
   db.db.prepare('INSERT INTO waveform_cache VALUES(?,?,?,?,?)').run(cacheId,sha,payload,Buffer.byteLength(payload),created);
   db.db.prepare('INSERT INTO waveform_reference VALUES(?,?)').run(oldFingerprint,cacheId);
   db.db.prepare("INSERT INTO waveform_job(id,item_id,fingerprint,status,phase,progress,cache_id,cached,created_at,updated_at) VALUES(?,?,?,'completed','done',1,?,1,?,?)").run(id,item.id,oldFingerprint,cacheId,created,created);
   assert.deepEqual(db.waveforms.view(id).summary,summary);histories.push({id,itemId:item.id,cacheId,payload,oldFingerprint});
   const previous=[FINGERPRINT_RECIPE,item.id,item.fileId,item.path,item.kind,item.fileObservation??null,item.sourceSampleRange??null,item.sourceStartCueFrame,item.sourceEndCueFrame,item.sourceStartSeconds,item.sourceEndSeconds],current=fingerprintSourceIdentity(item);
   assert.notEqual(hash(JSON.stringify(previous)),hash(JSON.stringify(current)));assert.equal(current[0],PCM_ANALYSIS_REVISION);
  }
  manager=worker();report.results=[];
  for(const item of items){
   const result=await analyze(item),history=histories.find(h=>h.itemId===item.id);assert.equal(result.cached,false);assert.equal(result.summary.sha256,original[path.basename(item.path)]);assert.notEqual(JSON.stringify(result.summary),history.payload);assert.equal(result.summary.endFrame,'156000');
   const row=db.waveforms.row(result.id);assert.notEqual(row.fingerprint,history.oldFingerprint);assert.notEqual(row.cache_id,history.cacheId);assert.equal(db.db.prepare('SELECT payload_json FROM waveform_cache WHERE id=?').get(history.cacheId).payload_json,history.payload);
   const second=await analyze(item);assert.equal(second.cached,true);assert.deepEqual(second.summary,result.summary);report.results.push({name:path.basename(item.path),firstCached:result.cached,secondCached:second.cached,sourceSha256:result.summary.sha256,newJobId:result.id});
  }
  report.cases.push('FLAC/MP3/AAC native analyses ignore valid hash-matching legacy caches, create distinct cache IDs, and reuse only the new namespace');
  report.cases.push('historical waveform jobs retain original payload bytes instead of being overwritten or rejected by a new analysis recipe');
  const first=items[0],legacySource=hash(JSON.stringify(fingerprintSourceIdentity(first).slice(1))),summary={version:1,algorithm:FINGERPRINT_RECIPE,libraryVersion:'1.6.1',algorithmId:1,sampleRate:48000,channels:2,startFrame:'0',endFrame:'156000',sampledFrames:'156000',durationSeconds:3.25,sampledSeconds:3.25,rangeKind:'file',decoder:{backend:'miniaudio',codec:'flac'}};
  const mapping=readRecognitionMapping({version:1,source:legacySource,authority:'a'.repeat(64),metadata:'b'.repeat(64),fetchedAt:new Date().toISOString(),summary,mappings:[]});
  assert.equal(mapping.source,legacySource);assert.ok(validAudioFingerprint({...mapping.summary,fingerprint:'descriptor',sha256:'0'.repeat(64),rawWords:1}));assert.notEqual(mapping.source,hash(JSON.stringify(fingerprintSourceIdentity(first))));validateRecognitionMappings(db.db,()=>{});
  report.cases.push('historical ID-only recognition descriptor remains readable while its old source digest no longer matches current review authority');
  await manager.beginMaintenance('cache-restart');manager=null;db.close();db=new LibraryDatabase(filename);manager=worker();
  for(const item of items){const result=await analyze(db.getItem(item.id));assert.equal(result.cached,true);const old=histories.find(h=>h.itemId===item.id);assert.equal(JSON.stringify(db.waveforms.view(old.id).summary),old.payload);}
  report.cases.push('actual database reopen reuses new native-verified cache and preserves all three legacy historical results');
  for(const name of names)assert.equal(hash(fs.readFileSync(path.join(music,name))),original[name]);assert.equal(db.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);
  report.cases.push('owned physical media remains byte-identical and SQLite integrity/foreign keys pass');report.sourceMediaUnchanged=true;report.devicesOpened=0;
  report.fingerprints=Object.fromEntries(['src/shared/pcm-analysis-revision.ts','src/shared/audio-fingerprint.ts','src/library/waveforms.ts','src/library/audio-fingerprint.ts','src/library/service.ts','tests/analysis-cache-mvp.smoke.cjs','native/audio-host/build/waveform-worker.exe'].map(n=>[n,hash(fs.readFileSync(path.join(root,n)))]));report.completed=true;
 }finally{await manager?.beginMaintenance('cache-close');db?.close();if(process.env.AURAL_ANALYSIS_CACHE_REPORT)fs.writeFileSync(process.env.AURAL_ANALYSIS_CACHE_REPORT,JSON.stringify(report,null,2));console.log(JSON.stringify({completed:report.completed,cases:report.cases.length,scratch}));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
