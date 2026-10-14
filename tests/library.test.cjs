const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCue, resolveCueReference } = require('../dist/main/library/cue.js');
const { LibraryDatabase } = require('../dist/main/library/database.js');
const { scanRoot } = require('../dist/main/library/scanner.js');
const { parseLrc } = require('../dist/main/library/lyrics.js');
const { MusicBrainzProvider, validContact } = require('../dist/main/library/musicbrainz.js');

function makeWav(file, seconds=1) {
  const sampleRate=44100, frames=Math.round(sampleRate*seconds);
  const pcm=Buffer.alloc(frames*2);
  const header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
  header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(sampleRate*2,28);
  header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  fs.writeFileSync(file,Buffer.concat([header,pcm]));
}

test('CUE parses 75 fps indexes and rejects root escape',() => {
  const cue = parseCue('TITLE "测试专辑"\nPERFORMER "周杰伦"\nFILE "disc.wav" WAVE\n  TRACK 01 AUDIO\n    TITLE "序曲"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE "夜曲"\n    INDEX 00 00:00:29\n    INDEX 01 00:00:30');
  assert.equal(cue.entries.length,2);
  assert.equal(cue.entries[0].endFrame,30);
  assert.equal(cue.entries[1].index01Frame,30);
  assert.equal(resolveCueReference('C:\\music','C:\\music\\disc.cue','..\\secret.wav'),null);
});

test('LRC preserves line timing, multiple timestamps and offset',() => {
  const doc=parseLrc('[offset:250]\n[00:01.50][00:03.25]第一句\n[00:02.00]第二句','demo.lrc');
  assert.equal(doc.kind,'timed');
  assert.deepEqual(doc.lines.map(line=>line.atSeconds),[1.75,2.25,3.5]);
  assert.deepEqual(doc.lines.map(line=>line.text),['第一句','第二句','第一句']);
});

test('scan imports virtual CUE tracks, Chinese short search, and handles removal',async t => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'aural-test-'));
  const music=path.join(temporary,'music');fs.mkdirSync(music);
  makeWav(path.join(music,'disc.wav'));
  const cueText='TITLE "测试专辑"\nPERFORMER "周杰伦"\nFILE "disc.wav" WAVE\n TRACK 01 AUDIO\n TITLE "序曲"\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n TITLE "夜曲"\n INDEX 01 00:00:30';
  fs.writeFileSync(path.join(music,'disc.cue'),cueText,'utf8');
  const db=new LibraryDatabase(path.join(temporary,'library.db'));
  t.after(() => {
    db.close();
    const safeRoot=path.resolve(os.tmpdir())+path.sep;
    assert.ok(path.resolve(temporary).startsWith(safeRoot));
    fs.rmSync(temporary,{recursive:true,force:true});
  });
  const rootId=db.addRoot(music);
  const states=[];
  await scanRoot(db,rootId,state => states.push(state));
  assert.equal(states.at(-1).phase,'complete');
  assert.equal(db.stats().tracks,2);
  assert.equal(db.list({view:'all'}).items[1].sourceStartCueFrame,30);
  assert.equal(db.list({view:'all',query:'周'}).total,2);
  assert.equal(db.list({view:'all',query:'周杰'}).total,2);
  assert.equal(db.list({view:'all',query:'测试专辑'}).total,2);
  assert.deepEqual(db.list({view:'all'}).items.map(x=>x.title),['序曲','夜曲']);
  const before=db.list({view:'all'}).items.map(x=>x.id);
  db.applyMetadata(before[0],0,{provider:'musicbrainz',recordingId:'12345678-1234-1234-1234-123456789abc',releaseId:null,title:'修订序曲',artist:'周杰伦',album:null},['title']);
  await scanRoot(db,rootId,()=>{});
  assert.deepEqual(db.list({view:'all'}).items.map(x=>x.id),before);
  assert.equal(db.getItem(before[0]).title,'修订序曲');
  fs.unlinkSync(path.join(music,'disc.cue'));
  await scanRoot(db,rootId,()=>{});
  assert.equal(db.stats().tracks,1);
  assert.equal(db.list({view:'all'}).items[0].kind,'file');
  fs.writeFileSync(path.join(music,'disc.cue'),cueText,'utf8');
  await scanRoot(db,rootId,()=>{});
  assert.equal(db.stats().tracks,2);
  assert.equal(db.getItem(before[0]).title,'修订序曲');
  fs.unlinkSync(path.join(music,'disc.cue'));
  await scanRoot(db,rootId,()=>{});
  fs.unlinkSync(path.join(music,'disc.wav'));
  await scanRoot(db,rootId,()=>{});
  assert.equal(db.stats().tracks,0);
  assert.equal(db.stats().unavailable,1);
});

