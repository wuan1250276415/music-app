const test=require('node:test');
const assert=require('node:assert/strict');
const {adjacentCuePair,PlaybackCoordinator}=require('../dist/main/main/playback.js');

const item=(id,start,end)=>({id,fileId:'disc',kind:'cue',path:'C:\\music\\disc.wav',
  title:id,artist:'artist',album:'album',genre:'',durationSeconds:(end-start)/75,
  codec:'WAV',sampleRate:44100,bitsPerSample:16,trackNumber:null,discNumber:null,
  sourceStartSeconds:start/75,sourceEndSeconds:end/75,
  sourceStartCueFrame:start,sourceEndCueFrame:end,available:true});

test('CUE preplan requires adjacent spans from the same available image',()=>{
  const first=item('first',0,150),second=item('second',150,375);
  assert.equal(adjacentCuePair(first,second),true);
  assert.equal(adjacentCuePair(first,{...second,sourceStartCueFrame:151}),false);
  assert.equal(adjacentCuePair(first,{...second,fileId:'other'}),false);
  assert.equal(adjacentCuePair(first,{...second,available:false}),false);
  assert.equal(adjacentCuePair(first,{...second,sourceEndCueFrame:null}),false);
});

test('queue boundary commits the planned entry without starting a new host',async()=>{
  const first=item('first',0,150),second=item('second',150,375),third=item('third',375,525);
  const byId=new Map([first,second,third].map(value=>[value.id,value]));
  let saved;
  const plays=[];
  const audio={rawDsdSelected:()=>false,play:async(current,next)=>{plays.push([current.id,next?.id]);return {state:'preparing'};},
    stop:()=>({state:'idle'}),snapshot:()=>({positionSeconds:0}),cancelNext:async()=> 'cancelled'};
  const coordinator=new PlaybackCoordinator(audio,{load:async()=>undefined,
    save:async state=>{saved=state;},item:async id=>byId.get(id),items:async ids=>ids.map(id=>byId.get(id))},()=>{});
  await coordinator.initialize();
  await coordinator.play('first',['first','second','third']);
  assert.deepEqual(plays,[['first','second']]);
  coordinator.onCueBoundary();
  for(let i=0;i<50&&saved.entries.find(entry=>entry.id===saved.currentEntryId)?.itemId!=='second';i++)
    await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(saved.entries.find(entry=>entry.id===saved.currentEntryId)?.itemId,'second');
  assert.deepEqual(plays,[['first','second']]);
});

test('queue reorder cancels a planned span before changing automatic next',async()=>{
  const first=item('first',0,150),second=item('second',150,375),third=item('third',375,525);
  const byId=new Map([first,second,third].map(value=>[value.id,value]));
  const plays=[];let cancellations=0;
  const audio={rawDsdSelected:()=>false,play:async(current,next)=>{plays.push([current.id,next?.id]);return {state:'preparing'};},
    stop:()=>({state:'idle'}),snapshot:()=>({positionSeconds:0}),
    cancelNext:async()=>{cancellations++;return 'cancelled';}};
  const coordinator=new PlaybackCoordinator(audio,{load:async()=>undefined,
    save:async()=>{},item:async id=>byId.get(id),items:async ids=>ids.map(id=>byId.get(id))},()=>{});
  await coordinator.initialize();
  await coordinator.play('first',['first','second','third']);
  const thirdEntry=coordinator.snapshot().entries.find(entry=>entry.itemId==='third');
  await coordinator.move(thirdEntry.id,-1);
  assert.equal(cancellations,1);
  assert.deepEqual(coordinator.snapshot().entries.map(entry=>entry.itemId),['first','third','second']);
  coordinator.onEnded();
  for(let i=0;i<50&&plays.length<2;i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.deepEqual(plays,[['first','second'],['third',undefined]]);
});

test('queue edit after a crossed boundary commits the second entry first',async()=>{
  const first=item('first',0,150),second=item('second',150,375);
  const byId=new Map([first,second].map(value=>[value.id,value]));
  const plays=[];
  let coordinator;
  const audio={rawDsdSelected:()=>false,play:async(current,next)=>{plays.push([current.id,next?.id]);return {state:'preparing'};},
    stop:()=>({state:'idle'}),snapshot:()=>({positionSeconds:0}),
    cancelNext:async()=>{coordinator.onCueBoundary();return 'crossed';}};
  coordinator=new PlaybackCoordinator(audio,{load:async()=>undefined,save:async()=>{},
    item:async id=>byId.get(id),items:async ids=>ids.map(id=>byId.get(id))},()=>{});
  await coordinator.initialize();
  await coordinator.play('first',['first','second']);
  const view=await coordinator.setRepeat('all');
  assert.equal(view.repeat,'all');
  assert.equal(view.entries.find(entry=>entry.id===view.currentEntryId).itemId,'second');
  assert.deepEqual(plays,[['first','second']]);
});

test('CUE boundary stops audio if its queue transition cannot be saved',async()=>{
  const first=item('first',0,150),second=item('second',150,375);
  const byId=new Map([first,second].map(value=>[value.id,value]));
  let stored=null,fail=false,stops=0;
  const audio={rawDsdSelected:()=>false,play:async()=>({state:'playing'}),stop:()=>{stops++;return {state:'idle'};},
    snapshot:()=>({positionSeconds:0}),cancelNext:async()=> 'cancelled'};
  const coordinator=new PlaybackCoordinator(audio,{load:async()=>stored,
    save:async state=>{if(fail)throw new Error('simulated save failure');stored=structuredClone(state);},
    item:async id=>byId.get(id),items:async ids=>ids.map(id=>byId.get(id))},()=>{});
  await coordinator.initialize();
  await coordinator.play('first',['first','second']);
  const before=coordinator.snapshot();
  fail=true;
  const originalError=console.error;
  try{
    console.error=()=>{};
    coordinator.onCueBoundary();
    for(let i=0;i<50&&stops===0;i++)await new Promise(resolve=>setTimeout(resolve,1));
  }finally{console.error=originalError;}
  assert.equal(stops,1);
  assert.deepEqual(coordinator.snapshot(),before);
  assert.deepEqual(stored,before);
});
