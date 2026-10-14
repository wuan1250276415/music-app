const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite'),{performance}=require('node:perf_hooks');
const {LibraryDatabase}=require('../dist/main/library/database.js'),{CatalogRepository}=require('../dist/main/library/catalog.js'),{libraryStats}=require('../dist/main/library/library-stats.js');
// Frozen pre-0.189 relational query; does not call the new credit selector.
const original=`SELECT (SELECT COUNT(*) FROM library_root) roots,
 (SELECT COUNT(*) FROM playable_item p JOIN media_file f ON f.id=p.file_id WHERE p.visible=1 AND p.library_state='active' AND f.status='online') tracks,
 (SELECT COUNT(DISTINCT COALESCE(ai.identity_artist_id,c.artist_id)) FROM playable_item p JOIN artist_credit_member c ON c.credit_id=p.artist_credit_id OR c.credit_id=(SELECT rec.artist_credit_id FROM recording rec LEFT JOIN recording_profile_state rp ON rp.recording_id=rec.id WHERE rec.id=p.recording_id AND (rp.confirmed=1 OR EXISTS(SELECT 1 FROM metadata_collection_state cs WHERE cs.entity_kind='recording' AND cs.entity_id=rec.id AND cs.field='artists' AND (cs.mode IS NOT NULL OR cs.locked=1)))) LEFT JOIN artist_identity_binding ai ON ai.source_artist_id=c.artist_id WHERE p.visible=1 AND p.library_state='active' AND c.role='performer') artists,
 (SELECT COUNT(DISTINCT m.release_id) FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id WHERE p.visible=1 AND p.library_state='active') albums,
 (SELECT COUNT(*) FROM media_file WHERE status='missing') unavailable`;
