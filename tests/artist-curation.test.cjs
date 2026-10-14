const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {LibraryDatabase}=require('../dist/main/library/database.js');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aural-artists-')),filename=path.join(dir,'library.db');
  const f={dir,filename,db:new LibraryDatabase(filename)};
  f.write=(folder,name,title='作品',performers=[name])=>{
    const root=f.db.addRoot(path.join(dir,folder));
    const fileId=f.db.upsertFile(root,{relativePath:'song.flac',title,artist:name,album:'专辑',genre:'Jazz',size:1,mtimeMs:1,durationSeconds:60,
      codec:'FLAC',sampleRate:44100,bitsPerSample:16,trackNumber:1,discNumber:1,catalog:{artists:performers,albumArtists:[name],composers:['作者']}},1);
    return f.db.list({view:'all'}).items.find(item=>item.fileId===fileId);
  };
  f.candidate=(name,folder)=>f.db.artists.candidates(name).items.find(artist=>!artist.confirmed&&artist.name===name&&artist.context===path.join(dir,folder));
  t.after(()=>{f.db?.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});return f;
}
const ref=artist=>({artistId:artist.id,revision:artist.revision});
function link(f,source,target,commandId=randomUUID()){return f.db.artists.edit({action:'artist-link',sources:[ref(source)],target:ref(target),commandId});}

test('artist identities remain separate until confirmed and update all roles, search and exact facets',t=>{
  const f=fixture(t),a=f.write('one','Alias A'),b=f.write('two','标准艺人'),c=f.write('three','Alias A');
  assert.equal(f.db.facets('artists').length,3);
  const source=f.candidate('Alias A','one'),target=f.candidate('标准艺人','two'),change=link(f,source,target);
  const aa=f.db.getItem(a.id),bb=f.db.getItem(b.id),cc=f.db.getItem(c.id),identity=aa.catalog.artists[0].id;
  assert.equal(aa.artist,'标准艺人');assert.equal(aa.catalog.albumArtists[0].id,identity);assert.equal(bb.catalog.artists[0].id,identity);
  assert.notEqual(cc.catalog.artists[0].id,identity);assert.equal(cc.artist,'Alias A');
  assert.equal(f.db.list({view:'artists',facetId:identity}).total,2);assert.equal(f.db.list({view:'artists',facetId:identity,artistRole:'album_artist'}).total,2);
  assert.equal(f.db.list({view:'all',query:'标准艺人'}).total,2);assert.equal(f.db.stats().artists,2);
  assert.equal(f.db.catalogChanges().items.find(row=>row.id===change.changeId).itemCount,2);
  // Preserve the source tag text and identities instead of rewriting them.
  const raw=new DatabaseSync(f.filename);assert.equal(raw.prepare('SELECT artist FROM playable_item WHERE id=?').get(a.id).artist,'Alias A');
  assert.equal(raw.prepare('SELECT name FROM artist WHERE id=?').get(source.id).name,'Alias A');
  assert.throws(()=>raw.prepare('INSERT INTO artist_identity_binding(source_artist_id,identity_artist_id) VALUES(?,?)').run(identity,cc.catalog.artists[0].id),/invalid artist identity/);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);raw.close();
});

test('identity confirmation preserves original compound display text until the user explicitly edits credits',t=>{
  const f=fixture(t),a=f.write('one','甲 feat. 乙','合作作品',['甲','乙','AC/DC']),b=f.write('two','甲');
  link(f,f.candidate('甲','one'),f.candidate('甲','two'));
  assert.equal(f.db.getItem(a.id).artist,'甲 feat. 乙');
  assert.equal(f.db.getItem(a.id).catalog.artists.filter(member=>member.role==='performer').length,3);
  assert.equal(f.db.getItem(a.id).catalog.artists[0].id,f.db.getItem(b.id).catalog.artists[0].id);
});

test('identity bindings survive rescans, support per-source split/reset and guarded undo across restart',t=>{
  const f=fixture(t),a=f.write('one','甲'),b=f.write('two','甲');
  const linked=link(f,f.candidate('甲','one'),f.candidate('甲','two'));
  const identity=f.db.getItem(a.id).catalog.artists[0].id;
  f.write('one','甲');assert.equal(f.db.getItem(a.id).catalog.artists[0].id,identity);
  const source=f.candidate('甲','one'),reset=f.db.artists.edit({action:'artist-reset',sources:[ref(source)],commandId:randomUUID()});
  assert.notEqual(f.db.getItem(a.id).catalog.artists[0].id,identity);assert.equal(f.db.getItem(b.id).catalog.artists[0].id,identity);
  f.db.undoCatalog(reset.changeId,randomUUID());assert.equal(f.db.getItem(a.id).catalog.artists[0].id,identity);
  assert.throws(()=>f.db.undoCatalog(linked.changeId,randomUUID()),/已变化/);
  f.db.close();f.db=new LibraryDatabase(f.filename);assert.equal(f.db.getItem(a.id).catalog.artists[0].id,identity);
  assert.equal(f.db.catalogChanges().total,3);
});

