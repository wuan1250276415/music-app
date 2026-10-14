const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {LibraryDatabase}=require('../dist/main/library/database.js');
const {scanRoot}=require('../dist/main/library/scanner.js');
const {PlaybackQueue}=require('../dist/main/main/queue.js');

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aural-catalog-')),filename=path.join(dir,'library.db');
  const f={dir,filename,db:new LibraryDatabase(filename)};
  f.root=f.db.addRoot(path.join(dir,'music'));
  t.after(()=>{f.db?.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});
  return f;
}
function file(f,relativePath,change={}){
  return f.db.upsertFile(f.root,{relativePath,size:1,mtimeMs:1,title:'作品',artist:'甲 feat. 乙',album:'同名专辑',genre:'Jazz',durationSeconds:60,
    codec:'FLAC',sampleRate:44100,bitsPerSample:16,trackNumber:1,discNumber:1,...change},1);
}

test('ordered multi-artist credits, exact slash names, roles and all genres drive facets and search',t=>{
  const f=fixture(t);
  file(f,'album/song.flac',{catalog:{artists:['甲','乙','AC/DC'],albumArtist:'合集艺人',albumArtists:['合集艺人'],
    composers:['作曲家'],conductors:['指挥家'],orchestras:['乐团'],genres:['Jazz','jazz','电子']}});
  const item=f.db.list({view:'all'}).items[0],c=item.catalog;
  assert.equal(item.artist,'甲 feat. 乙');
  assert.deepEqual(c.artists.filter(m=>m.role==='performer').map(m=>[m.name,m.ordinal,m.joinPhrase]),[['甲',0,null],['乙',1,null],['AC/DC',2,null]]);
  assert.deepEqual(c.albumArtists.map(m=>m.name),['合集艺人']);
  assert.deepEqual(c.genres.map(g=>g.name).sort(),['Jazz','电子']);
  const beta=f.db.facets('artists').find(a=>a.name==='乙');
  assert.equal(f.db.list({view:'artists',facetId:beta.id}).items[0].id,item.id);
  assert.equal(f.db.list({view:'all',query:'电子'}).total,1);
  assert.equal(f.db.list({view:'all',query:'AC/DC'}).total,1);
  assert.equal(f.db.list({view:'all',query:'合集艺人'}).total,1);
  assert.equal(f.db.list({view:'all',query:'指挥家'}).total,1);
  for(const role of ['album_artist','composer','conductor','orchestra']){
    const artist=f.db.facets('artists',role)[0];
    assert.equal(f.db.list({view:'artists',facetId:artist.id,artistRole:role}).total,1);
    assert.equal(f.db.list({view:'artists',facetId:artist.id,artistRole:'performer'}).total,0);
  }
  assert.throws(()=>f.db.facets('artists','invented'),/无效艺人角色/);
  const raw=new DatabaseSync(f.filename);
  const custom=randomUUID();raw.prepare('INSERT INTO genre(id,name,normalized_name) VALUES(?,?,?)').run(custom,'私人分类','私人分类');
  raw.prepare('INSERT INTO item_genre(item_id,genre_id,source) VALUES(?,?,?)').run(item.id,custom,'user');raw.close();
  file(f,'album/song.flac',{catalog:{artists:['甲','乙'],genres:['Rock']}});
  assert.deepEqual(f.db.getItem(item.id).catalog.genres.map(g=>g.name).sort(),['Rock','私人分类']);
  assert.equal(f.db.getItem(item.id).catalog.recordingId,c.recordingId);
  assert.equal(f.db.getItem(item.id).catalog.releaseTrackId,c.releaseTrackId);
});

test('same titles, different folders, album artists, dates and editions are distinct local release candidates',t=>{
  const f=fixture(t);
  file(f,'original/one.flac',{catalog:{albumArtist:'甲',date:'1999',edition:'Original'}});
  file(f,'remaster/one.flac',{catalog:{albumArtist:'甲',date:'2020-05',edition:'Remaster'}});
  file(f,'original/two.flac',{catalog:{albumArtist:'乙',date:'1999',edition:'Original'}});
  const items=f.db.list({view:'all'}).items;
  assert.equal(f.db.stats().albums,3);
  assert.equal(new Set(items.map(item=>item.catalog.recordingId)).size,3);
  const facets=f.db.facets('albums');assert.equal(facets.length,3);
  assert.ok(facets.some(a=>a.subtitle.includes('2020-05')));
  for(const release of facets)assert.equal(f.db.list({view:'albums',facetId:release.id}).total,1);
  const before=items.find(i=>i.path.endsWith(path.join('original','one.flac')));
  const recordingId=randomUUID(),releaseId=randomUUID();
  const change=f.db.applyMetadata(before.id,0,{provider:'musicbrainz',recordingId,releaseId,title:'作品',artist:'确认艺人',album:'另一个专辑',sourceUrl:`https://musicbrainz.org/recording/${recordingId}`,fetchedAt:new Date().toISOString()},['artist','album']);
  assert.notEqual(f.db.getItem(before.id).catalog.releaseId,before.catalog.releaseId);
  assert.equal(f.db.getItem(before.id).catalog.artists[0].name,'确认艺人');
  f.db.undoMetadata(change.changeId);
  assert.equal(f.db.getItem(before.id).catalog.releaseId,before.catalog.releaseId);
  assert.equal(f.db.getItem(before.id).catalog.recordingId,before.catalog.recordingId);
  const raw=new DatabaseSync(f.filename);assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);raw.close();
});

