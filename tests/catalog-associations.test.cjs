const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {LibraryDatabase}=require('../dist/main/library/database.js');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aural-association-')),filename=path.join(dir,'library.db'),f={dir,filename,db:new LibraryDatabase(filename)};
  f.root=f.db.addRoot(path.join(dir,'music'));
  f.write=(relativePath,title='作品',album='专辑')=>{
    const fileId=f.db.upsertFile(f.root,{relativePath,title,album,artist:'甲',genre:'Jazz',size:1,mtimeMs:1,durationSeconds:60,
      codec:relativePath.endsWith('.mp3')?'MP3':'FLAC',sampleRate:44100,bitsPerSample:16,trackNumber:1,discNumber:1,
      catalog:{artists:['甲'],albumArtist:'甲',genres:['Jazz']}},1);
    return f.db.list({view:'all'}).items.find(i=>i.fileId===fileId);
  };
  t.after(()=>{f.db?.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});return f;
}
const ref=item=>({itemId:item.id,revision:item.catalog.revision});

test('recording confirmation spans distinct releases and preserves canonical snapshots under rescans',t=>{
  const f=fixture(t),a=f.write('original/a.flac','作品','原版'),b=f.write('collection/b.mp3','剪辑标签','合集');
  const request={action:'recording',items:[ref(b)],target:ref(a),commandId:randomUUID()};
  const result=f.db.associations.link(request);
  let aa=f.db.getItem(a.id),bb=f.db.getItem(b.id);
  assert.equal(aa.catalog.recordingId,bb.catalog.recordingId);
  assert.notEqual(aa.catalog.releaseId,bb.catalog.releaseId);assert.notEqual(aa.catalog.releaseTrackId,bb.catalog.releaseTrackId);
  assert.equal(bb.catalog.confirmed,true);assert.equal(aa.catalog.recordingTitle,'作品');
  const rec=aa.catalog.recordingId,track=bb.catalog.releaseTrackId;
  f.write('original/a.flac','扫描的新标签','新专辑');
  aa=f.db.getItem(a.id);assert.equal(aa.title,'扫描的新标签');assert.equal(aa.catalog.recordingId,rec);
  assert.equal(aa.catalog.recordingTitle,'作品');assert.equal(aa.catalog.releaseTitle,'原版');
  assert.equal(f.db.getItem(b.id).catalog.releaseTrackId,track);
  assert.deepEqual(f.db.associations.link(request),result);
  assert.throws(()=>f.db.associations.undo(result.changeId,randomUUID()),/已变化/);
  const raw=new DatabaseSync(f.filename);assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);raw.close();
});

test('confirmed release-track versions fold after filtering and keep favorites and repeated playlists intact',t=>{
  const f=fixture(t),a=f.write('album/a.flac'),b=f.write('copy/b.mp3','版本别名');
  f.db.user.setState({itemId:b.id,favorite:true,rating:5,baseRevision:0,commandId:randomUUID()});
  const p=f.db.user.create('重复版本',randomUUID(),[a.id,b.id,b.id]);
  f.db.associations.link({action:'version',items:[ref(b)],target:ref(a),commandId:randomUUID()});
  const aa=f.db.getItem(a.id),bb=f.db.getItem(b.id);
  assert.equal(aa.catalog.releaseTrackId,bb.catalog.releaseTrackId);assert.equal(aa.catalog.releaseId,bb.catalog.releaseId);
  const folded=f.db.list({view:'all',collapseVersions:true});assert.equal(folded.total,1);assert.equal(folded.items[0].versionCount,2);
  assert.equal(f.db.list({view:'all',query:'版本别名',collapseVersions:true}).items[0].id,b.id);
  assert.equal(f.db.list({view:'favorites',collapseVersions:true}).items[0].id,b.id);
  assert.equal(f.db.list({view:'playlists',value:p.id,collapseVersions:true}).total,3);
  const versions=f.db.versions(a.id,1,1);assert.equal(versions.total,2);assert.equal(versions.items.length,1);
  assert.deepEqual(new Set(f.db.versions(a.id).items.map(i=>i.id)),new Set([a.id,b.id]));
  f.write('copy/b.mp3','新版本标签','另一个标签');
  assert.equal(f.db.getItem(b.id).catalog.releaseTrackId,aa.catalog.releaseTrackId);
  assert.equal(f.db.getItem(b.id).favorite,true);assert.equal(f.db.getItem(b.id).rating,5);
  const raw=new DatabaseSync(f.filename);
  assert.throws(()=>raw.prepare('UPDATE item_catalog_binding SET recording_id=? WHERE item_id=?').run(a.catalog.recordingId,b.id),/FOREIGN KEY/);
  raw.prepare("UPDATE media_file SET status='missing' WHERE id=?").run(a.fileId);raw.close();
  assert.equal(f.db.list({view:'all',collapseVersions:true}).items[0].id,b.id);
});

