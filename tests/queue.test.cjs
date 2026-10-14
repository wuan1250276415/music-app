const test=require('node:test');
const assert=require('node:assert/strict');
const {PlaybackQueue,validQueueState}=require('../dist/main/main/queue.js');

test('queue advances, navigates history, repeats and restores intent',()=>{
  const queue=new PlaybackQueue();
  queue.start('a',['a','b','c']);
  assert.equal(queue.currentItemId(),'a');
  assert.equal(queue.next(),'b');
  assert.equal(queue.next(),'c');
  assert.equal(queue.next(),null);
  assert.equal(queue.previous(0),'b');
  assert.equal(queue.next(),'c');
  queue.setRepeat('one');
  assert.equal(queue.next(true),'c');
  queue.setRepeat('all');
  assert.equal(queue.next(true),'a');
  const saved=queue.snapshot();
  assert.equal(validQueueState(saved),true);
  const restored=new PlaybackQueue(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.currentItemId(),'a');
  assert.equal(restored.snapshot().repeat,'all');
});

test('shuffle retains history and duplicate entries have independent identities',()=>{
  const queue=new PlaybackQueue(undefined,()=>0);
  queue.start('a',['a','a','b']);
  assert.equal(new Set(queue.snapshot().entries.map(entry=>entry.id)).size,3);
  queue.setShuffle(true);
  const first=queue.snapshot().currentEntryId;
  const second=queue.next();
  assert.ok(second);
  assert.equal(queue.previous(0),'a');
  assert.equal(queue.snapshot().currentEntryId,first);
  assert.equal(queue.next(),second);
  assert.equal(validQueueState(queue.snapshot()),true);
  assert.equal(new PlaybackQueue({entries:[{id:'x',itemId:'y'}]}).snapshot().entries.length,0);
});

test('queue reorder and remove preserve current entry',()=>{
  const queue=new PlaybackQueue();
  queue.start('a',['a','b','c']);
  const entries=queue.snapshot().entries;
  queue.move(entries[2].id,-1);
  assert.deepEqual(queue.snapshot().entries.map(entry=>entry.itemId),['a','c','b']);
  assert.equal(queue.next(),'c');
  queue.remove(entries[1].id);
  assert.deepEqual(queue.snapshot().entries.map(entry=>entry.itemId),['a','c']);
  assert.throws(()=>queue.remove(entries[2].id),/当前播放项/);
  assert.equal(validQueueState(queue.snapshot()),true);
});

test('playlist queue begins at the selected repeated occurrence and preserves source entry IDs',()=>{
  const queue=new PlaybackQueue();
  queue.startAt([{itemId:'a',playlistEntryId:'first'},{itemId:'b',playlistEntryId:'middle'},{itemId:'a',playlistEntryId:'last'}],2);
  const snapshot=queue.snapshot();
  assert.equal(snapshot.entries.find(entry=>entry.id===snapshot.currentEntryId).playlistEntryId,'last');
  assert.equal(queue.next(),null);
  assert.equal(validQueueState(snapshot),true);
  const restored=new PlaybackQueue(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored.snapshot().entries[2].playlistEntryId,'last');
  assert.throws(()=>queue.startAt([{itemId:'a'}],1),/无效播放条目位置/);
});
