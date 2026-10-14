const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {LibraryDatabase}=require('../dist/main/library/database.js');
const {scanRoot}=require('../dist/main/library/scanner.js');
const {PlaybackQueue}=require('../dist/main/main/queue.js');

function makeWav(filename){
  const frames=44100,pcm=Buffer.alloc(frames*2),header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
  header.writeUInt32LE(44100,24);header.writeUInt32LE(88200,28);
  header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);
  header.writeUInt32LE(pcm.length,40);fs.writeFileSync(filename,Buffer.concat([header,pcm]));
}
const cue=frame=>`TITLE "同名专辑"\nPERFORMER "艺人甲"\nFILE "disc.wav" WAVE\n TRACK 01 AUDIO\n TITLE "第一段"\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n TITLE "第二段"\n INDEX 01 00:00:${String(frame).padStart(2,'0')}`;

test('v3 library migrates to stream/span v4 with backup and preserves queue, CUE IDs, edits',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'aural-schema-v4-'));
  const music=path.join(folder,'music');fs.mkdirSync(music);
  const filename=path.join(folder,'library.db');
  makeWav(path.join(music,'disc.wav'));
  fs.writeFileSync(path.join(music,'disc.cue'),cue(30),'utf8');
  let db,raw;
  t.after(()=>{
    raw?.close();db?.close();
    const safe=path.resolve(os.tmpdir())+path.sep;
    assert.ok(path.resolve(folder).startsWith(safe));
    fs.rmSync(folder,{recursive:true,force:true});
  });
  db=new LibraryDatabase(filename);
  const root=db.addRoot(music);
  await scanRoot(db,root,()=>{});
  const items=db.list({view:'all'}).items;
  assert.equal(items.length,2);
  const firstId=items[0].id,secondId=items[1].id;
  db.applyMetadata(firstId,0,{provider:'musicbrainz',recordingId:'12345678-1234-1234-1234-123456789abc',
    releaseId:null,title:'用户确认标题',artist:'艺人甲',album:null},['title']);
  const queue=new PlaybackQueue();queue.start(firstId,[firstId,secondId]);
  db.saveQueue(queue.snapshot(),0);
  db.close();db=null;

  // Reconstruct a real v3-shaped database from data produced by the prior schema.
  raw=new DatabaseSync(filename);
  require('./legacy-schema.cjs').stripV5(raw);
  raw.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; DROP TABLE playable_span; DROP TABLE media_stream; PRAGMA user_version=3; COMMIT;');
  raw.close();raw=null;

  db=new LibraryDatabase(filename);
  assert.equal(db.getItem(firstId).title,'用户确认标题');
  assert.deepEqual(db.list({view:'all'}).items.map(item=>item.id),[firstId,secondId]);
  assert.deepEqual(db.loadQueue(),queue.snapshot());
  raw=new DatabaseSync(filename);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version,68);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(raw.prepare('SELECT COUNT(*) count FROM media_stream').get().count,1);
  const spans=raw.prepare(`SELECT p.id,p.kind,s.start_tick,s.end_tick,s.time_base_den
    FROM playable_item p JOIN playable_span s ON s.item_id=p.id ORDER BY p.kind,p.id`).all();
  assert.equal(spans.length,3); // two visible CUE tracks and the hidden whole-file item
  assert.deepEqual(spans.filter(row=>row.kind==='cue').map(row=>[row.start_tick,row.end_tick,row.time_base_den]),
    [[0,30,75],[30,null,75]]);
  assert.deepEqual(spans.filter(row=>row.kind==='file').map(row=>[row.start_tick,row.end_tick,row.time_base_den]),
    [[0,null,1]]);
  assert.throws(()=>raw.prepare(`INSERT INTO playable_span(item_id,ordinal,stream_id,start_tick,end_tick,time_base_num,time_base_den)
    SELECT ?,1,id,30,30,1,75 FROM media_stream LIMIT 1`).run(firstId),/CHECK constraint failed/);
  raw.close();raw=null;

  fs.writeFileSync(path.join(music,'disc.cue'),cue(45),'utf8');
  await scanRoot(db,root,()=>{});
  assert.deepEqual(db.list({view:'all'}).items.map(item=>item.id),[firstId,secondId]);
  assert.equal(db.getItem(firstId).title,'用户确认标题');
  assert.deepEqual(db.loadQueue(),queue.snapshot());
  raw=new DatabaseSync(filename);
  const rescanned=raw.prepare(`SELECT p.id,s.start_tick,s.end_tick FROM playable_item p
    JOIN playable_span s ON s.item_id=p.id WHERE p.kind='cue' ORDER BY p.id`).all();
  assert.deepEqual(rescanned.map(row=>[row.start_tick,row.end_tick]),[[0,45],[45,null]]);
  raw.close();raw=null;

  const backups=fs.readdirSync(folder).filter(name=>name.includes('.pre-v4-')&&name.endsWith('.bak'));
  assert.equal(backups.length,1);
  raw=new DatabaseSync(path.join(folder,backups[0]));
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version,3);
  assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(raw.prepare('SELECT name FROM sqlite_master WHERE name=?').get('playable_span'),undefined);
  raw.close();raw=null;
});