test('association/reset/undo are atomic, revision guarded and durably replayed across reopen',t=>{
  const f=fixture(t),a=f.write('a/a.flac'),b=f.write('b/b.mp3');
  const request={action:'version',items:[ref(b)],target:ref(a),commandId:randomUUID()},result=f.db.associations.link(request);
  assert.deepEqual(f.db.associations.link({target:request.target,commandId:request.commandId,items:request.items,action:request.action}),result);
  assert.throws(()=>f.db.associations.link({...request,commandId:randomUUID()}),/已变化/);
  assert.throws(()=>f.db.associations.link({...request,action:'recording'}),/已用于不同操作/);
  const bb=f.db.getItem(b.id),reset=f.db.associations.link({action:'reset',items:[ref(bb)],commandId:randomUUID()});
  assert.equal(f.db.getItem(b.id).catalog.confirmed,false);
  assert.notEqual(f.db.getItem(b.id).catalog.releaseTrackId,bb.catalog.releaseTrackId);
  const undoId=randomUUID(),undo=f.db.associations.undo(reset.changeId,undoId);
  assert.equal(f.db.getItem(b.id).catalog.releaseTrackId,bb.catalog.releaseTrackId);
  assert.throws(()=>f.db.associations.undo(result.changeId,randomUUID()),/已变化/);
  f.db.close();f.db=new LibraryDatabase(f.filename);
  assert.deepEqual(f.db.associations.link(request),result);
  assert.deepEqual(f.db.associations.undo(reset.changeId,undoId),undo);
  const snapshot=f.db.getItem(a.id).catalog;
  assert.throws(()=>f.db.associations.link({action:'version',items:[ref(f.db.getItem(a.id))],target:{itemId:'missing',revision:0},commandId:randomUUID()}),/不存在/);
  assert.deepEqual(f.db.getItem(a.id).catalog,snapshot);
});

test('undo restores independent local identities and never deletes shared recordings or files',t=>{
  const f=fixture(t),a=f.write('a/a.flac'),b=f.write('b/b.mp3'),commandId=randomUUID();
  const linked=f.db.associations.link({action:'version',items:[ref(b)],target:ref(a),commandId});
  f.db.associations.undo(linked.changeId,randomUUID());
  assert.equal(f.db.getItem(a.id).catalog.recordingId,a.catalog.recordingId);
  assert.equal(f.db.getItem(b.id).catalog.releaseTrackId,b.catalog.releaseTrackId);
  assert.equal(f.db.list({view:'all'}).total,2);
  const raw=new DatabaseSync(f.filename);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM catalog_change').get().n,2);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM recording WHERE local_key IS NULL').get().n,1);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);raw.close();
});

test('release-group confirmation refreshes all affected tracks, supports undo and detects later regrouping',t=>{
  const f=fixture(t),a=f.write('a/a.flac','作品','原版'),a2=f.write('a/b.flac','第二首','原版'),b=f.write('b/b.mp3','作品','再版');
  const groupRequest=(one,two,title)=>({action:'group',title,items:[ref(one),ref(two)],releases:[
    {releaseId:one.catalog.releaseId,revision:one.catalog.releaseRevision},{releaseId:two.catalog.releaseId,revision:two.catalog.releaseRevision}],commandId:randomUUID()});
  const result=f.db.associations.link(groupRequest(a,b,'同一专辑概念'));
  assert.equal(f.db.getItem(a.id).catalog.groupId,result.groupId);assert.equal(f.db.getItem(b.id).catalog.groupId,result.groupId);
  assert.equal(f.db.getItem(a2.id).catalog.groupId,result.groupId);
  assert.equal(f.db.getItem(a2.id).catalog.revision,a2.catalog.revision+1);
  assert.equal(f.db.list({view:'all',query:'同一专辑概念'}).total,3);
  assert.equal(f.db.facets('albumGroups')[0].id,result.groupId);
  assert.equal(f.db.list({view:'albumGroups',facetId:result.groupId}).total,3);
  f.db.associations.undo(result.changeId,randomUUID());assert.equal(f.db.getItem(a.id).catalog.groupId,null);
  const first=f.db.associations.link(groupRequest(f.db.getItem(a.id),f.db.getItem(b.id),'概念一'));
  const second=f.db.associations.link(groupRequest(f.db.getItem(a.id),f.db.getItem(b.id),'概念二'));
  assert.throws(()=>f.db.associations.undo(first.changeId,randomUUID()),/已变化/);
  f.db.associations.undo(second.changeId,randomUUID());assert.equal(f.db.getItem(a.id).catalog.groupId,first.groupId);
});

test('v6 migration creates a consistent v7 backup and preserves candidate IDs and user data',t=>{
  const f=fixture(t),a=f.write('a/a.flac');f.db.user.setState({itemId:a.id,favorite:true,baseRevision:0,commandId:randomUUID()});
  const rec=a.catalog.recordingId;f.db.close();f.db=null;
  let raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV7(raw);raw.close();
  f.db=new LibraryDatabase(f.filename);assert.equal(f.db.getItem(a.id).catalog.recordingId,rec);assert.equal(f.db.getItem(a.id).favorite,true);
  assert.equal(f.db.getItem(a.id).catalog.revision,0);
  const backups=fs.readdirSync(f.dir).filter(n=>n.includes('.pre-v7-'));assert.equal(backups.length,1);
  raw=new DatabaseSync(path.join(f.dir,backups[0]));assert.equal(raw.prepare('PRAGMA user_version').get().user_version,6);
  assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');raw.close();
});

test('v7 migration failure rolls back all new tables and indexes and retains a v6 backup',t=>{
  const f=fixture(t),a=f.write('a/a.flac');f.db.close();f.db=null;
  let raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV7(raw);
  raw.exec('CREATE TABLE item_catalog_binding(conflicting_extension TEXT)');raw.close();
  assert.throws(()=>new LibraryDatabase(f.filename),/already exists/);
  raw=new DatabaseSync(f.filename);assert.equal(raw.prepare('PRAGMA user_version').get().user_version,6);
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='idx_track_recording'").get(),undefined);
  assert.equal(raw.prepare('SELECT recording_id FROM playable_item WHERE id=?').get(a.id).recording_id,a.catalog.recordingId);raw.close();
  assert.equal(fs.readdirSync(f.dir).filter(n=>n.includes('.pre-v7-')).length,1);
});