async function hash(file){const h=createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
async function main(){
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-stats-mvp-')),report={appVersion:require('../package.json').version,scope:'production stats, frozen original query and independent expected memberships; optional read-only synthetic100k comparison, no physical scan or OS cold certification',comparisons:0,completed:false};let db;
 try {
  db=new LibraryDatabase(path.join(scratch,'library.db'));const root=db.addRoot(path.join(scratch,'music'));db.addRoot(path.join(scratch,'empty-root'));
  const check=(artists,tracks=2,unavailable=1)=>{const expected={roots:2,tracks,artists,albums:2,unavailable};assert.deepEqual({...db.stats()},expected);assert.deepEqual({...db.stats()},{...db.db.prepare(original).get()});report.comparisons++;};
  const seed=(title,artist,album,artists=[artist])=>{const fileId=db.upsertFile(root,{relativePath:title+'.flac',size:1024,mtimeMs:1,durationSeconds:90,codec:'FLAC',sampleRate:44100,bitsPerSample:16,title,artist,album,genre:'测试',trackNumber:1,discNumber:1,catalog:{artists,albumArtists:['专辑署名'],composers:['作曲署名']}},1);return db.db.prepare('SELECT id,file_id,artist_credit_id,recording_id FROM playable_item WHERE file_id=?').get(fileId);};
  const a=seed('一','甲','专辑A'),b=seed('二','乙','专辑A',['乙','甲']),c=seed('三','丙','专辑B'),hidden=seed('四','丁','专辑C'),removed=seed('五','戊','专辑D'),extra=seed('仅引用','己','额外专辑');
  db.db.prepare('UPDATE playable_item SET visible=0 WHERE id IN (?,?)').run(hidden.id,extra.id);db.db.prepare("UPDATE playable_item SET library_state='removed' WHERE id=?").run(removed.id);db.db.prepare("UPDATE media_file SET status='missing' WHERE id=?").run(c.file_id);check(3);
  db.db.prepare('UPDATE recording SET artist_credit_id=? WHERE id=?').run(extra.artist_credit_id,a.recording_id);check(3);
  db.db.prepare('INSERT INTO recording_profile_state(recording_id,revision,confirmed) VALUES(?,0,0)').run(a.recording_id);check(3);
  db.db.prepare('UPDATE recording_profile_state SET confirmed=1 WHERE recording_id=?').run(a.recording_id);check(4);
  report.featureModes=[];
  for(const [profiles,metadata,artists] of [[false,false,3],[false,true,3],[true,false,4],[true,true,4]]){
   const catalog=new CatalogRepository(db.db);if(profiles)catalog.enableRecordingProfiles();if(metadata)catalog.enableMetadataProvenance();
   assert.deepEqual({...libraryStats(db.db,catalog)},{roots:2,tracks:2,artists,albums:2,unavailable:1});
   report.featureModes.push({profiles,metadata,artists});
  }
  const artist=name=>db.db.prepare('SELECT id FROM artist WHERE name=? AND local_key IS NOT NULL').get(name).id;
  const canonical=randomUUID();db.db.prepare('INSERT INTO artist(id,name,normalized_name,local_key) VALUES(?,?,?,NULL)').run(canonical,'甲乙合并身份','甲乙合并身份');
  for(const name of ['甲','乙'])db.db.prepare('INSERT INTO artist_identity_binding(source_artist_id,identity_artist_id) VALUES(?,?)').run(artist(name),canonical);check(3);
  db.db.prepare('UPDATE recording_profile_state SET confirmed=0 WHERE recording_id=?').run(a.recording_id);check(2);
  db.db.prepare("INSERT INTO metadata_collection_state(entity_kind,entity_id,field,revision,locked,mode) VALUES('recording',?,'artists',1,0,NULL) ON CONFLICT(entity_kind,entity_id,field) DO UPDATE SET revision=revision+1,locked=0,mode=NULL").run(a.recording_id);check(2);
  db.db.prepare("UPDATE metadata_collection_state SET locked=1 WHERE entity_kind='recording' AND entity_id=? AND field='artists'").run(a.recording_id);check(3);
  db.db.prepare("UPDATE metadata_collection_state SET locked=0,mode='manual' WHERE entity_kind='recording' AND entity_id=? AND field='artists'").run(a.recording_id);check(3);
  db.db.prepare("UPDATE metadata_collection_state SET mode='automatic' WHERE entity_kind='recording' AND entity_id=? AND field='artists'").run(a.recording_id);check(3);
  db.db.prepare("UPDATE media_file SET status='missing' WHERE id=?").run(removed.file_id);check(3,2,2);
  db.db.prepare("UPDATE playable_item SET library_state='ignored' WHERE id=?").run(b.id);check(3,1,2);
  db.db.prepare('UPDATE playable_item SET visible=0').run();assert.deepEqual({...db.stats()},{roots:2,tracks:0,artists:0,albums:0,unavailable:2});assert.deepEqual({...db.stats()},{...db.db.prepare(original).get()});report.comparisons++;db.close();db=null;
  if(process.env.AURAL_STATS_SCALE_DB){
   const file=path.resolve(process.env.AURAL_STATS_SCALE_DB),before=await hash(file),raw=new DatabaseSync(file,{readOnly:true,allowExtension:false});
   try {
    assert.equal(Number(raw.prepare('PRAGMA user_version').get().user_version),73);assert.equal(Number(raw.prepare('SELECT COUNT(*) n FROM playable_item').get().n),100000);
    const catalog=new CatalogRepository(raw);catalog.enableRecordingProfiles();catalog.enableMetadataProvenance();
    let start=performance.now();const prior={...raw.prepare(original).get()},oldMs=performance.now()-start;start=performance.now();const current={...libraryStats(raw,catalog)},newMs=performance.now()-start;
    assert.deepEqual(current,prior);assert.equal(current.tracks,100000);report.scale={prior,current,oldMs,newMs};
   }finally{raw.close();}assert.equal(await hash(file),before);report.scale.originalUnchanged=true;
  }
  report.completed=true;console.log('Stats MVP passed:',JSON.stringify({comparisons:report.comparisons,scale:report.scale}));
 }catch(error){report.error=String(error.stack||error);throw error;}
 finally {db?.close();if(process.env.AURAL_STATS_REPORT)fs.writeFileSync(path.resolve(process.env.AURAL_STATS_REPORT),JSON.stringify(report,null,2)+'\n');if(path.dirname(scratch)===path.resolve(os.tmpdir())&&path.basename(scratch).startsWith('aural-stats-mvp-')&&fs.realpathSync(scratch)===scratch)fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
