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

async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aural-user-library-'));
  const music=path.join(dir,'music');fs.mkdirSync(music);
  fs.copyFileSync(path.join(__dirname,'fixtures','embedded-cover.mp3'),path.join(music,'song.mp3'));
  const filename=path.join(dir,'library.db');
  const holder={db:new LibraryDatabase(filename),filename,dir,music};
  const rootId=holder.db.addRoot(music);await scanRoot(holder.db,rootId,()=>{});
  t.after(()=>{holder.db?.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});
  return {...holder,holder,rootId,item:holder.db.list({view:'all'}).items[0]};
}

test('favorites, ratings and first-added time survive rescans, offline roots and reopening',async t=>{
  const f=await fixture(t),request={itemId:f.item.id,favorite:true,rating:4,baseRevision:0,commandId:randomUUID()};
  const state=f.db.user.setState(request);
  assert.equal(state.revision,1);
  assert.deepEqual(f.db.user.setState(request),state);
  assert.equal(f.db.list({view:'favorites',query:'封面'}).total,1);
  const added=f.db.getItem(f.item.id).addedAt;assert.ok(added);
  fs.utimesSync(path.join(f.music,'song.mp3'),new Date(),new Date(Date.now()+2000));
  await scanRoot(f.db,f.rootId,()=>{});
  assert.equal(f.db.getItem(f.item.id).addedAt,added);
  assert.equal(f.db.getItem(f.item.id).favorite,true);
  assert.equal(f.db.getItem(f.item.id).rating,4);
  f.db.markRootOffline(f.rootId);
  assert.equal(f.db.list({view:'favorites'}).items[0].available,false);
  await scanRoot(f.db,f.rootId,()=>{});
  assert.equal(f.db.getItem(f.item.id).available,true);
  fs.unlinkSync(path.join(f.music,'song.mp3'));
  await scanRoot(f.db,f.rootId,()=>{});
  assert.equal(f.db.list({view:'favorites'}).total,1);
  assert.equal(f.db.list({view:'favorites'}).items[0].available,false);
  f.db.close();f.holder.db=new LibraryDatabase(f.filename);
  assert.deepEqual(f.holder.db.user.setState(request),state);
  assert.throws(()=>f.holder.db.user.setState({...request,commandId:randomUUID(),favorite:false}),/已变化/);
  assert.throws(()=>f.holder.db.user.setState({...request,baseRevision:1,favorite:false}),/已用于不同操作/);
});

test('static playlists preserve duplicate identities, reject stale edits and commit changes with durable receipts',async t=>{
  const f=await fixture(t),createId=randomUUID();
  let playlist=f.db.user.create('重复歌单',createId,[f.item.id,f.item.id]);
  assert.deepEqual(f.db.user.create('重复歌单',createId,[f.item.id,f.item.id]),playlist);
  let items=f.db.list({view:'playlists',value:playlist.id}).items;
  assert.equal(items.length,2);assert.notEqual(items[0].playlistEntryId,items[1].playlistEntryId);
  const secondId=items[1].playlistEntryId;
  const context=f.db.user.playbackContext(playlist.id,secondId,playlist.revision);
  assert.equal(context.startIndex,1);
  const move={action:'move',playlistId:playlist.id,entryId:secondId,direction:-1,baseRevision:playlist.revision,commandId:randomUUID()};
  playlist=f.db.user.edit(move);assert.deepEqual(f.db.user.edit(move),playlist);
  const moveReceipt=playlist;
  assert.equal(f.db.list({view:'playlists',value:playlist.id}).items[0].playlistEntryId,secondId);
  assert.throws(()=>f.db.user.edit({...move,commandId:randomUUID()}),/已变化/);
  assert.throws(()=>f.db.user.edit({action:'add',playlistId:playlist.id,itemIds:[f.item.id,'missing'],baseRevision:playlist.revision,commandId:randomUUID()}),/不存在/);
  assert.equal(f.db.user.playlist(playlist.id).count,2);
  assert.equal(f.db.user.playlist(playlist.id).revision,playlist.revision);
  assert.throws(()=>f.db.user.create('不会留下空歌单',randomUUID(),['missing']),/不存在/);
  assert.equal(f.db.user.playlists().length,1);
  playlist=f.db.user.edit({action:'rename',playlistId:playlist.id,name:'重命名',baseRevision:playlist.revision,commandId:randomUUID()});
  playlist=f.db.user.edit({action:'remove',playlistId:playlist.id,entryId:secondId,baseRevision:playlist.revision,commandId:randomUUID()});
  assert.equal(f.db.list({view:'playlists',value:playlist.id}).items[0].playlistPosition,0);
  f.db.close();f.holder.db=new LibraryDatabase(f.filename);
  assert.equal(f.holder.db.user.playlist(playlist.id).name,'重命名');
  assert.deepEqual(f.holder.db.user.edit(move),moveReceipt);
  const remove={action:'delete',playlistId:playlist.id,baseRevision:playlist.revision,commandId:randomUUID()};
  assert.equal(f.holder.db.user.edit(remove),null);assert.equal(f.holder.db.user.edit(remove),null);
  assert.equal(f.holder.db.user.playlists().length,0);assert.ok(f.holder.db.getItem(f.item.id));
});

