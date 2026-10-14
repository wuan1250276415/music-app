const test=require('node:test');
const assert=require('node:assert/strict');
const {AudioController}=require('../dist/main/main/audio.js');
const release=require('../release/manifest.json');

function harness(onCommand){
  const states=[];
  const audio=new AudioController(process.execPath,state=>states.push(state),45);
  const session={id:'test-session',nonce:'test-nonce',pipe:'',process:{exitCode:0,signalCode:null},
    socket:null,generation:1,sequence:0n,ready:true,pending:new Map(),snapshots:new Map(),seeks:new Map(),
    cuePair:null,boundaryWaiters:[],timedOut:new Set(),hello:null};
  session.socket={destroyed:false,write(frame){
    const length=frame.readUInt32LE(0);
    const message=JSON.parse(frame.subarray(4,4+length).toString('utf8'));
    onCommand(message,{receipt,event,audio,session});
    return true;
  },destroy(){this.destroyed=true;}};
  audio.session=session;
  audio.state={state:'playing',itemId:'test-item',positionSeconds:1,durationSeconds:12,output:'test'};
  function receipt(command,accepted=true,error=''){
    audio.onMessage(session,{protocol:release.audioProtocol,kind:'receipt',sessionId:session.id,
      requestId:command.requestId,commandId:command.commandId,accepted,error,generation:1});
  }
  function event(name,payload,causedBy,generation=1){
    session.testSequence=(session.testSequence||0)+1;
    audio.onMessage(session,{protocol:release.audioProtocol,kind:'event',sessionId:session.id,
      sequence:String(session.testSequence),generation,
      event:name,causedBy,payload});
  }
  return {audio,session,states,receipt,event};
}

test('lost pause receipt reconciles only after its correlated snapshot event',async()=>{
  let original;
  const h=harness((command,{receipt,event})=>{
    if(command.method==='playback.pause'){
      original=command;
      setTimeout(()=>event('playback.stateChanged',{state:'paused'},command.commandId),5);
    }else if(command.method==='playback.snapshot'){
      setTimeout(()=>event('playback.snapshot',{state:'paused',position:2},command.commandId),5);
      setTimeout(()=>receipt(command),10);
      setTimeout(()=>receipt(original),20);
    }
  });
  const result=await h.audio.send(h.session,'playback.pause');
  assert.equal(result.reconciled,true);
  assert.equal(h.audio.snapshot().state,'paused');
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(h.audio.snapshot().state,'paused');
  assert.equal(h.session.timedOut.size,0);
  h.event('playback.snapshot',{state:'playing',position:0},'old-command');
  assert.equal(h.audio.snapshot().state,'paused');
});

test('lost play receipt accepts a correlated paused snapshot after playback started',async()=>{
  const h=harness((command,{receipt,event})=>{
    if(command.method==='playback.play'){
      setTimeout(()=>event('playback.stateChanged',{state:'playing'},command.commandId),5);
      setTimeout(()=>event('playback.stateChanged',{state:'paused'},command.commandId),10);
    }else if(command.method==='playback.snapshot'){
      receipt(command);
      event('playback.snapshot',{state:'paused',position:3},command.commandId);
    }
  });
  h.audio.state={...h.audio.state,state:'preparing'};
  const result=await h.audio.send(h.session,'playback.play');
  assert.equal(result.reconciled,true);
  assert.equal(h.audio.snapshot().state,'paused');
});

test('accepted snapshot receipt without snapshot event fails closed',async()=>{
  const h=harness((command,{receipt})=>{
    if(command.method==='playback.snapshot')receipt(command);
  });
  await assert.rejects(h.audio.send(h.session,'playback.pause'),/音频快照事件超时/);
  assert.equal(h.audio.snapshot().state,'error');
  assert.equal(h.session.socket.destroyed,true);
});

test('a late rejected command cannot be masked by a snapshot',async()=>{
  let original;
  const h=harness((command,{receipt,event})=>{
    if(command.method==='playback.pause')original=command;
    else if(command.method==='playback.snapshot'){
      receipt(command);
      setTimeout(()=>receipt(original,false,'stale generation'),5);
      setTimeout(()=>event('playback.snapshot',{state:'paused',position:2},command.commandId),10);
    }
  });
  await assert.rejects(h.audio.send(h.session,'playback.pause'),/stale generation/);
  assert.equal(h.audio.snapshot().state,'error');
});

test('receipt with a different command ID is a protocol error',async()=>{
  const h=harness((command,{audio,session})=>{
    setTimeout(()=>audio.onMessage(session,{protocol:release.audioProtocol,kind:'receipt',sessionId:session.id,
      requestId:command.requestId,commandId:'other-command',accepted:true,generation:1}),5);
  });
  await assert.rejects(h.audio.send(h.session,'playback.pause'),/音频回执与命令不匹配/);
  assert.equal(h.audio.snapshot().state,'error');
});

test('seek resolves only after its correlated higher-generation completion event',async()=>{
  const h=harness((command,{receipt,event})=>{
    if(command.method==='playback.seek'){
      receipt(command);
      setTimeout(()=>event('playback.seekCompleted',{state:'playing',position:4,sourcePcmFrame:'176400'},command.commandId,2),20);
    }
  });
  let settled=false;
  const seeking=h.audio.seek(4).then(value=>{settled=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,8));
  assert.equal(settled,false);
  assert.equal((await seeking).positionSeconds,4);
  assert.equal(h.session.generation,2);
});

test('accepted seek without a completion event fails closed',async()=>{
  const h=harness((command,{receipt})=>{
    if(command.method==='playback.seek')receipt(command);
  });
  await assert.rejects(h.audio.seek(4),/音频跳转完成事件超时/);
  assert.equal(h.audio.snapshot().state,'error');
});

test('buffer telemetry reaches playback state and rejects regressing counters',()=>{
  const h=harness(()=>{});
  h.event('playback.position',{position:2,callbackCount:'25',bufferUnderrunCallbacks:'1',bufferUnderrunFrames:'128'});
  assert.deepEqual(h.audio.snapshot().diagnostics,
    {callbackCount:25,bufferUnderrunCallbacks:1,bufferUnderrunFrames:128});
  h.event('playback.position',{position:2.25,callbackCount:'24',bufferUnderrunCallbacks:'1',bufferUnderrunFrames:'128'});
  assert.equal(h.audio.snapshot().state,'error');
  assert.match(h.audio.snapshot().message,/音频缓冲诊断事件无效/);
});
