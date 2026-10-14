const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {LibraryDatabase}=require('../dist/main/library/database.js');
const {normalizedReleaseFields}=require('../dist/main/library/release-profiles.js');
const fields={title:'人工发行',date:'2024-02',country:'CN',label:'唱片公司',catalogNumber:'CAT-001',barcode:'0001234567890',edition:'重制版',albumArtists:[]};
const ref=r=>({releaseId:r.releaseId,revision:r.revision,fingerprint:r.fingerprint});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aural-release-profiles-')),f={dir,filename:path.join(dir,'library.db')};f.db=new LibraryDatabase(f.filename);
 f.write=(folder,name,options={})=>{const root=f.db.addRoot(path.join(dir,folder)),fileId=f.db.upsertFile(root,{relativePath:name+'.flac',size:1,mtimeMs:1,title:name,artist:'曲目歌手',album:'扫描专辑',genre:'Jazz',durationSeconds:60,codec:'FLAC',sampleRate:44100,bitsPerSample:16,trackNumber:1,discNumber:1,catalog:{albumArtists:['原专辑艺人'],albumArtist:'原专辑艺人',date:'2020',label:'原发行公司'},...options},1);return f.db.list({view:'all'}).items.find(item=>item.fileId===fileId);};
 f.artist=(name)=>{const change=f.db.profiles.edit({action:'artist-create',fields:{name,sortName:'',disambiguation:'专辑演出',references:[]},commandId:randomUUID()});return f.db.profiles.profile(change.artistId);};
 f.summary=item=>f.db.releases.summary(f.db.getItem(item.id).catalog.releaseId);
 f.request=(item,overrides={})=>({release:ref(f.summary(item)),fields:{...fields,...overrides},commandId:randomUUID()});
 t.after(()=>{f.db?.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});return f;
}
test('release fields and ordered album credits update all versions, preserve identities and user references, rescan and replay across restart',t=>{
 const f=fixture(t),a=f.write('one','甲'),v=f.write('two','甲副本'),b=f.write('one','乙',{trackNumber:2}),artist=f.artist('发行演出者'),guest=f.artist('合作乐团');
 f.db.associations.link({action:'version',items:[{itemId:v.id,revision:v.catalog.revision}],target:{itemId:a.id,revision:a.catalog.revision},commandId:randomUUID()});
 const before=f.db.getItems([a.id,v.id,b.id]);f.db.user.setState({itemId:a.id,favorite:true,rating:4,baseRevision:0,commandId:randomUUID()});f.db.user.create('重复',randomUUID(),[a.id,v.id,a.id]);
 const queue=new (require('../dist/main/main/queue.js').PlaybackQueue)();queue.start(a.id,[a.id,v.id,a.id]);f.db.saveQueue(queue.snapshot(),0);
 const request=f.request(a,{albumArtists:[{artistId:artist.artistId,artistRevision:artist.revision,joinPhrase:' & '},{artistId:guest.artistId,artistRevision:guest.revision,joinPhrase:''}]}),result=f.db.releaseProfiles.edit(request),after=f.db.getItems([a.id,v.id,b.id]);
 assert.equal(result.items.length,3);after.forEach((item,index)=>{assert.equal(item.fileId,before[index].fileId);for(const key of ['recordingId','releaseTrackId','releaseId'])assert.equal(item.catalog[key],before[index].catalog[key]);assert.equal(item.artist,before[index].artist);assert.equal(item.catalog.releaseTitle,fields.title);assert.equal(item.catalog.releaseLabel,fields.label);assert.equal(item.catalog.catalogNumber,fields.catalogNumber);assert.equal(item.catalog.barcode,fields.barcode);assert.equal(item.catalog.albumArtist,'发行演出者 & 合作乐团');assert.equal(item.catalog.releaseProfileConfirmed,true);assert.ok(item.catalog.revision>before[index].catalog.revision);});
 assert.equal(f.db.getItem(a.id).favorite,true);assert.equal(f.db.user.playlists()[0].count,3);assert.deepEqual(f.db.loadQueue(),queue.snapshot());assert.equal(f.db.list({view:'all',query:'人工发行'}).total,3);assert.equal(f.db.list({view:'artists',facetId:artist.artistId,artistRole:'album_artist'}).total,3);
 assert.deepEqual(f.db.releaseProfiles.edit({...request,fields:{...request.fields,title:' 人工发行 '}}),result);assert.throws(()=>f.db.releaseProfiles.edit({...request,fields:{...request.fields,title:'其他'}}),/不同操作/);
 f.write('one','甲',{mtimeMs:2});assert.equal(f.summary(a).title,fields.title);assert.equal(f.summary(a).label,fields.label);
 f.db.close();f.db=new LibraryDatabase(f.filename);assert.deepEqual(f.db.releaseProfiles.edit(request),result);f.db.undoCatalog(result.changeId,randomUUID());assert.equal(f.summary(a).title,'扫描专辑');assert.equal(f.summary(a).albumArtist,'原专辑艺人');assert.equal(f.summary(a).profileConfirmed,false);assert.equal(f.db.getItem(a.id).favorite,true);
});
test('date validation preserves precision and rejects invalid calendar dates, controls, duplicate credits and final connectors atomically',t=>{
 for(const date of ['2024','2024-02','2024-02-29','2000-02-29','0001-01-01',''])assert.equal(normalizedReleaseFields({...fields,date}).date,date);
 for(const date of ['0000','2024-00','2024-13','2023-02-29','1900-02-29','2024-04-31','2024-01-00','24','2024-2','2024-02-03T00:00Z'])assert.throws(()=>normalizedReleaseFields({...fields,date}),/日期/);
 const f=fixture(t),a=f.write('one','甲'),artist=f.artist('人物'),before=f.summary(a),history=f.db.catalogChanges().total;
 for(const overrides of [{label:'bad\nlabel'},{title:''},{albumArtists:[{artistId:artist.artistId,artistRevision:0,joinPhrase:' & '}]},{albumArtists:[{artistId:artist.artistId,artistRevision:0,joinPhrase:''},{artistId:artist.artistId,artistRevision:0,joinPhrase:''}]}])assert.throws(()=>f.db.releaseProfiles.edit(f.request(a,overrides)));
 assert.deepEqual(f.summary(a),before);assert.equal(f.db.catalogChanges().total,history);
});
test('two source IDs that resolve to the same album identity cannot create duplicate credits',t=>{
 const f=fixture(t),a=f.write('one','甲'),artist=f.artist('统一专辑艺人'),source=f.summary(a).albumArtists[0];
 f.db.artists.edit({action:'artist-link',sources:[{artistId:source.sourceArtistId,revision:source.artistRevision}],target:{artistId:artist.artistId,revision:artist.revision},commandId:randomUUID()});
 const linked=f.summary(a).albumArtists[0],before=f.summary(a);
 assert.throws(()=>f.db.releaseProfiles.edit(f.request(a,{albumArtists:[{artistId:linked.sourceArtistId,artistRevision:linked.artistRevision,joinPhrase:'、'},{artistId:artist.artistId,artistRevision:artist.revision,joinPhrase:''}]})),/同一专辑艺人身份重复/);assert.deepEqual(f.summary(a),before);
});
test('edited empty release fingerprints include album identity revisions despite having no item members',t=>{
 const f=fixture(t),a=f.write('one','甲'),b=f.write('two','乙'),artist=f.artist('空发行艺人'),source=f.summary(a),target=f.summary(b);
 f.db.releases.edit({action:'release-merge',target:ref(target),sources:[ref(source)],discMap:[{releaseId:source.releaseId,sourceDisc:1,targetDisc:1},{releaseId:target.releaseId,sourceDisc:1,targetDisc:2}],commandId:randomUUID()});
 const empty=f.db.releases.summary(source.releaseId);assert.equal(empty.fileCount,0);
 const change=f.db.releaseProfiles.edit({release:ref(empty),fields:{...fields,albumArtists:[{artistId:artist.artistId,artistRevision:artist.revision,joinPhrase:''}]},commandId:randomUUID()});const edited=f.db.releases.summary(source.releaseId);
 f.db.profiles.edit({action:'artist-profile',artist:f.db.profiles.profile(artist.artistId),fields:{name:'空发行更名',sortName:'',disambiguation:'',references:[]},commandId:randomUUID()});
 const updated=f.db.releases.summary(source.releaseId);assert.equal(updated.revision,edited.revision);assert.notEqual(updated.fingerprint,edited.fingerprint);assert.equal(updated.albumArtist,'空发行更名');assert.throws(()=>f.db.undoCatalog(change.changeId,randomUUID()),/成员已变化/);
});
test('membership, selected artist changes and profile changes reject stale previews and undo; removed hidden/offline members still participate',t=>{
 const f=fixture(t),a=f.write('one','甲'),artist=f.artist('人物'),stale=f.request(a);
 f.write('one','乙',{trackNumber:2});assert.throws(()=>f.db.releaseProfiles.edit(stale),/成员已变化/);
 const artistStale=f.request(a,{albumArtists:[{artistId:artist.artistId,artistRevision:artist.revision,joinPhrase:''}]});f.db.profiles.edit({action:'artist-profile',artist,fields:{name:'人物更名',sortName:'',disambiguation:'',references:[]},commandId:randomUUID()});assert.throws(()=>f.db.releaseProfiles.edit(artistStale),/专辑艺人已变化/);
 const request=f.request(a),change=f.db.releaseProfiles.edit(request);assert.throws(()=>f.db.releaseProfiles.edit({...request,commandId:randomUUID()}),/成员已变化/);
 const raw=new DatabaseSync(f.filename);raw.prepare("UPDATE media_file SET status='missing' WHERE id=?").run(a.fileId);raw.prepare('UPDATE playable_item SET visible=0 WHERE id=?').run(a.id);raw.close();f.db.catalog.refreshRevision(a.id);assert.throws(()=>f.db.undoCatalog(change.changeId,randomUUID()),/成员已变化/);
 assert.equal(f.summary(a).fileCount,2);
});
test('manual album identity rename invalidates profile undo and updates browse; archived historical album credit cannot be restored',t=>{
 const f=fixture(t),a=f.write('one','甲'),artist=f.artist('专辑人物');let change=f.db.releaseProfiles.edit(f.request(a,{albumArtists:[{artistId:artist.artistId,artistRevision:artist.revision,joinPhrase:''}]}));
 const profile=f.db.profiles.profile(artist.artistId);f.db.profiles.edit({action:'artist-profile',artist:profile,fields:{name:'更名人物',sortName:'',disambiguation:'',references:[]},commandId:randomUUID()});assert.equal(f.summary(a).albumArtist,'更名人物');assert.throws(()=>f.db.undoCatalog(change.changeId,randomUUID()),/成员已变化/);
 change=f.db.releaseProfiles.edit(f.request(a));const unused=f.db.profiles.profile(artist.artistId),archive=f.db.profiles.edit({action:'artist-archive',artist:unused,commandId:randomUUID()});assert.throws(()=>f.db.undoCatalog(change.changeId,randomUUID()),/归档/);assert.equal(f.summary(a).albumArtists.length,0);
 f.db.undoCatalog(archive.changeId,randomUUID());f.db.undoCatalog(change.changeId,randomUUID());assert.equal(f.summary(a).albumArtist,'更名人物');
});
test('release merge/split carry edited full fields and credits; later membership move prevents profile undo',t=>{
 const f=fixture(t),a=f.write('one','甲'),b=f.write('one','乙',{trackNumber:2}),c=f.write('two','丙'),artist=f.artist('演出');const change=f.db.releaseProfiles.edit(f.request(a,{albumArtists:[{artistId:artist.artistId,artistRevision:0,joinPhrase:''}]}));
 const source=f.summary(a);f.db.releases.edit({action:'release-split',source:ref(source),trackIds:[f.db.getItem(a.id).catalog.releaseTrackId],fields:{title:'拆分版',date:'2024',country:'CN',edition:'精选'},commandId:randomUUID()});assert.equal(f.summary(a).label,fields.label);assert.equal(f.summary(a).catalogNumber,fields.catalogNumber);assert.equal(f.summary(a).albumArtist,'演出');assert.throws(()=>f.db.undoCatalog(change.changeId,randomUUID()),/成员已变化/);
 const target=f.summary(b),other=f.summary(c);f.db.releases.edit({action:'release-merge',target:ref(target),sources:[ref(other)],discMap:[{releaseId:target.releaseId,sourceDisc:1,targetDisc:1},{releaseId:other.releaseId,sourceDisc:1,targetDisc:2}],commandId:randomUUID()});assert.equal(f.summary(c).label,fields.label);assert.equal(f.summary(c).albumArtist,'演出');
});
test('late search failure rolls back fields, credit rows, projections, state, audit and receipt',t=>{
 const f=fixture(t),a=f.write('one','甲'),b=f.write('one','乙'),before=f.summary(a),raw=new DatabaseSync(f.filename),counts=raw.prepare('SELECT (SELECT COUNT(*) FROM artist_credit) c,(SELECT COUNT(*) FROM user_command_receipt) r').get();
 raw.exec(`CREATE TRIGGER reject_release_search BEFORE INSERT ON search_gram WHEN NEW.item_id='${b.id}' BEGIN SELECT RAISE(ABORT,'injected search failure');END;`);raw.close();const request=f.request(a);assert.throws(()=>f.db.releaseProfiles.edit(request),/injected/);assert.deepEqual(f.summary(a),before);
 const verify=new DatabaseSync(f.filename);assert.deepEqual(verify.prepare('SELECT (SELECT COUNT(*) FROM artist_credit) c,(SELECT COUNT(*) FROM user_command_receipt) r').get(),counts);assert.equal(verify.prepare('SELECT COUNT(*) n FROM release_profile_change').get().n,0);assert.equal(verify.prepare('SELECT COUNT(*) n FROM release_profile_state').get().n,0);verify.exec('DROP TRIGGER reject_release_search');verify.close();assert.ok(f.db.releaseProfiles.edit(request).changeId);
});
test('v10 migration preserves old profile and release audit undo; v10 backup is intact and conflicting DDL rolls back',t=>{
 const f=fixture(t),a=f.write('one','甲'),b=f.write('two','乙'),c=f.write('three','丙'),artist=f.artist('人物');
 const source=f.summary(a),target=f.summary(b),merge=f.db.releases.edit({action:'release-merge',target:ref(target),sources:[ref(source)],discMap:[{releaseId:source.releaseId,sourceDisc:1,targetDisc:1},{releaseId:target.releaseId,sourceDisc:1,targetDisc:2}],commandId:randomUUID()});
 f.db.artists.edit({action:'artist-credit',itemId:c.id,revision:c.catalog.revision,members:[{artistId:artist.artistId,artistRevision:artist.revision,role:'performer',joinPhrase:''}],commandId:randomUUID()});
 const current=f.db.profiles.profile(artist.artistId),profile=f.db.profiles.edit({action:'artist-profile',artist:current,fields:{name:'人物更名',sortName:'',disambiguation:'',references:[]},commandId:randomUUID()}),revisions=f.db.getItems([a.id,b.id,c.id]).map(i=>i.catalog.revision);
 f.db.close();f.db=null;let raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV11(raw);const catalog=new (require('../dist/main/library/catalog.js').CatalogRepository)(raw);catalog.enableAssociations();catalog.enableArtists();catalog.enableReleases();catalog.enableProfiles();for(const item of [a,b,c])catalog.refreshRevision(item.id,true);raw.close();
 f.db=new LibraryDatabase(f.filename);assert.deepEqual(f.db.getItems([a.id,b.id,c.id]).map(i=>i.catalog.revision),revisions);f.db.undoCatalog(profile.changeId,randomUUID());f.db.undoCatalog(merge.changeId,randomUUID());assert.equal(f.db.getItem(a.id).catalog.releaseId,a.catalog.releaseId);
 const backup=fs.readdirSync(f.dir).find(name=>name.includes('pre-v11'));raw=new DatabaseSync(path.join(f.dir,backup));assert.equal(raw.prepare('PRAGMA user_version').get().user_version,10);assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');raw.close();
 f.db.close();f.db=null;raw=new DatabaseSync(f.filename);require('./legacy-schema.cjs').stripV11(raw);raw.exec('CREATE TABLE release_profile_change(extension TEXT)');raw.close();assert.throws(()=>new LibraryDatabase(f.filename),/already exists/);raw=new DatabaseSync(f.filename);assert.equal(raw.prepare('PRAGMA user_version').get().user_version,10);assert.equal(raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='release_profile_state'").get().n,0);assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');raw.close();
});