test('manual ordered credits preserve roles and join phrases, split identity for one item, and remain after scanning',t=>{
  const f=fixture(t),a=f.write('one','甲'),b=f.write('two','乙'),c=f.write('three','独立身份');
  link(f,f.candidate('甲','one'),f.candidate('乙','two'));
  const source=f.db.getItem(a.id),first=f.candidate('独立身份','three'),second=f.candidate('乙','two'),composer=f.candidate('作者','one');
  const request={action:'artist-credit',itemId:a.id,revision:source.catalog.revision,commandId:randomUUID(),members:[
    {artistId:first.id,artistRevision:first.revision,role:'performer',joinPhrase:' feat. '},{artistId:second.id,artistRevision:second.revision,role:'performer',joinPhrase:''},{artistId:composer.id,artistRevision:composer.revision,role:'composer',joinPhrase:''}]};
  const change=f.db.artists.edit(request);let item=f.db.getItem(a.id);
  assert.equal(item.artist,'独立身份 feat. 乙');assert.equal(item.catalog.creditConfirmed,true);
  assert.deepEqual(item.catalog.artists.map(member=>[member.name,member.role,member.joinPhrase]),[['独立身份','performer',' feat. '],['乙','performer',''],['作者','composer','']]);
  assert.equal(item.catalog.albumArtists[0].name,'乙');assert.equal(f.db.getItem(b.id).artist,'乙');
  assert.equal(f.db.list({view:'all',query:'feat.'}).items[0].id,a.id);
  f.write('one','新标签','改过的作品');item=f.db.getItem(a.id);assert.equal(item.artist,'独立身份 feat. 乙');assert.equal(item.title,'改过的作品');
  assert.deepEqual(f.db.artists.edit(request),change);
  assert.throws(()=>f.db.undoCatalog(change.changeId,randomUUID()),/已变化/);
  const reset=f.db.artists.edit({action:'credit-reset',itemId:a.id,revision:item.catalog.revision,commandId:randomUUID()});
  assert.equal(f.db.getItem(a.id).artist,'新标签');assert.equal(f.db.getItem(a.id).catalog.creditConfirmed,false);
  f.db.undoCatalog(reset.changeId,randomUUID());assert.equal(f.db.getItem(a.id).artist,'独立身份 feat. 乙');
  f.db.close();f.db=new LibraryDatabase(f.filename);assert.equal(f.db.getItem(a.id).artist,'独立身份 feat. 乙');
});

test('artist commands atomically reject invalid edits, guard revisions, and replay normalized receipts durably',t=>{
  const f=fixture(t),a=f.write('one','AC/DC'),b=f.write('two','甲');
  assert.equal(f.db.getItem(a.id).catalog.artists[0].name,'AC/DC');
  const source=f.candidate('AC/DC','one'),target=f.candidate('甲','two');
  const request={action:'artist-link',sources:[ref(source)],target:ref(target),commandId:randomUUID()},result=f.db.artists.edit(request);
  assert.deepEqual(f.db.artists.edit({target:{revision:target.revision,artistId:target.id},commandId:request.commandId,sources:request.sources,action:request.action}),result);
  assert.throws(()=>f.db.artists.edit({...request,commandId:randomUUID()}),/已变化/);
  assert.throws(()=>f.db.artists.edit({...request,action:'artist-reset'}),/已用于不同操作/);
  const now=f.db.getItem(a.id),valid={action:'artist-credit',itemId:a.id,revision:now.catalog.revision,commandId:randomUUID(),members:[{artistId:source.id,artistRevision:f.candidate('AC/DC','one').revision,role:'performer',joinPhrase:''}]};
  for(const members of [[],[{artistId:'missing',artistRevision:0,role:'performer',joinPhrase:''}],[{...valid.members[0],joinPhrase:'尾部'}],
    [{...valid.members[0],role:'composer'}],[valid.members[0],valid.members[0]],[{...valid.members[0],role:'album_artist'}]]){
    assert.throws(()=>f.db.artists.edit({...valid,commandId:randomUUID(),members}));
    assert.equal(f.db.getItem(a.id).catalog.revision,now.catalog.revision);assert.equal(f.db.catalogChanges().total,1);
  }
  const undoId=randomUUID(),undone=f.db.undoCatalog(result.changeId,undoId);assert.equal(f.db.getItem(a.id).artist,'AC/DC');
  f.db.close();f.db=new LibraryDatabase(f.filename);
  assert.deepEqual(f.db.artists.edit(request),result);assert.deepEqual(f.db.undoCatalog(result.changeId,undoId),undone);
  assert.throws(()=>f.db.undoCatalog(result.changeId,randomUUID()),/已撤销/);
  assert.throws(()=>f.db.artists.candidates('',101));assert.throws(()=>f.db.artists.candidates('',50,-1));
});

