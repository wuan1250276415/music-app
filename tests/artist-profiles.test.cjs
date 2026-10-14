const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{DatabaseSync}=require('node:sqlite'),{LibraryDatabase}=require('../dist/main/library/database.js');
const ref=a=>({artistId:a.artistId,revision:a.revision,fingerprint:a.fingerprint});
const fields=(name,change={})=>({name,sortName:'',disambiguation:'',references:[],...change});
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aural-profiles-')),filename=path.join(dir,'library.db'),f={dir,filename,db:new LibraryDatabase(filename)};
  f.create=(name,change={})=>{const result=f.db.profiles.edit({action:'artist-create',fields:fields(name,change),commandId:randomUUID()});return f.db.profiles.profile(result.artistId);};
  f.write=(folder,name,title='作品',mtimeMs=1)=>{const root=f.db.addRoot(path.join(dir,folder)),fileId=f.db.upsertFile(root,{relativePath:'song.flac',size:1,mtimeMs,title,artist:name,album:'专辑',genre:'Jazz',durationSeconds:60,codec:'FLAC',sampleRate:44100,bitsPerSample:16,trackNumber:1,discNumber:1,catalog:{artists:[name],albumArtists:[name]}},1);return f.db.list({view:'all'}).items.find(item=>item.fileId===fileId);};
  f.link=(item,artist)=>{const candidate=f.db.getItem(item.id).catalog.artists[0];return f.db.artists.edit({action:'artist-link',sources:[{artistId:candidate.sourceArtistId,revision:candidate.artistRevision}],target:{artistId:artist.artistId,revision:artist.revision},commandId:randomUUID()});};
  t.after(()=>{f.db?.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});return f;
}
test('independent same-name artists, sort/disambiguation, normalized multiple provider references and durable create receipts',t=>{
  const f=fixture(t),mbid=randomUUID(),request={action:'artist-create',fields:fields('同名艺人',{sortName:'Artist A',disambiguation:'古典吉他',references:[{provider:' MusicBrainz ',externalId:mbid.toUpperCase(),url:null},{provider:'custom',externalId:'local-42',url:'https://example.org/artist/42'}]}),commandId:randomUUID()};
  const result=f.db.profiles.edit(request),a=f.db.profiles.profile(result.artistId),b=f.create('同名艺人',{sortName:'Artist B',disambiguation:'电影作曲'});
  assert.notEqual(a.artistId,b.artistId);assert.equal(a.itemCount,0);assert.equal(a.aliasCount,0);
  const mb=a.references.find(r=>r.provider==='musicbrainz');assert.equal(mb.externalId,mbid);assert.equal(mb.url,`https://musicbrainz.org/artist/${mbid}`);
  assert.equal(f.db.profiles.referenceUrl(ref(a),'musicbrainz',mbid),mb.url);assert.equal(f.db.profiles.list('古典吉他').items[0].artistId,a.artistId);assert.equal(f.db.profiles.list('local-42').items[0].artistId,a.artistId);
  assert.deepEqual(f.db.profiles.list().items.map(a=>a.artistId),[a.artistId,b.artistId]);
  assert.deepEqual(f.db.profiles.edit({...request,fields:{references:[...a.references].reverse(),name:a.name,disambiguation:a.disambiguation,sortName:a.sortName}}),result);
  assert.throws(()=>f.db.profiles.edit({action:'artist-profile',artist:ref(a),fields:{...a,references:[...a.references].reverse()},commandId:randomUUID()}),/没有需要保存/);
  assert.throws(()=>f.db.profiles.edit({...request,fields:fields('其他')}),/已用于不同操作/);
  f.db.close();f.db=new LibraryDatabase(f.filename);assert.deepEqual(f.db.profiles.edit(request),result);assert.equal(f.db.profiles.list().total,2);
});
test('profile editing updates canonical and alias revisions, all roles, search and facets while preserving user identities and rescans',t=>{
  const f=fixture(t),a=f.write('one','甲'),b=f.write('two','乙'),artist=f.create('标准艺人');f.link(a,artist);f.link(b,artist);
  const before=f.db.profiles.profile(artist.artistId),old=f.db.getItem(a.id),staleCredit={action:'artist-credit',itemId:a.id,revision:old.catalog.revision,members:[{artistId:artist.artistId,artistRevision:artist.revision,role:'performer',joinPhrase:''}],commandId:randomUUID()};
  f.db.user.setState({itemId:a.id,favorite:true,rating:5,baseRevision:0,commandId:randomUUID()});f.db.user.create('重复',randomUUID(),[a.id,b.id,a.id]);
  const request={action:'artist-profile',artist:ref(before),fields:fields('规范姓名',{sortName:'New Artist',disambiguation:'演唱家',references:[{provider:'custom',externalId:'42',url:null}]}),commandId:randomUUID()},change=f.db.profiles.edit(request),edited=f.db.profiles.profile(artist.artistId);
  assert.equal(edited.itemCount,2);assert.equal(edited.aliasCount,2);assert.equal(edited.revision,before.revision+1);
  for(const item of f.db.getItems([a.id,b.id])){assert.equal(item.artist,'规范姓名');assert.equal(item.catalog.albumArtists[0].name,'规范姓名');assert.equal(item.catalog.artists[0].disambiguation,'演唱家');assert.ok(item.catalog.artists[0].artistRevision>old.catalog.artists[0].artistRevision);}
  assert.equal(f.db.list({view:'all',query:'规范姓名'}).total,2);assert.equal(f.db.facets('artists')[0].name,'规范姓名');assert.ok(f.db.facets('artists')[0].subtitle.includes('演唱家'));
  assert.equal(f.db.artists.candidates('规范姓名').items.find(c=>c.id===artist.artistId).count,2);
  assert.throws(()=>f.db.artists.edit(staleCredit),/已变化/);assert.throws(()=>f.db.profiles.edit({...request,commandId:randomUUID()}),/成员已变化/);
  assert.throws(()=>f.db.profiles.referenceUrl(ref(before),'custom','42'),/已变化/);
  f.db.undoCatalog(change.changeId,randomUUID());assert.equal(f.db.getItem(a.id).artist,'标准艺人');assert.equal(f.db.profiles.profile(artist.artistId).references.length,0);
  const now=f.db.profiles.profile(artist.artistId);f.db.profiles.edit({...request,artist:ref(now),commandId:randomUUID()});f.write('one','甲','重扫后标题',2);assert.equal(f.db.getItem(a.id).artist,'规范姓名');f.write('one','新标签','改过标题',3);
  const current=f.db.getItem(a.id);assert.equal(current.artist,'新标签');
  // A newly named raw candidate is independent. Re-link explicitly; same-name candidates are never inferred.
  f.link(current,f.db.profiles.profile(artist.artistId));assert.equal(f.db.getItem(a.id).artist,'规范姓名');assert.equal(current.fileId,a.fileId);
  assert.equal(f.db.getItem(a.id).favorite,true);assert.equal(f.db.user.playlists()[0].count,3);
});
test('membership digest rejects a newly linked candidate even when the target artist revision did not change',t=>{
  const f=fixture(t),a=f.write('one','甲'),b=f.write('two','乙'),artist=f.create('标准');f.link(a,artist);const preview=f.db.profiles.profile(artist.artistId);
  f.link(b,preview);const current=f.db.profiles.profile(artist.artistId);assert.equal(current.revision,preview.revision);assert.notEqual(current.fingerprint,preview.fingerprint);
  assert.throws(()=>f.db.profiles.edit({action:'artist-profile',artist:ref(preview),fields:fields('新名'),commandId:randomUUID()}),/成员已变化/);
  const result=f.db.profiles.edit({action:'artist-profile',artist:ref(current),fields:fields('新名'),commandId:randomUUID()}),c=f.write('three','丙');f.link(c,f.db.profiles.profile(artist.artistId));assert.throws(()=>f.db.undoCatalog(result.changeId,randomUUID()),/成员已变化/);
});
test('external ownership and malformed IDs/URLs reject atomically; archived IDs can be reclaimed but conflict blocks guarded restoration',t=>{
  const f=fixture(t),reference={provider:'musicbrainz',externalId:randomUUID(),url:null},a=f.create('甲',{references:[reference]}),b=f.create('乙');
  for(const references of [[reference],[{...reference,externalId:'invalid'}],[{...reference,url:'https://example.org/wrong'}],[{provider:'custom',externalId:'1',url:'javascript:alert(1)'}],[{provider:'custom',externalId:'1',url:'https://name:password@example.org/'}],[{provider:'custom',externalId:'1',url:'file:///C:/secret'}],[{provider:'custom',externalId:'1',url:'https://example.org'},{provider:'CUSTOM',externalId:'1',url:null}]]){
    assert.throws(()=>f.db.profiles.edit({action:'artist-profile',artist:ref(b),fields:fields('乙',{references}),commandId:randomUUID()}));assert.deepEqual(f.db.profiles.profile(b.artistId),b);
  }
  const archived=f.db.profiles.edit({action:'artist-archive',artist:ref(a),commandId:randomUUID()});assert.equal(f.db.profiles.profile(a.artistId).archived,true);
  f.db.profiles.edit({action:'artist-profile',artist:ref(b),fields:fields('乙',{references:[reference]}),commandId:randomUUID()});
  assert.throws(()=>f.db.undoCatalog(archived.changeId,randomUUID()),/已属于其他艺人/);assert.equal(f.db.profiles.profile(a.artistId).archived,true);
  assert.throws(()=>f.db.profiles.list('',101));assert.throws(()=>f.db.artistProfile(b.artistId,50,-1));
});
test('archive and create undo retain durable identities, guard current use, and prevent historical credit from reactivating an archived artist',t=>{
  const f=fixture(t),create=f.db.profiles.edit({action:'artist-create',fields:fields('未使用'),commandId:randomUUID()});f.db.undoCatalog(create.changeId,randomUUID());assert.equal(f.db.profiles.profile(create.artistId).archived,true);assert.equal(f.db.profiles.list().total,0);
  const a=f.write('one','原始歌手'),artist=f.create('人工歌手'),credit=f.db.artists.edit({action:'artist-credit',itemId:a.id,revision:a.catalog.revision,members:[{artistId:artist.artistId,artistRevision:artist.revision,role:'performer',joinPhrase:''}],commandId:randomUUID()});
  const active=f.db.profiles.profile(artist.artistId);assert.throws(()=>f.db.profiles.edit({action:'artist-archive',artist:ref(active),commandId:randomUUID()}),/仍有关联/);
  const item=f.db.getItem(a.id),reset=f.db.artists.edit({action:'credit-reset',itemId:a.id,revision:item.catalog.revision,commandId:randomUUID()});
  const archive=f.db.profiles.edit({action:'artist-archive',artist:ref(f.db.profiles.profile(artist.artistId)),commandId:randomUUID()});
  assert.throws(()=>f.db.undoCatalog(reset.changeId,randomUUID()),/已归档/);assert.equal(f.db.getItem(a.id).catalog.creditConfirmed,false);
  const undoCommand=randomUUID(),result=f.db.undoCatalog(archive.changeId,undoCommand);f.db.undoCatalog(reset.changeId,randomUUID());assert.equal(f.db.getItem(a.id).artist,'人工歌手');assert.ok(credit.changeId);
  f.db.close();f.db=new LibraryDatabase(f.filename);assert.deepEqual(f.db.undoCatalog(archive.changeId,undoCommand),result);assert.equal(f.db.getItem(a.id).artist,'人工歌手');
});
test('late revision failure rolls back names, references, aliases, search, audit and command receipt together',t=>{
  const f=fixture(t),a=f.write('one','甲'),artist=f.create('标准');f.link(a,artist);const before=f.db.profiles.profile(artist.artistId),item=f.db.getItem(a.id),request={action:'artist-profile',artist:ref(before),fields:fields('失败姓名',{references:[{provider:'custom',externalId:'9',url:null}]}),commandId:randomUUID()};
  let raw=new DatabaseSync(f.filename);raw.exec(`CREATE TRIGGER fail_profile BEFORE UPDATE ON artist_identity_state WHEN NEW.artist_id='${item.catalog.artists[0].sourceArtistId}' BEGIN SELECT RAISE(ABORT,'injected revision failure'); END;`);raw.close();
  assert.throws(()=>f.db.profiles.edit(request),/injected revision failure/);assert.deepEqual(f.db.profiles.profile(artist.artistId),before);assert.deepEqual(f.db.getItem(a.id),item);assert.equal(f.db.list({view:'all',query:'失败姓名'}).total,0);
  raw=new DatabaseSync(f.filename);assert.equal(raw.prepare('SELECT COUNT(*) n FROM user_command_receipt WHERE command_id=?').get(request.commandId).n,0);raw.exec('DROP TRIGGER fail_profile');raw.close();assert.ok(f.db.profiles.edit(request).changeId);
});
test('v9 migration preserves artist and release audit undo and user references with backup; v10 DDL failure rolls back',t=>{
  const f=fixture(t),a=f.write('one','甲'),b=f.write('two','乙'),c=f.write('three','丙'),d=f.write('four','丁');
  const source=f.db.releases.summary(a.catalog.releaseId),target=f.db.releases.summary(b.catalog.releaseId),rr=r=>({releaseId:r.releaseId,revision:r.revision,fingerprint:r.fingerprint});
  const release=f.db.releases.edit({action:'release-merge',sources:[rr(source)],target:rr(target),discMap:[{releaseId:source.releaseId,sourceDisc:1,targetDisc:2},{releaseId:target.releaseId,sourceDisc:1,targetDisc:1}],commandId:randomUUID()});
  const artist=f.db.artists.edit({action:'artist-link',sources:[{artistId:c.catalog.artists[0].sourceArtistId,revision:0}],target:{artistId:d.catalog.artists[0].sourceArtistId,revision:0},commandId:randomUUID()});
  const revisions=f.db.getItems([a.id,b.id,c.id,d.id]).map(item=>item.catalog.revision);f.db.user.create('重复',randomUUID(),[a.id,c.id,a.id]);f.db.close();f.db=null;
  let raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV10(raw);const legacy=new (require('../dist/main/library/catalog.js').CatalogRepository)(raw);legacy.enableAssociations();legacy.enableArtists();legacy.enableReleases();for(const item of [a,b,c,d])legacy.refreshRevision(item.id,true);raw.close();
  f.db=new LibraryDatabase(f.filename);assert.deepEqual(f.db.getItems([a.id,b.id,c.id,d.id]).map(item=>item.catalog.revision),revisions);assert.equal(f.db.user.playlists()[0].count,3);
  f.db.undoCatalog(release.changeId,randomUUID());f.db.undoCatalog(artist.changeId,randomUUID());assert.equal(f.db.getItem(a.id).catalog.releaseId,a.catalog.releaseId);assert.equal(f.db.getItem(c.id).artist,'丙');
  const backup=fs.readdirSync(f.dir).find(name=>name.includes('pre-v10'));raw=new DatabaseSync(path.join(f.dir,backup));assert.equal(raw.prepare('PRAGMA user_version').get().user_version,9);assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');raw.close();
  f.db.close();f.db=null;raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV10(raw);raw.exec('CREATE TABLE external_ref(extension TEXT)');raw.close();assert.throws(()=>new LibraryDatabase(f.filename),/already exists/);
  raw=new DatabaseSync(f.filename);assert.equal(raw.prepare('PRAGMA user_version').get().user_version,9);assert.equal(raw.prepare("SELECT COUNT(*) n FROM pragma_table_info('artist') WHERE name='archived'").get().n,0);assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');raw.close();
});