test('confirmed metadata survives rescans, is searchable, and can be undone',async t => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'aural-meta-test-'));
  const music=path.join(temporary,'music');fs.mkdirSync(music);
  makeWav(path.join(music,'demo.wav'));
  const db=new LibraryDatabase(path.join(temporary,'library.db'));
  t.after(() => {db.close();const safe=path.resolve(os.tmpdir())+path.sep;assert.ok(path.resolve(temporary).startsWith(safe));fs.rmSync(temporary,{recursive:true,force:true});});
  const rootId=db.addRoot(music);
  await scanRoot(db,rootId,()=>{});
  const initial=db.list({view:'all'}).items[0];
  const candidate={provider:'musicbrainz',recordingId:'12345678-1234-1234-1234-123456789abc',releaseId:null,title:'更新后的歌名',artist:'新歌手',album:null};
  const change=db.applyMetadata(initial.id,0,candidate,['title','artist']);
  assert.equal(change.revision,1);
  assert.equal(db.list({view:'all',query:'新歌手'}).total,1);
  assert.equal(db.facets('artists')[0].name,'新歌手');
  assert.throws(()=>db.applyMetadata(initial.id,0,candidate,['title']),/已变化/);
  await scanRoot(db,rootId,()=>{});
  assert.equal(db.getItem(initial.id).title,'更新后的歌名');
  assert.equal(db.metadataRevision(initial.id),1);
  db.undoMetadata(change.changeId);
  assert.equal(db.getItem(initial.id).title,initial.title);
  assert.equal(db.list({view:'all',query:'新歌手'}).total,0);
  assert.throws(()=>db.undoMetadata(change.changeId),/已撤销/);
});

test('MusicBrainz provider keeps recording and release identities separate',async () => {
  assert.equal(validContact('https://example.com/aural'),true);
  assert.equal(validContact('invalid contact'),false);
  let requested;
  const fetcher=async (url,options) => {
    requested={url:String(url),agent:options.headers['User-Agent']};
    return new Response(JSON.stringify({recordings:[{id:'12345678-1234-1234-1234-123456789abc',title:'正式标题',score:91,
      'artist-credit':[{name:'艺人甲',joinphrase:' & '},{name:'艺人乙'}],releases:[{id:'abcdefab-1234-1234-1234-123456789abc',title:'具体发行版',date:'2024-01-01'}]}]}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const provider=new MusicBrainzProvider(()=> 'https://example.com/aural',fetcher);
  const candidates=await provider.search({id:'local-1',title:'本地标题',artist:'艺人甲'});
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].artist,'艺人甲 & 艺人乙');
  assert.equal(candidates[0].album,'具体发行版');
  assert.equal(provider.resolve('local-1',candidates[0].token).releaseId,'abcdefab-1234-1234-1234-123456789abc');
  assert.equal(provider.resolve('other-item',candidates[0].token),null);
  assert.match(requested.url,/musicbrainz\.org\/ws\/2\/recording/);
  assert.match(requested.agent,/https:\/\/example.com\/aural/);
  assert.equal(requested.url.includes('path='),false);
});