test('explicit numbered disc folders share a release while unnumbered folders and unknown albums stay separate',t=>{
  const f=fixture(t),tags={albumArtist:'多碟艺人',albumArtists:['多碟艺人'],date:'2005'};
  file(f,'box/CD2/one.flac',{title:'碟二',discNumber:2,catalog:tags});
  file(f,'box/CD1/one.flac',{title:'碟一',discNumber:1,catalog:tags});
  const items=f.db.list({view:'all'}).items;
  assert.equal(items[0].title,'碟一');assert.equal(items[1].title,'碟二');
  assert.equal(items[0].catalog.releaseId,items[1].catalog.releaseId);
  assert.equal(f.db.list({view:'albums',facetId:items[0].catalog.releaseId}).total,2);
  file(f,'box/CD3/one.flac',{discNumber:null,catalog:tags});
  file(f,'loose/a.flac',{album:'未知专辑'});file(f,'loose/b.flac',{album:'未知专辑'});
  assert.equal(f.db.stats().albums,4);
  const raw=new DatabaseSync(f.filename);
  assert.throws(()=>raw.prepare('INSERT INTO medium(id,release_id,disc_no) VALUES(?,?,?)').run(randomUUID(),items[0].catalog.releaseId,1),/UNIQUE/);
  assert.throws(()=>raw.prepare('UPDATE playable_item SET recording_id=? WHERE id=?').run('nonexistent',items[0].id),/FOREIGN KEY/);
  raw.close();
});

test('v5 migration keeps user references, creates a recoverable backup, and schedules unchanged files for full tag rescan',async t=>{
  const f=fixture(t),music=path.join(f.dir,'music');fs.mkdirSync(music);
  fs.copyFileSync(path.join(__dirname,'fixtures','embedded-cover.mp3'),path.join(music,'song.mp3'));
  await scanRoot(f.db,f.root,()=>{});
  const item=f.db.list({view:'all'}).items[0];
  f.db.user.setState({itemId:item.id,favorite:true,rating:5,baseRevision:0,commandId:randomUUID()});
  const playlist=f.db.user.create('迁移歌单',randomUUID(),[item.id,item.id]);
  const q=new PlaybackQueue();q.start(item.id,[item.id]);f.db.saveQueue(q.snapshot(),0);
  f.db.close();f.db=null;
  let raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV6(raw);raw.close();
  f.db=new LibraryDatabase(f.filename);
  assert.equal(f.db.getItem(item.id).favorite,true);assert.equal(f.db.getItem(item.id).rating,5);
  assert.equal(f.db.list({view:'playlists',value:playlist.id}).total,2);
  assert.deepEqual(f.db.loadQueue(),q.snapshot());assert.equal(f.db.needsCatalog(item.fileId),true);
  const recording=f.db.getItem(item.id).catalog.recordingId;
  await scanRoot(f.db,f.root,()=>{});
  assert.equal(f.db.needsCatalog(item.fileId),false);
  assert.equal(f.db.getItem(item.id).catalog.recordingId,recording);
  const backups=fs.readdirSync(f.dir).filter(name=>name.includes('.pre-v6-'));assert.equal(backups.length,1);
  raw=new DatabaseSync(path.join(f.dir,backups[0]));
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version,5);
  assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM playlist_item').get().n,2);raw.close();
  raw=new DatabaseSync(f.filename);assert.equal(raw.prepare('PRAGMA user_version').get().user_version,require('../release/manifest.json').librarySchema.max);assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);raw.close();
});

test('catalog migration failure rolls back new schema and leaves the v5 backup intact',t=>{
  const f=fixture(t);file(f,'song.flac');f.db.close();f.db=null;
  let raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV6(raw);
  raw.exec('CREATE TABLE artist(conflicting_extension_column TEXT)');raw.close();
  assert.throws(()=>new LibraryDatabase(f.filename),/artist already exists/);
  raw=new DatabaseSync(f.filename);assert.equal(raw.prepare('PRAGMA user_version').get().user_version,5);
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='release'").get(),undefined);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM playable_item').get().n,1);raw.close();
  assert.equal(fs.readdirSync(f.dir).filter(name=>name.includes('.pre-v6-')).length,1);
});

test('scanner imports real ID3v2.4 multi-value artists, roles, genres and precise release date',async t=>{
  const f=fixture(t),music=path.join(f.dir,'music');fs.mkdirSync(music);
  require('./tagged-mp3.cjs').writeTaggedMp3(path.join(music,'tagged.mp3'),{date:'2020-05'});
  await scanRoot(f.db,f.root,()=>{});
  const item=f.db.list({view:'all'}).items[0];
  assert.equal(item.artist,'甲 feat. 乙');
  assert.deepEqual(item.catalog.artists.filter(m=>m.role==='performer').map(m=>m.name),['甲','乙','AC/DC']);
  assert.equal(item.catalog.albumArtist,'合集艺人');assert.equal(item.catalog.releaseDate,'2020-05');
  assert.deepEqual(item.catalog.genres.map(g=>g.name).sort(),['Jazz','电子']);
  assert.equal(f.db.list({view:'all',query:'AC/DC'}).total,1);
});


