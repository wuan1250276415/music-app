const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {LibraryDatabase}=require('../dist/main/library/database.js');
const ref=r=>({releaseId:r.releaseId,revision:r.revision,fingerprint:r.fingerprint});
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aural-releases-')),filename=path.join(dir,'library.db'),f={dir,filename,db:new LibraryDatabase(filename)};
  f.write=(folder,name,options={})=>{
    const root=f.db.addRoot(path.join(dir,folder)),tags={relativePath:name+'.flac',size:1,mtimeMs:1,title:name,artist:'歌手',album:'同名专辑',genre:'Jazz',durationSeconds:60,
      codec:'FLAC',sampleRate:44100,bitsPerSample:16,trackNumber:1,discNumber:1,...options};
    const fileId=f.db.upsertFile(root,tags,1);return f.db.list({view:'all'}).items.find(item=>item.fileId===fileId);
  };
  f.summary=item=>f.db.releases.summary(f.db.getItem(item.id).catalog.releaseId);
  f.merge=(a,b,commandId=randomUUID())=>{const source=f.summary(a),target=f.summary(b);return {action:'release-merge',sources:[ref(source)],target:ref(target),discMap:[
    ...target.media.map(m=>({releaseId:target.releaseId,sourceDisc:m.discNumber,targetDisc:m.discNumber})),
    ...source.media.map(m=>({releaseId:source.releaseId,sourceDisc:m.discNumber,targetDisc:m.discNumber+10}))],commandId};};
  t.after(()=>{f.db?.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});return f;
}
test('whole release merge preserves distinct recordings, file versions, user and queue identities; rescan and restart retain bindings',t=>{
  const f=fixture(t),a=f.write('one','甲'),a2=f.write('one','甲版本'),c=f.write('one','乙',{trackNumber:2}),b=f.write('two','甲',{catalog:{date:'2020',edition:'目标版'}});
  f.db.associations.link({action:'version',items:[{itemId:a2.id,revision:a2.catalog.revision}],target:{itemId:a.id,revision:a.catalog.revision},commandId:randomUUID()});
  const before=f.db.getItems([a.id,a2.id,c.id,b.id]),oldRecordings=before.map(item=>item.catalog.recordingId);
  f.db.user.setState({itemId:a.id,favorite:true,rating:4,baseRevision:0,commandId:randomUUID()});
  const playlist=f.db.user.create('重复条目',randomUUID(),[a.id,b.id,a.id]);
  const queue=new (require('../dist/main/main/queue.js').PlaybackQueue)();queue.start(a.id,[a.id,b.id,a.id]);f.db.saveQueue(queue.snapshot(),0);
  const request=f.merge(a,b),change=f.db.releases.edit(request),items=f.db.getItems(before.map(item=>item.id));
  assert.equal(new Set(items.map(item=>item.catalog.releaseId)).size,1);assert.deepEqual(items.map(item=>item.catalog.recordingId),oldRecordings);
  assert.equal(items[0].catalog.releaseTrackId,items[1].catalog.releaseTrackId);assert.notEqual(items[0].catalog.releaseTrackId,items[3].catalog.releaseTrackId);
  assert.equal(items[0].catalog.mediumDiscNumber,11);assert.equal(items[3].catalog.mediumDiscNumber,1);assert.equal(items[0].catalog.edition,'目标版');
  assert.equal(items[0].favorite,true);assert.equal(items[0].rating,4);assert.equal(f.db.user.playlists()[0].count,3);
  assert.deepEqual(f.db.loadQueue(),queue.snapshot());
  const detail=f.db.releaseDetail(items[0].catalog.releaseId);assert.equal(detail.total,3);assert.equal(detail.release.fileCount,4);assert.ok(detail.items.some(item=>item.versionCount===2));
  assert.equal(f.db.list({view:'all',collapseVersions:true}).total,3);assert.equal(f.db.catalogChanges().total,2);
  assert.deepEqual(f.db.releases.edit({...request,target:{fingerprint:request.target.fingerprint,revision:request.target.revision,releaseId:request.target.releaseId}}),change);
  f.write('one','甲',{mtimeMs:2});assert.equal(f.db.getItem(a.id).catalog.releaseId,items[0].catalog.releaseId);
  assert.equal(f.db.list({view:'playlists',value:playlist.id}).items.length,3);
  f.db.close();f.db=new LibraryDatabase(f.filename);assert.equal(f.db.getItem(a.id).catalog.releaseConfirmed,true);assert.deepEqual(f.db.releases.edit(request),change);
});
test('same-disc collisions retain independent tracks and printed numbers with unique positions and target medium metadata',t=>{
  const f=fixture(t),a=f.write('one','同名'),b=f.write('two','同名');
  let raw=new DatabaseSync(f.filename);raw.prepare(`UPDATE medium SET title='目标介质',format='CD' WHERE release_id=?`).run(b.catalog.releaseId);raw.close();
  const request=f.merge(a,b);request.discMap=request.discMap.map(m=>({...m,targetDisc:1}));f.db.releases.edit(request);
  const items=f.db.getItems([a.id,b.id]);assert.notEqual(items[0].catalog.releaseTrackId,items[1].catalog.releaseTrackId);assert.equal(items[0].catalog.printedNumber,'1');assert.equal(items[1].catalog.printedNumber,'1');
  assert.equal(items[1].catalog.trackPosition,1);assert.equal(items[0].catalog.trackPosition,2);
  raw=new DatabaseSync(f.filename);assert.deepEqual(raw.prepare('SELECT title,format FROM medium WHERE release_id=?').get(items[0].catalog.releaseId),Object.assign(Object.create(null),{title:'目标介质',format:'CD'}));assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);raw.close();
});
test('split moves every file version of selected logical tracks, leaves the rest, and supports durable guarded undo',t=>{
  const f=fixture(t),a=f.write('one','甲'),v=f.write('one','甲副本'),b=f.write('one','乙',{discNumber:2});
  f.db.associations.link({action:'version',items:[{itemId:v.id,revision:v.catalog.revision}],target:{itemId:a.id,revision:a.catalog.revision},commandId:randomUUID()});
  // Different raw disc tags form one contextual release.
  const source=f.summary(a);assert.equal(source.trackCount,2);
  const prior=f.db.getItems([a.id,v.id,b.id]),request={action:'release-split',source:ref(source),trackIds:[prior[0].catalog.releaseTrackId],fields:{title:'独立发行',date:'2026',country:'CN',edition:'精选'},commandId:randomUUID()};
  const change=f.db.releases.edit(request),current=f.db.getItems([a.id,v.id,b.id]);
  assert.equal(current[0].catalog.releaseId,current[1].catalog.releaseId);assert.notEqual(current[0].catalog.releaseId,current[2].catalog.releaseId);
  assert.equal(current[2].catalog.releaseId,source.releaseId);assert.equal(current[0].catalog.releaseTitle,'独立发行');
  assert.equal(f.db.list({view:'all',query:'独立发行'}).total,2);assert.equal(f.db.stats().albums,2);
  const undoCommand=randomUUID(),undo=f.db.undoCatalog(change.changeId,undoCommand);
  assert.deepEqual(f.db.getItems([a.id,v.id,b.id]).map(item=>[item.catalog.releaseId,item.catalog.releaseTrackId]),prior.map(item=>[item.catalog.releaseId,item.catalog.releaseTrackId]));
  f.db.close();f.db=new LibraryDatabase(f.filename);assert.deepEqual(f.db.undoCatalog(change.changeId,undoCommand),undo);
  assert.throws(()=>f.db.undoCatalog(change.changeId,randomUUID()),/已撤销/);
});
test('preview membership guards scans and later bindings; invalid mapping and command collisions roll back atomically',t=>{
  const f=fixture(t),a=f.write('one','甲'),b=f.write('two','乙');
  const stale=f.merge(a,b);f.write('one','新增');assert.throws(()=>f.db.releases.edit(stale),/成员已变化/);assert.equal(f.db.catalogChanges().total,0);
  const valid=f.merge(a,b);
  for(const mapping of [[],[...valid.discMap,valid.discMap[0]],valid.discMap.map(m=>({...m,targetDisc:0})),valid.discMap.map(m=>({...m,releaseId:'missing'}))]){
    assert.throws(()=>f.db.releases.edit({...valid,commandId:randomUUID(),discMap:mapping}));assert.equal(f.db.catalogChanges().total,0);assert.equal(f.db.stats().albums,2);
  }
  const change=f.db.releases.edit(valid);assert.throws(()=>f.db.releases.edit({...valid,discMap:[]}),/已用于不同操作/);
  const external=f.write('three','丙'),target=f.db.getItem(a.id);
  f.db.associations.link({action:'version',items:[{itemId:external.id,revision:external.catalog.revision}],target:{itemId:a.id,revision:target.catalog.revision},commandId:randomUUID()});
  assert.throws(()=>f.db.undoCatalog(change.changeId,randomUUID()),/成员已变化/);
});
test('adding a version to an already confirmed track invalidates release undo even without a target item revision change',t=>{
  const f=fixture(t),a=f.write('one','甲'),v=f.write('one','副本'),b=f.write('two','乙');
  f.db.associations.link({action:'version',items:[{itemId:v.id,revision:v.catalog.revision}],target:{itemId:a.id,revision:a.catalog.revision},commandId:randomUUID()});
  const change=f.db.releases.edit(f.merge(a,b)),target=f.db.getItem(a.id),external=f.write('three','丙');
  f.db.associations.link({action:'version',items:[{itemId:external.id,revision:external.catalog.revision}],target:{itemId:a.id,revision:target.catalog.revision},commandId:randomUUID()});
  assert.equal(f.db.getItem(a.id).catalog.revision,target.catalog.revision);assert.throws(()=>f.db.undoCatalog(change.changeId,randomUUID()),/成员已变化/);
});
test('a late binding failure rolls back copied entities, search, revisions, audit and receipt together',t=>{
  const f=fixture(t),a=f.write('one','甲'),b=f.write('two','乙'),request=f.merge(a,b),prior=f.db.getItems([a.id,b.id]);
  let raw=new DatabaseSync(f.filename);const count=raw.prepare('SELECT COUNT(*) n FROM release').get().n;
  raw.exec(`CREATE TRIGGER fail_release BEFORE INSERT ON item_catalog_binding WHEN NEW.item_id='${a.id}' BEGIN SELECT RAISE(ABORT,'injected binding failure'); END;`);raw.close();
  assert.throws(()=>f.db.releases.edit(request),/injected binding failure/);assert.deepEqual(f.db.getItems([a.id,b.id]),prior);assert.equal(f.db.catalogChanges().total,0);
  raw=new DatabaseSync(f.filename);assert.equal(raw.prepare('SELECT COUNT(*) n FROM release').get().n,count);assert.equal(raw.prepare('SELECT COUNT(*) n FROM user_command_receipt WHERE command_id=?').get(request.commandId).n,0);raw.exec('DROP TRIGGER fail_release');raw.close();
  assert.ok(f.db.releases.edit(request).changeId);
});
test('split rejects empty, all, foreign or duplicated logical tracks, and later edits guard undo',t=>{
  const f=fixture(t),a=f.write('one','甲'),b=f.write('one','乙'),other=f.write('two','丙'),source=f.summary(a);
  const valid={action:'release-split',source:ref(source),trackIds:[a.catalog.releaseTrackId],fields:{title:'独立',date:'',country:'',edition:''},commandId:randomUUID()};
  for(const trackIds of [[],[a.catalog.releaseTrackId,b.catalog.releaseTrackId],[other.catalog.releaseTrackId],[a.catalog.releaseTrackId,a.catalog.releaseTrackId]])assert.throws(()=>f.db.releases.edit({...valid,trackIds,commandId:randomUUID()}));
  assert.equal(f.db.catalogChanges().total,0);const change=f.db.releases.edit(valid),item=f.db.getItem(a.id);
  f.db.associations.link({action:'reset',items:[{itemId:a.id,revision:item.catalog.revision}],commandId:randomUUID()});
  assert.throws(()=>f.db.undoCatalog(change.changeId,randomUUID()),/已变化/);
  assert.throws(()=>f.db.releases.candidates('',101));assert.throws(()=>f.db.releaseDetail(source.releaseId,50,-1));
});
test('v8 migration keeps old association revisions and references with backup, and v9 DDL failure rolls back',t=>{
  const f=fixture(t),a=f.write('one','甲'),b=f.write('two','乙');
  const change=f.db.associations.link({action:'version',items:[{itemId:a.id,revision:a.catalog.revision}],target:{itemId:b.id,revision:b.catalog.revision},commandId:randomUUID()});
  const revision=f.db.getItem(a.id).catalog.revision;f.db.user.create('重复',randomUUID(),[a.id,a.id]);f.db.close();f.db=null;
  let raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV9(raw);
  const legacy=new (require('../dist/main/library/catalog.js').CatalogRepository)(raw);legacy.enableAssociations();legacy.enableArtists();legacy.refreshRevision(a.id,true);raw.close();
  f.db=new LibraryDatabase(f.filename);assert.equal(f.db.getItem(a.id).catalog.revision,revision);assert.equal(f.db.user.playlists()[0].count,2);
  f.db.undoCatalog(change.changeId,randomUUID());assert.equal(f.db.getItem(a.id).catalog.confirmed,false);
  const backup=fs.readdirSync(f.dir).find(name=>name.includes('pre-v9'));raw=new DatabaseSync(path.join(f.dir,backup));assert.equal(raw.prepare('PRAGMA user_version').get().user_version,8);assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');raw.close();
  f.db.close();f.db=null;raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV9(raw);raw.exec('CREATE TABLE release_change(extension TEXT)');raw.close();
  assert.throws(()=>new LibraryDatabase(f.filename),/already exists/);raw=new DatabaseSync(f.filename);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version,8);assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');raw.close();
});
test('v8 ordered artist-credit audit remains undoable after the v9 projection upgrade',t=>{
  const f=fixture(t),a=f.write('one','甲'),b=f.write('two','乙'),artist=b.catalog.artists[0];
  const change=f.db.artists.edit({action:'artist-credit',itemId:a.id,revision:a.catalog.revision,commandId:randomUUID(),members:[{artistId:artist.sourceArtistId,artistRevision:artist.artistRevision,role:'performer',joinPhrase:''}]});
  const edited=f.db.getItem(a.id);f.db.close();f.db=null;const raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV9(raw);
  const legacy=new (require('../dist/main/library/catalog.js').CatalogRepository)(raw);legacy.enableAssociations();legacy.enableArtists();for(const id of [a.id,b.id])legacy.refreshRevision(id,true);raw.close();
  f.db=new LibraryDatabase(f.filename);assert.equal(f.db.getItem(a.id).catalog.revision,edited.catalog.revision);assert.equal(f.db.getItem(a.id).catalog.creditConfirmed,true);
  f.db.undoCatalog(change.changeId,randomUUID());assert.equal(f.db.getItem(a.id).catalog.creditConfirmed,false);
});