test('credit edits guard selected artist revisions even when a changed candidate was not previously used by the item',t=>{
  const f=fixture(t),a=f.write('one','甲'),b=f.write('two','乙'),c=f.write('three','丙');
  const candidate=f.candidate('乙','two'),target=f.candidate('丙','three');
  const request={action:'artist-credit',itemId:a.id,revision:a.catalog.revision,commandId:randomUUID(),members:[{artistId:candidate.id,artistRevision:candidate.revision,role:'performer',joinPhrase:''}]};
  link(f,candidate,target);
  assert.equal(f.db.getItem(a.id).catalog.revision,a.catalog.revision);
  assert.throws(()=>f.db.artists.edit(request),/艺人身份已变化/);assert.equal(f.db.getItem(a.id).catalog.creditConfirmed,false);
  const refreshed={...request,commandId:randomUUID(),members:[{...request.members[0],artistRevision:f.candidate('乙','two').revision}]};
  f.db.artists.edit(refreshed);assert.equal(f.db.getItem(a.id).artist,'丙');
});

test('v7 migration preserves catalog audit revisions and user references with a consistent backup',t=>{
  const f=fixture(t),a=f.write('one','甲'),b=f.write('two','甲');
  const request={action:'version',items:[{itemId:a.id,revision:a.catalog.revision}],target:{itemId:b.id,revision:b.catalog.revision},commandId:randomUUID()};
  const change=f.db.associations.link(request),item=f.db.getItem(a.id);
  f.db.user.setState({itemId:a.id,favorite:true,rating:4,baseRevision:0,commandId:randomUUID()});f.db.user.create('保留重复',randomUUID(),[a.id,a.id]);
  f.db.close();f.db=null;let raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV8(raw);
  const legacyProjection=new (require('../dist/main/library/catalog.js').CatalogRepository)(raw);
  legacyProjection.enableAssociations();legacyProjection.refreshRevision(a.id,true);
  const oldFingerprint=raw.prepare('SELECT fingerprint FROM item_catalog_state WHERE item_id=?').get(a.id).fingerprint;raw.close();
  f.db=new LibraryDatabase(f.filename);assert.equal(f.db.getItem(a.id).catalog.revision,item.catalog.revision);assert.equal(f.db.getItem(a.id).favorite,true);
  raw=new DatabaseSync(f.filename);assert.notEqual(raw.prepare('SELECT fingerprint FROM item_catalog_state WHERE item_id=?').get(a.id).fingerprint,oldFingerprint);raw.close();
  assert.equal(f.db.user.playlists()[0].count,2);assert.deepEqual(f.db.associations.link(request),change);
  f.db.undoCatalog(change.changeId,randomUUID());assert.equal(f.db.getItem(a.id).catalog.confirmed,false);
  const backups=fs.readdirSync(f.dir).filter(name=>name.includes('.pre-v8-'));assert.equal(backups.length,1);
  raw=new DatabaseSync(path.join(f.dir,backups[0]));assert.equal(raw.prepare('PRAGMA user_version').get().user_version,7);assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');raw.close();
});

test('v8 migration failure rolls back identity tables and retains a usable v7 backup',t=>{
  const f=fixture(t),a=f.write('one','甲');f.db.close();f.db=null;
  let raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV8(raw);raw.exec('CREATE TABLE item_credit_binding(extension TEXT)');raw.close();
  assert.throws(()=>new LibraryDatabase(f.filename),/already exists/);
  raw=new DatabaseSync(f.filename);assert.equal(raw.prepare('PRAGMA user_version').get().user_version,7);
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='artist_identity_binding'").get(),undefined);assert.equal(raw.prepare('SELECT artist FROM playable_item WHERE id=?').get(a.id).artist,'甲');raw.close();
  assert.equal(fs.readdirSync(f.dir).filter(name=>name.includes('.pre-v8-')).length,1);
});
