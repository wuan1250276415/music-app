const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {parseCue}=require('../dist/main/library/cue.js');
const {LibraryDatabase}=require('../dist/main/library/database.js');

test('CUE keeps absolute 75 fps positions as integers',()=>{
  const cue=parseCue('FILE "disc.wav" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:00:01\n TRACK 02 AUDIO\n INDEX 00 01:02:02\n INDEX 01 01:02:03');
  assert.equal(cue.entries[0].index01Frame,1);
  assert.equal(cue.entries[0].endFrame,4653);
  assert.equal(cue.entries[1].index00Frame,4652);
  assert.equal(cue.entries[1].index01Frame,4653);
  assert.equal(cue.warnings.length,0);
  const invalid=parseCue('FILE "disc.wav" WAVE\n TRACK 01 AUDIO\n INDEX 00 00:00:02\n INDEX 01 00:00:01');
  assert.equal(invalid.entries.length,0);
  assert.match(invalid.warnings.join(' '),/INDEX 00 晚于 INDEX 01/);
});

test('v2 CUE seconds migrate to integer frames with a recoverable backup',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aural-cue-v3-'));
  const file=path.join(directory,'library.db');
  try{
    const seed=new LibraryDatabase(file),root=seed.addRoot(path.join(directory,'music'));
    const source=seed.upsertFile(root,{relativePath:'disc.wav',size:1,mtimeMs:1,title:'Disc',artist:'Artist',album:'Album',genre:'',
      durationSeconds:3,codec:'WAV',sampleRate:44100,bitsPerSample:16,trackNumber:1,discNumber:1},1);
    seed.applyCue(root,'disc.cue','Album','Artist',[{fileId:source,file:'disc.wav',number:1,title:'Track',performer:'Artist',index01Frame:1,endFrame:150}],[],1);
    const itemId=seed.list({view:'all'}).items[0].id;seed.close();
    const old=new DatabaseSync(file);
    require('./legacy-schema.cjs').stripV5(old);
    old.exec(`BEGIN IMMEDIATE; DROP TABLE playable_span; DROP TABLE media_stream;
      ALTER TABLE playable_item DROP COLUMN start_cue_frame; ALTER TABLE playable_item DROP COLUMN end_cue_frame;
      PRAGMA user_version=2; COMMIT;`);
    old.close();

    const migrated=new LibraryDatabase(file);
    migrated.close();
    const current=new DatabaseSync(file);
    assert.equal(current.prepare('PRAGMA user_version').get().user_version,68);
    const row=current.prepare('SELECT start_cue_frame,end_cue_frame FROM playable_item WHERE id=?').get(itemId);
    assert.equal(row.start_cue_frame,1);
    assert.equal(row.end_cue_frame,150);
    const span=current.prepare('SELECT start_tick,end_tick,time_base_num,time_base_den FROM playable_span WHERE item_id=?').get(itemId);
    assert.deepEqual({...span},{start_tick:1,end_tick:150,time_base_num:1,time_base_den:75});
    current.close();

    const backups=fs.readdirSync(directory).filter(name=>name.includes('.pre-v3-')&&name.endsWith('.bak'));
    assert.equal(backups.length,1);
    const backup=new DatabaseSync(path.join(directory,backups[0]));
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version,2);
    assert.equal(backup.prepare('SELECT start_seconds FROM playable_item WHERE id=?').get(itemId).start_seconds,1/75);
    backup.close();
    const v4Backups=fs.readdirSync(directory).filter(name=>name.includes('.pre-v4-')&&name.endsWith('.bak'));
    assert.equal(v4Backups.length,1);
    const beforeV4=new DatabaseSync(path.join(directory,v4Backups[0]));
    assert.equal(beforeV4.prepare('PRAGMA user_version').get().user_version,3);
    beforeV4.close();
  }finally{
    for(const name of fs.readdirSync(directory))fs.unlinkSync(path.join(directory,name));
    fs.rmdirSync(directory);
  }
});


