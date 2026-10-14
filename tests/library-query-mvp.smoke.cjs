// Focused production-query MVP. Synthetic catalog records, not physical scans.
// Compare bucket pagination with a full relational sort, then independently
// assert genre membership and user-state outcomes from the fixture manifest.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {LibraryDatabase}=require('../dist/main/library/database.js');
const {libraryQueryPlan}=require('../dist/main/library/library-query-plan.js');
const {ensureGenre}=require('../dist/main/library/genres.js');
const {musicFilterTimeAnchor}=require('../dist/main/shared/music-filters.js');
function main(){
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-query-mvp-'));let db;
 const report={appVersion:require('../package.json').version,scope:'synthetic production query semantics; no media scan, hardware or scale certification',comparisons:0,assertions:[],completed:false};
 const save=()=>{if(process.env.AURAL_QUERY_REPORT)fs.writeFileSync(path.resolve(process.env.AURAL_QUERY_REPORT),JSON.stringify(report,null,2)+'\n');};
 try{
  db=new LibraryDatabase(path.join(scratch,'library.db'));const root=db.addRoot(path.join(scratch,'music')),records=[];
  const write=(i,relativePath)=>{const album=Math.floor(i/12),genres=i%3===0?['Rock','Jazz']:i%3===1?['Rock']:['Jazz'];
   const file={relativePath:relativePath||`group-${album}/song-${i}.flac`,size:4096,mtimeMs:1,durationSeconds:180,codec:'FLAC',sampleRate:i%2?48000:44100,bitsPerSample:i%3?24:16,trackNumber:1+i%6,discNumber:1+Math.floor((i%12)/6),title:i%4===0?'星河 2':`星河 ${i%5===0?String(48-i).padStart(3,'0'):48-i}`,artist:'周杰伦',album:album<2?'同名专辑':`旅途 ${album}`,genre:genres.join('、'),catalog:{artists:i%7===0?['周杰伦','合作者']:['周杰伦'],albumArtists:['专辑艺人'],genres,date:['2020','2020-07','2022-12-01','未知'][album]}};
   const fileId=db.upsertFile(root,file,1),id=db.db.prepare('SELECT id FROM playable_item WHERE file_id=?').get(fileId).id;return {i,id,fileId,file,genres:new Set(genres)};
  };
  for(let i=0;i<48;i++)records.push(write(i));const version=write(0,'group-0/version.flac');records.push(version);
  const ref=id=>{const item=db.getItem(id);return {itemId:id,revision:item.catalog.revision};};
  db.associations.link({action:'version',commandId:randomUUID(),items:[ref(version.id)],target:ref(records[0].id)});
  assert.equal(db.getItem(version.id).catalog.releaseTrackId,db.getItem(records[0].id).catalog.releaseTrackId);
  const parent=db.genres.edit({action:'genre-create',commandId:randomUUID(),name:'测试分类',parent:null}).genreId;
  const rock=ensureGenre(db.db,'Rock').id,jazz=ensureGenre(db.db,'Jazz').id,electronic=ensureGenre(db.db,'Electronic').id;
  for(const [id,name] of [[rock,'摇滚'],[jazz,'Jazz']])db.genres.edit({action:'genre-profile',commandId:randomUUID(),genre:db.genres.get(id),name,parent:db.genres.get(parent)});
  const firstRelease=db.getItem(records[0].id).catalog.releaseId;
  db.db.prepare("INSERT INTO release_genre(release_id,genre_id,source,revision) VALUES(?,?,'query-mvp',0)").run(firstRelease,electronic);
  for(const record of records)if(db.getItem(record.id).catalog.releaseId===firstRelease)record.genres.add('Electronic');
  db.db.prepare("INSERT INTO item_genre(item_id,genre_id,source,revision) VALUES(?,?,'query-mvp-duplicate',0)").run(records[0].id,rock);
  db.db.prepare("UPDATE release SET local_key='manual-release:query-mvp' WHERE id=?").run(firstRelease);
  db.db.prepare('UPDATE playable_item SET track_number=9 WHERE id=?').run(records[0].id);
  db.db.prepare("UPDATE media_file SET status='missing' WHERE id=?").run(records[27].fileId);
  db.db.prepare('UPDATE playable_item SET visible=0 WHERE id=?').run(records[47].id);
  for(const record of records.filter(record=>record.i%4===0))db.user.setState({commandId:randomUUID(),itemId:record.id,baseRevision:0,favorite:true,rating:4});
  // Legacy derived rows must use the exact old relational fallback ordering.
  db.db.prepare('DELETE FROM item_sort_key WHERE item_id=?').run(records[5].id);
  db.db.prepare("UPDATE item_sort_key SET algorithm='old-sort' WHERE item_id=?").run(records[6].id);
  const playlist=db.user.create('重复条目',randomUUID(),[records[0].id,records[0].id,records[47].id]);
  const anchor=musicFilterTimeAnchor(),reference=(request,offset,limit)=>{
   const p=libraryQueryPlan(db.db,db.catalog,request,undefined,anchor,'items');
   const total=db.db.prepare(`${p.cte}SELECT COUNT(*) count ${p.from}`).get(...p.queryParams).count;
   const params=[...p.directParams,...(p.rank?[p.q]:[]),...(p.distance?p.spelling.flatMap(hit=>[hit.id,hit.distance]):[]),...(p.collapse?[...p.params,...p.params]:p.params),limit,offset];
   const rows=db.db.prepare(`${p.cte}SELECT p.id${p.rank?`,${p.rank} search_rank`:''}${p.distance?`,${p.distance} search_distance`:''} ${p.from} ORDER BY ${p.rank?`search_rank,${p.distance?'search_distance,':''}`:''}${p.order} LIMIT ? OFFSET ?`).all(...params);
   return {total,ids:rows.map(row=>row.id)};
  };
  const scopes=[{view:'all'},{view:'recent'},{view:'folders',value:root},{view:'all',query:'星河'},{view:'all',query:'zjl'},{view:'favorites'},{view:'genres',value:'Rock'},{view:'all',genreFilter:{ids:[rock,jazz],operator:'all',descendants:false}},{view:'all',filters:{genres:{ids:[parent],operator:'any',descendants:true},available:true}},{view:'all',collapseVersions:true}];
  for(const scope of scopes)for(const sort of [{mode:'default',direction:'asc'},...['title','artist','album','date','added'].flatMap(mode=>[{mode,direction:'asc'},{mode,direction:'desc'}])])for(const offset of [0,1,6,7,19,41,48,60]){
   const request={...scope,sort},expected=reference(request,offset,7),actual=db.list({...request,offset,limit:7},anchor);assert.equal(actual.total,expected.total,JSON.stringify({request,offset}));assert.deepEqual(actual.items.map(item=>item.id),expected.ids,JSON.stringify({request,offset}));report.comparisons++;
  }
  report.assertions.push('full relational order equivalence at tied prefix boundaries, deep/empty pages, asc/desc, manual positions, missing/legacy sort keys, ranks, favorite/availability scopes and version collapse');
  // Exact totals determine the closer end. Exercise that decision around the
  // midpoint, partial last pages and empty pages against the original order.
  for(const request of [{view:'all'},{view:'all',sort:{mode:'title',direction:'desc'}},{view:'all',sort:{mode:'artist',direction:'asc'}},{view:'all',sort:{mode:'album',direction:'desc'}},{view:'all',query:'星河'},{view:'favorites'},{view:'genres',value:'Rock'},{view:'all',collapseVersions:true}]){
   const total=reference(request,0,1).total;
   for(const limit of [1,7,25,100])for(const offset of new Set([0,Math.floor(total/2),Math.floor(total/2)+1,Math.max(0,total-7),Math.max(0,total-1),total,total+1])){
    const expected=reference(request,offset,limit),actual=db.list({...request,offset,limit},anchor);
    assert.equal(actual.total,expected.total,JSON.stringify({request,offset,limit}));assert.deepEqual(actual.items.map(item=>item.id),expected.ids,JSON.stringify({request,offset,limit}));report.comparisons++;
   }
  }
  report.assertions.push('closer-end probes at exact midpoint, partial final and empty pages preserve full secondary order for page sizes 1/7/25/100');
  const active=records.filter(record=>record.i!==47),ids=rows=>rows.map(row=>row.id).sort();
  const check=(request,expected)=>{const actual=db.list({...request,limit:100},anchor);assert.equal(actual.total,expected.length,JSON.stringify(request));assert.deepEqual(ids(actual.items),ids(expected),JSON.stringify(request));};
  check({view:'genres',value:'Rock'},active.filter(record=>record.genres.has('Rock')));
  check({view:'genres',facetId:electronic},active.filter(record=>record.genres.has('Electronic')));
  check({view:'genres',facetId:parent},active.filter(record=>record.genres.has('Rock')||record.genres.has('Jazz')));
  for(const operator of ['any','all'])for(const api of ['genreFilter','filters']){
   const g={ids:[rock,electronic],operator,descendants:false},expected=active.filter(record=>operator==='all'?g.ids.every(id=>record.genres.has(id===rock?'Rock':'Electronic')):g.ids.some(id=>record.genres.has(id===rock?'Rock':'Electronic')));
   check(api==='genreFilter'?{view:'all',genreFilter:g}:{view:'all',filters:{genres:g}},expected);
  }
  check({view:'all',filters:{available:false}},[records[27]]);
  check({view:'all',filters:{favorite:true,ratingAtLeast:4}},active.filter(record=>record.i%4===0));
  check({view:'all',filters:{codecs:['flac'],pcmRates:{min:48000,max:48000},bitDepths:[24]}},active.filter(record=>record.i%2!==0&&record.i%3!==0));
  check({view:'all',filters:{years:{min:2020,max:2020}}},active.filter(record=>record.i<24));
  check({view:'all',filters:{quality:'lossless'}},active);
  check({view:'all',filters:{quality:'unknown'}},[]);
  const collaborator=db.db.prepare("SELECT id FROM artist WHERE name='合作者'").get().id,albumArtist=db.db.prepare("SELECT id FROM artist WHERE name='专辑艺人'").get().id;
  check({view:'artists',facetId:albumArtist,artistRole:'album_artist'},active);
  check({view:'all',filters:{artists:{ids:[collaborator],operator:'all',role:'performer'}}},active.filter(record=>record.i%7===0));
  db.db.prepare("INSERT INTO playback_item_stats(item_id,play_count,presented_us,estimated_us,last_played_at,last_played_basis) VALUES(?,2,180000000,0,?,'observation')").run(records[0].id,new Date(anchor).toISOString());
  check({view:'all',filters:{playCount:{min:1,max:3},lastPlayed:{mode:'within-days',days:1}}},[records[0]]);
  check({view:'all',filters:{playCount:{min:0,max:0},lastPlayed:{mode:'never'}}},active.filter(record=>record.id!==records[0].id));
  report.assertions.push('independent PCM quality/rate/depth, release-year, performer/album-artist identity and recorded/never-played statistics scopes exercise pruned joins');
  const repeated=db.list({view:'playlists',value:playlist.id,limit:100});assert.equal(repeated.total,3);assert.deepEqual(repeated.items.map(item=>item.id),[records[0].id,records[0].id,records[47].id]);assert.equal(new Set(repeated.items.map(item=>item.playlistEntryId)).size,3);
  const filtered=db.list({view:'playlists',value:playlist.id,query:'星河 2',limit:100});assert.equal(filtered.total,2);assert.deepEqual(filtered.items.map(item=>item.id),[records[0].id,records[0].id]);
  assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);
  report.assertions.push('manifest genre identities, rename alias, descendants, any/all, item plus release membership without double counting, unavailable/rated favorites and repeated playlist entry positions');
  report.completed=true;save();console.log(`Production query MVP passed: ${report.comparisons} ordered page comparisons and independent fixture membership assertions`);
 }catch(error){report.error=String(error.stack||error);save();throw error;}
 finally{db?.close();if(path.dirname(scratch)===path.resolve(os.tmpdir())&&path.basename(scratch).startsWith('aural-query-mvp-'))fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
}
try{main();}catch(error){console.error(error);process.exitCode=1;}