test('CUE track removal retains referenced user data and becomes available when the track returns',async t=>{
  const f=await fixture(t);
  const cue=two=>`TITLE "测试 CUE"\nFILE "song.mp3" MP3\n TRACK 01 AUDIO\n TITLE "一"\n INDEX 01 00:00:00${two?'\n TRACK 02 AUDIO\n TITLE "二"\n INDEX 01 00:01:00':''}`;
  fs.writeFileSync(path.join(f.music,'song.cue'),cue(true));await scanRoot(f.db,f.rootId,()=>{});
  const second=f.db.list({view:'all'}).items.find(item=>item.title==='二');
  f.db.user.setState({itemId:second.id,favorite:true,baseRevision:0,commandId:randomUUID()});
  const playlist=f.db.user.create('CUE 保留',randomUUID(),[second.id]);
  fs.writeFileSync(path.join(f.music,'song.cue'),cue(false));await scanRoot(f.db,f.rootId,()=>{});
  assert.equal(f.db.list({view:'favorites'}).items[0].available,false);
  assert.equal(f.db.list({view:'playlists',value:playlist.id}).items[0].id,second.id);
  fs.writeFileSync(path.join(f.music,'song.cue'),cue(true));await scanRoot(f.db,f.rootId,()=>{});
  assert.equal(f.db.getItem(second.id).available,true);assert.equal(f.db.getItem(second.id).favorite,true);
});

test('v4 migration backs up an intact library, preserves queue and metadata, and leaves unknown old import times unset',async t=>{
  const f=await fixture(t);
  const queue=new PlaybackQueue();queue.start(f.item.id,[f.item.id]);f.db.saveQueue(queue.snapshot(),0);
  f.db.applyMetadata(f.item.id,0,{provider:'musicbrainz',recordingId:randomUUID(),releaseId:null,title:'确认标题',artist:'测试歌手',album:null},['title']);
  f.db.close();f.holder.db=null;
  let raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV5(raw);raw.close();
  f.holder.db=new LibraryDatabase(f.filename);
  assert.equal(f.holder.db.getItem(f.item.id).title,'确认标题');
  assert.equal(f.holder.db.getItem(f.item.id).addedAt,null);
  assert.deepEqual(f.holder.db.loadQueue(),queue.snapshot());
  raw=new DatabaseSync(f.filename);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version,68);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);raw.close();
  const backups=fs.readdirSync(f.dir).filter(name=>name.includes('.pre-v5-')&&name.endsWith('.bak'));
  assert.equal(backups.length,1);
  raw=new DatabaseSync(path.join(f.dir,backups[0]));
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version,4);
  assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');raw.close();
});


