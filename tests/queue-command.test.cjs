const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {PlaybackCoordinator}=require('../dist/main/main/playback.js');

function fixture(playlist){
  const plays=[];
  const saved=[];
  const audio={rawDsdSelected:()=>false,
    play:async item=>{plays.push(item.id);await new Promise(resolve=>setTimeout(resolve,2));return {state:'playing',itemId:item.id};},
    snapshot:()=>({state:'playing',positionSeconds:0}),
    stop:()=>({state:'idle'}),
    cancelNext:async()=> 'cancelled'
  };
  const item=id=>({id,kind:'file',available:true});
  const coordinator=new PlaybackCoordinator(audio,{
    load:async()=>undefined,
    save:async state=>{saved.push(state);},
    item:async id=>item(id),
    items:async ids=>ids.map(item),playlist
  },()=>{});
  return {coordinator,plays,saved};
}

test('two callers with one command ID receive one next transition, including replay after completion',async()=>{
  const {coordinator,plays,saved}=fixture();
  await coordinator.initialize();
  await coordinator.play('a',['a','b','c']);
  const command={commandId:randomUUID(),baseRevision:coordinator.snapshot().revision};
  const [first,duplicate]=await Promise.all([coordinator.next(command),coordinator.next(command)]);
  assert.deepEqual(first,duplicate);
  assert.equal(first.itemId,'b');
  assert.equal((await coordinator.next(command)).itemId,'b');
  assert.deepEqual(plays,['a','b']);
  assert.equal(saved.length,2);
  assert.equal(coordinator.snapshot().revision,command.baseRevision+1);
  assert.throws(()=>coordinator.setRepeat('all',command),/ID 已用于不同操作/);
});

test('two clients at one revision cannot both mutate; refresh plus new ID succeeds',async()=>{
  const {coordinator,plays}=fixture();
  await coordinator.initialize();
  await coordinator.play('a',['a','b','c']);
  const baseRevision=coordinator.snapshot().revision;
  const first={commandId:randomUUID(),baseRevision};
  const second={commandId:randomUUID(),baseRevision};
  const results=await Promise.allSettled([coordinator.next(first),coordinator.next(second)]);
  assert.equal(results[0].status,'fulfilled');
  assert.equal(results[1].status,'rejected');
  assert.match(results[1].reason.message,/版本已变化/);
  assert.deepEqual(plays,['a','b']);
  assert.equal(coordinator.snapshot().revision,baseRevision+1);
  await assert.rejects(coordinator.next(second),/版本已变化/);
  const refreshed={commandId:randomUUID(),baseRevision:coordinator.snapshot().revision};
  assert.equal((await coordinator.next(refreshed)).itemId,'c');
  assert.deepEqual(plays,['a','b','c']);
});

test('a failed command is replayed as failure without changing later queue state',async()=>{
  const {coordinator,saved}=fixture();
  await coordinator.initialize();
  await coordinator.play('a',['a','b']);
  const command={commandId:randomUUID(),baseRevision:coordinator.snapshot().revision};
  await assert.rejects(coordinator.move('missing',1,command),/无法移动/);
  await assert.rejects(coordinator.move('missing',1,command),/无法移动/);
  assert.equal(saved.length,1);
  assert.equal(coordinator.snapshot().revision,command.baseRevision);
});

test('playlist playback replays its accepted command before re-reading a subsequently edited playlist',async()=>{
  let reads=0,edited=false;
  const {coordinator,plays}=fixture(async()=>{
    reads++;if(edited)throw new Error('歌单版本已变化');
    return {playlistId:'p',revision:1,entries:[{id:'first',itemId:'a'},{id:'second',itemId:'a'}],startIndex:1};
  });
  await coordinator.initialize();
  const request={playlistId:'p',entryId:'second',revision:1},command={commandId:randomUUID(),baseRevision:0};
  const first=await coordinator.playPlaylist(request,command);edited=true;
  assert.deepEqual(await coordinator.playPlaylist(request,command),first);
  assert.equal(reads,1);assert.deepEqual(plays,['a']);
  const snapshot=coordinator.snapshot();
  assert.equal(snapshot.entries.find(entry=>entry.id===snapshot.currentEntryId).playlistEntryId,'second');
  await assert.rejects(coordinator.playPlaylist(request,{commandId:randomUUID(),baseRevision:snapshot.revision}),/歌单版本已变化/);
  assert.equal(coordinator.snapshot().revision,snapshot.revision);
});
