const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {PlaybackCoordinator}=require('../dist/main/main/playback.js');
const {PlaybackQueue}=require('../dist/main/main/queue.js');
const {LibraryDatabase}=require('../dist/main/library/database.js');

const item=id=>({id,kind:'file',available:true});
const command=revision=>({commandId:randomUUID(),baseRevision:revision});

test('failed queue save leaves memory and disk intent at the previous revision',async()=>{
  let stored=null,failNext=false;
  const plays=[],published=[];
  const library={
    load:async()=>stored,
    save:async(state,baseRevision)=>{
      assert.equal(baseRevision,stored?.revision??0);
      if(failNext){failNext=false;throw new Error('simulated disk failure');}
      stored=structuredClone(state);
    },
    item:async id=>item(id),items:async ids=>ids.map(item)
  };
  const audio={rawDsdSelected:()=>false,play:async value=>{plays.push(value.id);return {state:'playing',itemId:value.id};},
    snapshot:()=>({positionSeconds:0}),stop:()=>({state:'idle'}),cancelNext:async()=> 'cancelled'};
  const coordinator=new PlaybackCoordinator(audio,library,state=>published.push(state));
  await coordinator.initialize();
  await coordinator.play('a',['a','b']);
  const before=coordinator.snapshot();
  failNext=true;
  const failed=command(before.revision);
  await assert.rejects(coordinator.next(failed),/simulated disk failure/);
  assert.deepEqual(coordinator.snapshot(),before);
  assert.deepEqual(stored,before);
  assert.deepEqual(plays,['a']);
  assert.equal(published.length,2);
  await assert.rejects(coordinator.next(failed),/simulated disk failure/);
  assert.equal((await coordinator.next(command(before.revision))).itemId,'b');
  const restarted=new PlaybackCoordinator(audio,library,()=>{});
  await restarted.initialize();
  assert.deepEqual(restarted.snapshot(),stored);
});

test('pending save does not expose an uncommitted queue snapshot',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const initial=new PlaybackQueue();initial.start('a',['a','b']);
  let stored=initial.snapshot();
  const library={load:async()=>stored,save:async(state,baseRevision)=>{
    assert.equal(baseRevision,stored.revision);
    await gate;stored=structuredClone(state);
  },item:async id=>item(id),items:async ids=>ids.map(item)};
  const audio={rawDsdSelected:()=>false,play:async value=>({state:'playing',itemId:value.id}),snapshot:()=>({positionSeconds:0}),
    stop:()=>({state:'idle'}),cancelNext:async()=> 'cancelled'};
  const coordinator=new PlaybackCoordinator(audio,library,()=>{});
  await coordinator.initialize();
  const pending=coordinator.next(command(stored.revision));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(coordinator.snapshot().revision,stored.revision);
  assert.equal(coordinator.snapshot().currentEntryId,stored.currentEntryId);
  release();
  await pending;
  assert.equal(coordinator.snapshot().revision,stored.revision);
  assert.equal(coordinator.snapshot().entries.find(entry=>entry.id===stored.currentEntryId).itemId,'b');
});

test('lost save reply is reconciled against the stored queue before playback advances',async()=>{
  const initial=new PlaybackQueue();initial.start('a',['a','b']);
  let stored=initial.snapshot();
  const plays=[];
  const library={load:async()=>stored,save:async(state,baseRevision)=>{
    assert.equal(baseRevision,stored.revision);
    stored=structuredClone(state);
    throw new Error('reply lost after commit');
  },item:async id=>item(id),items:async ids=>ids.map(item)};
  const audio={rawDsdSelected:()=>false,play:async value=>{plays.push(value.id);return {state:'playing',itemId:value.id};},
    snapshot:()=>({positionSeconds:0}),stop:()=>({state:'idle'}),cancelNext:async()=> 'cancelled'};
  const coordinator=new PlaybackCoordinator(audio,library,()=>{});
  await coordinator.initialize();
  const result=await coordinator.next(command(stored.revision));
  assert.equal(result.itemId,'b');
  assert.deepEqual(coordinator.snapshot(),stored);
  assert.deepEqual(plays,['b']);
});

test('unreadable persistence outcome blocks further queue mutations',async()=>{
  const initial=new PlaybackQueue();initial.start('a',['a','b']);
  const stored=initial.snapshot();
  let readCount=0;
  const library={load:async()=>{if(++readCount>1)throw new Error('service offline');return stored;},
    save:async()=>{throw new Error('save outcome unknown');},
    item:async id=>item(id),items:async ids=>ids.map(item)};
  const audio={rawDsdSelected:()=>false,play:async value=>({state:'playing',itemId:value.id}),snapshot:()=>({positionSeconds:0}),
    stop:()=>({state:'idle'}),cancelNext:async()=> 'cancelled'};
  const coordinator=new PlaybackCoordinator(audio,library,()=>{});
  await coordinator.initialize();
  await assert.rejects(coordinator.next(command(stored.revision)),/无法确认队列是否已保存/);
  assert.deepEqual(coordinator.snapshot(),stored);
  await assert.rejects(coordinator.setRepeat('all',command(stored.revision)),/请重启应用/);
});

test('SQLite rejects stale writers and refuses corrupt queue data after reopen',t=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'aural-queue-durable-'));
  const filename=path.join(temporary,'library.db');
  t.after(()=>{
    const safe=path.resolve(os.tmpdir())+path.sep;
    assert.ok(path.resolve(temporary).startsWith(safe));
    fs.rmSync(temporary,{recursive:true,force:true});
  });
  let db=new LibraryDatabase(filename);
  const initial=new PlaybackQueue();initial.start('a',['a','b']);
  db.saveQueue(initial.snapshot(),0);
  db.close();
  db=new LibraryDatabase(filename);
  const base=db.loadQueue();
  assert.equal(base.revision,1);
  const first=new PlaybackQueue(base);first.setRepeat('all');
  db.saveQueue(first.snapshot(),1);
  const stale=new PlaybackQueue(base);stale.setRepeat('one');
  assert.throws(()=>db.saveQueue(stale.snapshot(),1),/队列版本已变化/);
  assert.equal(db.loadQueue().repeat,'all');
  db.close();
  const raw=new DatabaseSync(filename);
  raw.prepare("UPDATE app_setting SET value=? WHERE key='playback_queue'").run('{bad json');
  raw.close();
  db=new LibraryDatabase(filename);
  assert.throws(()=>db.loadQueue(),/无法解析/);
  assert.throws(()=>db.saveQueue(stale.snapshot(),1),/无法解析/);
  db.close();
});