test('invalid v3 CUE interval rolls back v4 migration and keeps a v3 backup',t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'aural-schema-v4-invalid-'));
  const filename=path.join(folder,'library.db');
  t.after(()=>{
    const safe=path.resolve(os.tmpdir())+path.sep;
    assert.ok(path.resolve(folder).startsWith(safe));
    fs.rmSync(folder,{recursive:true,force:true});
  });
  const old=new DatabaseSync(filename);
  old.exec(`CREATE TABLE media_file(id TEXT PRIMARY KEY,codec TEXT NOT NULL,sample_rate INTEGER,bits_per_sample INTEGER);
    CREATE TABLE playable_item(id TEXT PRIMARY KEY,file_id TEXT NOT NULL,kind TEXT,start_cue_frame INTEGER,end_cue_frame INTEGER);
    PRAGMA user_version=3;`);
  old.prepare('INSERT INTO media_file VALUES(?,?,?,?)').run('file','WAV',44100,16);
  old.prepare('INSERT INTO playable_item VALUES(?,?,?,?,?)').run('bad','file','cue',100,50);
  old.close();
  assert.throws(()=>new LibraryDatabase(filename),/CHECK constraint failed/);
  const after=new DatabaseSync(filename);
  assert.equal(after.prepare('PRAGMA user_version').get().user_version,3);
  assert.equal(after.prepare('SELECT name FROM sqlite_master WHERE name=?').get('playable_span'),undefined);
  assert.equal(after.prepare('SELECT start_cue_frame,end_cue_frame FROM playable_item').get().start_cue_frame,100);
  after.close();
  const backups=fs.readdirSync(folder).filter(name=>name.includes('.pre-v4-')&&name.endsWith('.bak'));
  assert.equal(backups.length,1);
  const backup=new DatabaseSync(path.join(folder,backups[0]));
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version,3);
  backup.close();
});

test('multi-file CUE spans point to their own media streams',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'aural-schema-v4-multifile-'));
  const music=path.join(folder,'music');fs.mkdirSync(music);
  makeWav(path.join(music,'a.wav'));makeWav(path.join(music,'b.wav'));
  fs.writeFileSync(path.join(music,'album.cue'),`TITLE "双文件"\nFILE "a.wav" WAVE\n TRACK 01 AUDIO\n TITLE "甲"\n INDEX 01 00:00:00\nFILE "b.wav" WAVE\n TRACK 02 AUDIO\n TITLE "乙"\n INDEX 01 00:00:00`,'utf8');
  const filename=path.join(folder,'library.db');
  const db=new LibraryDatabase(filename);
  t.after(()=>{
    db.close();const safe=path.resolve(os.tmpdir())+path.sep;
    assert.ok(path.resolve(folder).startsWith(safe));fs.rmSync(folder,{recursive:true,force:true});
  });
  await scanRoot(db,db.addRoot(music),()=>{});
  const items=db.list({view:'all'}).items;
  assert.deepEqual(items.map(item=>item.title),['甲','乙']);
  const raw=new DatabaseSync(filename);
  try{
    const rows=raw.prepare(`SELECT p.id,p.file_id,s.stream_id,m.file_id stream_file_id,f.relative_path
      FROM playable_item p JOIN playable_span s ON s.item_id=p.id
      JOIN media_stream m ON m.id=s.stream_id JOIN media_file f ON f.id=m.file_id
      WHERE p.kind='cue' ORDER BY p.id`).all();
    assert.deepEqual(rows.map(row=>row.relative_path),['a.wav','b.wav']);
    assert.ok(rows.every(row=>row.file_id===row.stream_file_id));
  }finally{raw.close();}
});


