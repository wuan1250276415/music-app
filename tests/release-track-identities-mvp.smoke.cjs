const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {LibraryDatabase}=require('../dist/main/library/database.js');
const {artistProfileSchema}=require('../dist/main/library/artist-profiles.js');
const {entityReferenceSchema}=require('../dist/main/library/entity-references.js');
const {readLibrarySchema}=require('../dist/main/library/schema-snapshot.js');
const {migrateReleaseTrackReferences,referenceMigrationFingerprint}=require('../dist/main/library/release-track-references-migration.js');
const {readMetadataIdentityPreview,readMetadataIdentityApply}=require('../dist/main/shared/metadata-identities.js');
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
const sha=v=>createHash('sha256').update(v).digest('hex');

async function main(){
 const parent=path.resolve('D:/CodexTestData');fs.mkdirSync(parent,{recursive:true});
 const scratch=fs.mkdtempSync(path.join(parent,'aural-release-track-mvp-')),filename=path.join(scratch,'library.db');
 const report={version:require('../package.json').version,completed:false,scope:'production SQLite/identity repositories; complete legacy schema74 reference-table fixture and source-context fixture; no actual old installer, network truth or audio hardware proof',cases:[]};
 let db=new LibraryDatabase(filename);
 const root=db.addRoot(path.join(scratch,'music'));
 const write=(n,album)=>{db.upsertFile(root,{relativePath:n+'.flac',size:1,mtimeMs:1,title:'曲目'+n,artist:'歌手',album,genre:'Jazz',durationSeconds:180,codec:'FLAC',sampleRate:44100,bitsPerSample:16,trackNumber:Number(n),discNumber:1},1);return db.list({view:'all'}).items.find(i=>i.path.endsWith(n+'.flac'));};
 const item=i=>db.getItem(i.id),refs=(kind,entityId)=>db.references.get(kind,entityId);
 const edit=(kind,entityId,references)=>db.references.edit({commandId:randomUUID(),entity:refs(kind,entityId),references});
 const ok=(name,fn)=>{fn();report.cases.push(name);};
 try{
  const legacy=write('1','已有专辑');
  const legacyCommand={commandId:randomUUID(),entity:refs('recording',legacy.catalog.recordingId),references:[{provider:'musicbrainz',externalId:id(801),url:null}]};
  const legacyResult=db.references.edit(legacyCommand);
  const externalSql=artistProfileSchema.slice(artistProfileSchema.indexOf('CREATE TABLE external_ref'),artistProfileSchema.indexOf('CREATE TRIGGER artist_identity_active_insert'));
  const stateSql=entityReferenceSchema.slice(0,entityReferenceSchema.indexOf('CREATE TABLE entity_reference_change'));
  // Rebuild exact historical definitions, not just a misleading user_version downgrade.
  db.db.exec(`BEGIN IMMEDIATE;CREATE TEMP TABLE fixture_old_refs AS SELECT * FROM external_ref;
   CREATE TEMP TABLE fixture_old_state AS SELECT * FROM entity_reference_state;
   DROP TRIGGER track_reference_delete;DROP TABLE external_ref;${externalSql}
   INSERT INTO external_ref SELECT * FROM fixture_old_refs;
   DROP TABLE entity_reference_state;${stateSql}INSERT INTO entity_reference_state SELECT * FROM fixture_old_state;
   DROP TABLE fixture_old_refs;DROP TABLE fixture_old_state;PRAGMA user_version=74;COMMIT;`);
  const beforeRefs=referenceMigrationFingerprint(db.db),beforeSchema=readLibrarySchema(db.db);
  db.close();db=null;
  const raw=new DatabaseSync(filename);raw.exec('PRAGMA foreign_keys=ON');
  try{
   ok('schema74 fixture uses the actual old closed reference definitions and retains previous audit/receipt',()=>{assert.equal(raw.prepare('PRAGMA user_version').get().user_version,74);assert.ok(!raw.prepare("SELECT sql FROM sqlite_schema WHERE name='external_ref'").get().sql.includes("'release_track'"));assert.equal(referenceMigrationFingerprint(raw),beforeRefs);});
   ok('migration rejects unowned calls and rolls back a late table/trigger replacement fault',()=>{assert.throws(()=>migrateReleaseTrackReferences(raw),/迁移事务/);raw.exec('BEGIN IMMEDIATE');const port={isTransaction:true,prepare:raw.prepare.bind(raw),exec(sql){raw.exec(sql);if(sql.includes('DROP TABLE main.entity_reference_state'))throw new Error('late schema75 fault');}};assert.throws(()=>migrateReleaseTrackReferences(port),/late schema75 fault/);raw.exec('ROLLBACK');assert.equal(raw.prepare('PRAGMA user_version').get().user_version,74);assert.deepEqual(readLibrarySchema(raw),beforeSchema);assert.equal(referenceMigrationFingerprint(raw),beforeRefs);});
  }finally{raw.close();}
  db=new LibraryDatabase(filename);
  ok('normal startup upgrades74to75 with exactly one verified74 snapshot and preserves every reference/audit/receipt',()=>{
   assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,75);
   assert.equal(referenceMigrationFingerprint(db.db),beforeRefs);
   const snapshots=fs.readdirSync(scratch).filter(n=>n.startsWith('library.db.pre-v75-')&&n.endsWith('.bak'));assert.equal(snapshots.length,1);
   const saved=new DatabaseSync(path.join(scratch,snapshots[0]),{readOnly:true});saved.function('aural_cue_path_key_v1',{deterministic:true},value=>require('../dist/main/library/cue-history.js').cuePathKey(value));try{assert.equal(saved.prepare('PRAGMA user_version').get().user_version,74);assert.deepEqual(readLibrarySchema(saved),beforeSchema);assert.equal(referenceMigrationFingerprint(saved),beforeRefs);assert.equal(saved.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{saved.close();}
   assert.deepEqual(db.references.edit(legacyCommand),legacyResult);
   report.upgradeSnapshots=snapshots;
  });
  db.close();db=new LibraryDatabase(filename);
  ok('schema75 reopen is idempotent and does not manufacture another upgrade snapshot',()=>{assert.equal(fs.readdirSync(scratch).filter(n=>n.startsWith('library.db.pre-v75-')).length,1);assert.equal(referenceMigrationFingerprint(db.db),beforeRefs);});

  let a=write('2','发行曲目专辑'),b=write('3','发行曲目专辑'),version=write('4','发行曲目专辑');
  db.associations.link({action:'version',commandId:randomUUID(),items:[{itemId:version.id,revision:version.catalog.revision}],target:{itemId:a.id,revision:a.catalog.revision}});
  a=item(a);b=item(b);version=item(version);
  const source={releaseId:id(610),title:'来源发行版',date:null,country:null,status:null,disambiguation:null,barcode:null,group:null,artists:[],labels:[],media:[{position:1,format:'CD',title:null,trackCount:2,trackListComplete:true,additionalTracksUnreviewed:false,tracks:[{id:id(620),position:1,number:'A-01',title:'发行曲目显示1',recordingId:id(630),recordingTitle:'正式录音1',lengthMs:180000},{id:id(621),position:2,number:'A-02',title:'发行曲目显示2',recordingId:id(631),recordingTitle:'正式录音2',lengthMs:180000}]}]};
  const mint=(context=source,items=[a,b])=>{const current=item(items[0]),review=db.metadataAlbums.review({itemId:current.id,releaseId:current.catalog.releaseId,itemFingerprint:db.metadataReviewFingerprint(current.id),candidateToken:id(700),requestId:randomUUID(),recordingId:context.media[0].tracks[0].recordingId,context,fetchedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});return {reviewToken:review.reviewToken,requestId:randomUUID(),includeReleaseTracks:true,mappings:items.map((i,n)=>({itemId:i.id,trackId:context.media[0].tracks[n].id}))};};
  const preview=(request=mint())=>db.metadataIdentities.preview(request,()=>true);
  const apply=(p,targets=p.targets.filter(t=>t.status==='ready'))=>({commandId:randomUUID(),previewToken:p.previewToken,targets:targets.map(t=>({key:t.key,mode:'add'})),confirmedRecordingScope:true,confirmedReleaseScope:true,confirmedReleaseTrackScope:true});
  const p=preview(),tracks=p.targets.filter(t=>t.kind==='release_track');
  ok('track targets are separate from recording IDs and include all local file versions and printed source numbers',()=>{assert.equal(tracks.length,2);assert.equal(p.targets.length,5);const t=tracks.find(t=>t.entityId===a.catalog.releaseTrackId);assert.equal(t.affectedItems,2);assert.equal(t.affectedReleases,1);assert.equal(t.sourceId,id(620));assert.equal(t.sourceUrl,'https://musicbrainz.org/track/'+id(620));assert.ok(t.positions.some(v=>v.includes('A-01')));assert.notEqual(t.sourceId,p.targets.find(t=>t.kind==='recording'&&t.entityId===a.catalog.recordingId).sourceId);});
  ok('closed readers reject forged track context and wrong optional booleans while retaining old receipt tuple',()=>{assert.throws(()=>readMetadataIdentityPreview({...mint(),includeReleaseTracks:'yes'}));assert.throws(()=>readMetadataIdentityApply({...apply(p),trackContext:{releaseId:id(999)}}));assert.throws(()=>readMetadataIdentityApply({...apply(p),confirmedReleaseTrackScope:'yes'}));const old=apply(p);delete old.confirmedReleaseTrackScope;assert.ok(!Object.hasOwn(readMetadataIdentityApply(old),'confirmedReleaseTrackScope'));assert.throws(()=>db.metadataIdentities.apply(old,()=>true),/发行曲目/);assert.ok(tracks.every(t=>refs(t.kind,t.entityId).references.length===0));});
  ok('a second track audit fault rolls back earlier references, entity audits and aggregate receipt',()=>{
   const request=apply(p),before=referenceMigrationFingerprint(db.db);
   db.db.exec("CREATE TEMP TRIGGER track_late_fault BEFORE INSERT ON entity_reference_change WHEN json_extract(NEW.after_json,'$.entity.kind')='release_track' AND (SELECT COUNT(*) FROM external_ref WHERE entity_kind='release_track')>1 BEGIN SELECT RAISE(ABORT,'second track audit fault');END;");
   try{assert.throws(()=>db.metadataIdentities.apply(request,()=>true),/second track audit fault/);}finally{db.db.exec('DROP TRIGGER track_late_fault');}
   assert.equal(referenceMigrationFingerprint(db.db),before);assert.equal(db.metadataIdentities.receipt(request),null);
  });
  const current=preview(),request=apply(current),beforeItems=sha(JSON.stringify([a,b,version].map(item))),result=db.metadataIdentities.apply(request,()=>true);
  ok('recording/release/two-track acceptance retains local graph/text and saves typed source context per track',()=>{
   assert.equal(result.changes.length,5);assert.equal(sha(JSON.stringify([a,b,version].map(item))),beforeItems);
   const change=result.changes.find(c=>c.kind==='release_track'&&c.entityId===a.catalog.releaseTrackId),audit=JSON.parse(db.db.prepare('SELECT after_json FROM entity_reference_change WHERE id=?').get(change.changeId).after_json);
   assert.deepEqual(audit.onlineIdentity.trackContext,{releaseId:id(610),recordingId:id(630),discNumber:1,position:1,printedNumber:'A-01',groupId:null});
   assert.equal(refs('release_track',a.catalog.releaseTrackId).references[0].externalId,id(620));assert.equal(db.references.identityUndoPreview(change.changeId).kind,'release_track');
   assert.throws(()=>db.db.prepare("INSERT INTO external_ref VALUES('release_track',?,'musicbrainz',?,?)").run(id(999),id(998),'https://musicbrainz.org/track/'+id(998)),/invalid external entity/);
   assert.throws(()=>db.db.prepare('DELETE FROM release_track WHERE id=?').run(a.catalog.releaseTrackId),/发行曲目引用身份必须保留/);
  });
  db.close();db=new LibraryDatabase(filename);
  ok('offline restart replays the same aggregate command and independent track undo preserves recording/release and other track',()=>{
   assert.deepEqual(db.metadataIdentities.apply(request,()=>false),result);const c=result.changes.find(c=>c.kind==='release_track'&&c.entityId===a.catalog.releaseTrackId);db.undoCatalog(c.changeId,randomUUID());assert.equal(db.references.identityUndoPreview(c.changeId).status,'undone');assert.equal(refs('release_track',a.catalog.releaseTrackId).references.length,0);assert.equal(refs('release_track',b.catalog.releaseTrackId).references[0].externalId,id(621));assert.equal(refs('recording',a.catalog.recordingId).references[0].externalId,id(630));assert.equal(refs('release',a.catalog.releaseId).references[0].externalId,id(610));
  });
  ok('track-only replacement retains other providers and later manual reference edit prevents old undo',()=>{edit('release_track',a.catalog.releaseTrackId,[{provider:'discogs',externalId:'700',url:'https://www.discogs.com/release/700'},{provider:'musicbrainz',externalId:id(619),url:null}]);const p=preview(),t=p.targets.find(t=>t.kind==='release_track'&&t.entityId===a.catalog.releaseTrackId),q=apply(p,[t]);q.targets[0].mode='replace-musicbrainz';q.confirmedRecordingScope=false;q.confirmedReleaseScope=false;const value=db.metadataIdentities.apply(q,()=>true),entity=refs(t.kind,t.entityId);assert.deepEqual(entity.references.filter(r=>r.provider==='musicbrainz').map(r=>r.externalId),[id(620)]);assert.ok(entity.references.some(r=>r.provider==='discogs'));edit(t.kind,t.entityId,[...entity.references,{provider:'discogs',externalId:'701',url:'https://www.discogs.com/release/701'}]);assert.equal(db.references.identityUndoPreview(value.changes[0].changeId).status,'conflict');});
  ok('foreign track ownership gained after review rejects all selected tracks without overwriting prior sources',()=>{const x=write('5','另一专辑'),y=write('6','另一专辑'),foreign=write('7','外部归属');const context=structuredClone(source);context.releaseId=id(710);context.media[0].tracks[0].id=id(720);context.media[0].tracks[1].id=id(721);context.media[0].tracks[0].recordingId=id(730);context.media[0].tracks[1].recordingId=id(731);const p=preview(mint(context,[x,y])),ts=p.targets.filter(t=>t.kind==='release_track');edit('release_track',foreign.catalog.releaseTrackId,[{provider:'musicbrainz',externalId:id(721),url:null}]);assert.throws(()=>db.metadataIdentities.apply(apply(p,ts),()=>true),/已属于/);assert.equal(refs('release_track',x.catalog.releaseTrackId).references.length,0);});
  ok('medium disc/format changes invalidate the same track reference snapshot even when its medium ID is unchanged',()=>{const entity=refs('release_track',a.catalog.releaseTrackId),medium=db.db.prepare('SELECT medium_id FROM release_track WHERE id=?').get(a.catalog.releaseTrackId).medium_id;db.db.prepare('UPDATE medium SET disc_no=2 WHERE id=?').run(medium);assert.notEqual(refs(entity.kind,entity.entityId).fingerprint,entity.fingerprint);assert.throws(()=>db.references.edit({commandId:randomUUID(),entity,references:[...entity.references,{provider:'discogs',externalId:'702',url:null}]}),/资料、成员或引用已变化/);db.db.prepare('UPDATE medium SET disc_no=1 WHERE id=?').run(medium);});
  const folder=path.join(scratch,'backup');fs.mkdirSync(folder);const target=path.join(folder,'library.db'),captured=await db.createCatalogBackupDatabase(target,()=>{});
  assert.equal(captured.schema,75);assert.deepEqual(require('../dist/main/library/catalog-backup-database.js').inspectCatalogBackupDatabase(target),captured);
  const copy=new LibraryDatabase(target);try{assert.deepEqual(copy.metadataIdentities.receipt(request),result);assert.deepEqual(copy.references.edit(legacyCommand),legacyResult);assert.equal(referenceMigrationFingerprint(copy.db),referenceMigrationFingerprint(db.db));}finally{copy.close();}
  report.cases.push('schema75 backup inspection/reopen retain typed track contexts, all references and legacy/current receipts');
  assert.equal(db.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.db.prepare('PRAGMA foreign_key_check').all().length,0);report.cases.push('schema75 integrity and foreign keys valid after upgrade, acceptance, compensation and conflicts');
  report.fingerprints=Object.fromEntries(['src/library/release-track-references-migration.ts','src/library/metadata-identities.ts','src/library/entity-references.ts','src/library/database.ts','src/shared/metadata-identities.ts','src/library/external-references.ts','tests/release-track-identities-mvp.smoke.cjs'].map(n=>[n,sha(fs.readFileSync(path.join(__dirname,'..',n)))]));
  report.completed=true;
 }catch(e){report.error=String(e.stack||e);throw e;}finally{db?.close();if(process.env.AURAL_TRACK_IDENTITIES_MVP_REPORT)fs.writeFileSync(process.env.AURAL_TRACK_IDENTITIES_MVP_REPORT,JSON.stringify(report,null,2));if(report.completed&&path.dirname(scratch)===parent&&fs.realpathSync(scratch)===scratch&&path.basename(scratch).startsWith('aural-release-track-mvp-'))fs.rmSync(scratch,{recursive:true,force:true});console.log(JSON.stringify(report));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
