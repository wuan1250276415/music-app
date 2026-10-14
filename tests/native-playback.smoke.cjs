const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs');
const net=require('node:net');
const os=require('node:os');
const path=require('node:path');
const {FrameReader,encodeFrame}=require('../dist/main/main/audio-protocol.js');
const release=require('../release/manifest.json');
const hostExecutable=process.env.AURAL_NATIVE_HOST || path.resolve(__dirname,'../native/audio-host/build/audio-host.exe');

function wav(file,rate=44100){
  const frames=rate*8,pcm=Buffer.alloc(frames*4),header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);
  header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*4,28);
  header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);
  header.write('data',36);header.writeUInt32LE(pcm.length,40);
  fs.writeFileSync(file,Buffer.concat([header,pcm]));
}

async function connect(pipe){
  const deadline=Date.now()+5000;
  for(;;){
    try{return await new Promise((resolve,reject)=>{
      const socket=net.createConnection(pipe);
      socket.once('connect',()=>resolve(socket));
      socket.once('error',error=>{socket.destroy();reject(error);});
    });}
    catch(error){if(Date.now()>deadline)throw error;await new Promise(resolve=>setTimeout(resolve,25));}
  }
}

class Inbox{
  constructor(socket){
    this.messages=[];this.waiters=[];
    const reader=new FrameReader(message=>{
      // Existing hardware probes acknowledge the new prepared/start handshake.
      // This is protocol adaptation; it does not replace Main preflight fault validation at MVP.
      if(message.event==='playback.prepared'){
        assert.equal(message.payload.state,'preparing');
        assert.equal(message.payload.pipelinePlan.version,2);
        socket.write(encodeFrame({protocol:release.audioProtocol,kind:'command',sessionId:message.sessionId,
          requestId:randomUUID(),commandId:randomUUID(),expectedGeneration:message.generation,
          method:'playback.start',timeoutMs:5000,params:{planToken:message.payload.planToken}}));
      }
      const index=this.waiters.findIndex(waiter=>waiter.predicate(message));
      if(index<0)this.messages.push(message);
      else{const [waiter]=this.waiters.splice(index,1);clearTimeout(waiter.timer);waiter.resolve(message);}
    });
    socket.on('data',chunk=>reader.push(chunk));
  }
  wait(predicate,timeoutMs=5000){
    const index=this.messages.findIndex(predicate);
    if(index>=0)return Promise.resolve(this.messages.splice(index,1)[0]);
    return new Promise((resolve,reject)=>{
      const waiter={predicate,resolve,timer:null};
      waiter.timer=setTimeout(()=>{
        this.waiters=this.waiters.filter(value=>value!==waiter);
        reject(new Error('audio event timeout'));
      },timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

function waitForClose(child){
  if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('audio host did not exit')),5000);
    child.once('close',()=>{clearTimeout(timer);resolve();});
  });
}

async function withTwoSpanHost(boundaryCue,endCue,body){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aural-cue-control-'));
  const media=path.join(directory,'disc.wav');wav(media,44100);
  const sessionId=randomUUID(),nonce=randomUUID(),pipe=`\\\\.\\pipe\\aural-cue-control-${randomUUID()}`;
  const child=spawn(hostExecutable,[pipe,sessionId,nonce,String(process.pid)],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let diagnostics='';child.stderr.on('data',chunk=>{diagnostics+=chunk.toString();});
  let socket;
  try{
    socket=await connect(pipe);socket.on('error',()=>{});
    const inbox=new Inbox(socket);
    socket.write(encodeFrame({protocol:release.audioProtocol,kind:'hello',buildId:release.mainBuildId,
      sessionId,nonce,maxMessageBytes:release.audioProtocol.maxMessageBytes}));
    await inbox.wait(message=>message.kind==='hello');
    const requestId=randomUUID();
    socket.write(encodeFrame({protocol:release.audioProtocol,kind:'command',sessionId,
      requestId,commandId:randomUUID(),method:'playback.play',expectedGeneration:0,timeoutMs:5000,
      params:{path:media,startCueFrame:1,endCueFrame:boundaryCue,nextCueStartFrame:boundaryCue,
        nextCueEndFrame:endCue,startSeconds:0,endSeconds:-1,mode:'shared',allowConversion:true}}));
    assert.equal((await inbox.wait(message=>message.kind==='receipt'&&message.requestId===requestId)).accepted,true,diagnostics);
    await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='playing');
    const send=async(method,generation,params={})=>{
      const id=randomUUID();
      socket.write(encodeFrame({protocol:release.audioProtocol,kind:'command',sessionId,
        requestId:id,commandId:randomUUID(),method,expectedGeneration:generation,timeoutMs:5000,params}));
      return inbox.wait(message=>message.kind==='receipt'&&message.requestId===id);
    };
    await body({inbox,send,sessionId});
  }finally{
    socket?.destroy();
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    await waitForClose(child);
    fs.unlinkSync(media);fs.rmdirSync(directory);
  }
}

if(process.platform==='win32')test('native host replays original accepted and rejected receipts without repeating actions',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aural-audio-contract-'));
  const media=path.join(directory,'silence.wav');wav(media);
  const sessionId=randomUUID(),nonce=randomUUID(),pipe=`\\\\.\\pipe\\aural-audio-contract-${randomUUID()}`;
  const child=spawn(hostExecutable,[pipe,sessionId,nonce,String(process.pid)],
    {windowsHide:true,stdio:['ignore','ignore','pipe']});
  let diagnostics='';child.stderr.on('data',chunk=>{diagnostics+=chunk.toString();});
  let socket;
  try{
    socket=await connect(pipe);
    socket.on('error',()=>{});
    const inbox=new Inbox(socket);
    const send=(method,commandId,expectedGeneration=1,params={})=>{
      const requestId=randomUUID();
      socket.write(encodeFrame({protocol:release.audioProtocol,kind:'command',sessionId,
        requestId,commandId,method,expectedGeneration,timeoutMs:5000,params}));
      return inbox.wait(message=>message.kind==='receipt'&&message.requestId===requestId);
    };
    socket.write(encodeFrame({protocol:release.audioProtocol,kind:'hello',buildId:release.mainBuildId,
      sessionId,nonce,maxMessageBytes:release.audioProtocol.maxMessageBytes}));
    assert.equal((await inbox.wait(message=>message.kind==='hello')).buildId,release.hostBuildId);
    const first=await send('playback.play',randomUUID(),0,{path:media,startSeconds:0,endSeconds:-1,
      startCueFrame:1,endCueFrame:527,mode:'shared'});
    assert.equal(first.accepted,true,diagnostics);
    const playing=await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='playing');
    assert.deepEqual(playing.payload.requestedOutput,{backend:'wasapi',mode:'shared',allowConversion:true});
    assert.equal(playing.payload.actualOutput.backend,'wasapi');
    assert.equal(playing.payload.actualOutput.hardwareVerified,false);
    assert.equal(playing.payload.sourceStartPcmFrame,'588');
    assert.equal(playing.payload.sourceEndPcmFrame,'309876');
    const telemetry=await inbox.wait(message=>message.event==='playback.position'&&
      typeof message.payload.callbackCount==='string'&&BigInt(message.payload.callbackCount)>0n);
    for(const field of ['callbackCount','bufferUnderrunCallbacks','bufferUnderrunFrames'])
      assert.match(telemetry.payload[field],/^\d+$/);
    assert.ok(BigInt(telemetry.payload.callbackCount)>0n);

    const rejectedId=randomUUID();
    const rejected=await send('playback.unknown',rejectedId);
    assert.equal(rejected.accepted,false);
    const rejectedReplay=await send('playback.pause',rejectedId);
    assert.equal(rejectedReplay.accepted,false);
    assert.equal(rejectedReplay.error,rejected.error);
    assert.equal(rejectedReplay.generation,rejected.generation);
    await send('playback.snapshot',randomUUID());
    assert.equal((await inbox.wait(message=>message.event==='playback.snapshot')).payload.state,'playing');

    const pauseId=randomUUID();
    const paused=await send('playback.pause',pauseId);
    assert.equal(paused.accepted,true);
    await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='paused');
    const pausedReplay=await send('playback.resume',pauseId);
    assert.equal(pausedReplay.accepted,true);
    assert.equal(pausedReplay.generation,paused.generation);
    await send('playback.snapshot',randomUUID());
    assert.equal((await inbox.wait(message=>message.event==='playback.snapshot')).payload.state,'paused');
    await send('playback.stop',randomUUID());
    await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='stopped');
  }finally{
    socket?.destroy();
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    await waitForClose(child);
    fs.unlinkSync(media);fs.rmdirSync(directory);
  }
});

if(process.platform==='win32')test('native host maps CUE frame positions at 48 kHz without floating seconds',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aural-cue-48k-'));
  const media=path.join(directory,'silence.wav');wav(media,48000);
  const sessionId=randomUUID(),nonce=randomUUID(),pipe=`\\\\.\\pipe\\aural-cue-48k-${randomUUID()}`;
  const child=spawn(hostExecutable,[pipe,sessionId,nonce,String(process.pid)],
    {windowsHide:true,stdio:['ignore','ignore','pipe']});
  let socket;
  try{
    socket=await connect(pipe);
    socket.on('error',()=>{});
    const inbox=new Inbox(socket);
    socket.write(encodeFrame({protocol:release.audioProtocol,kind:'hello',buildId:release.mainBuildId,
      sessionId,nonce,maxMessageBytes:release.audioProtocol.maxMessageBytes}));
    await inbox.wait(message=>message.kind==='hello');
    const requestId=randomUUID(),commandId=randomUUID();
    socket.write(encodeFrame({protocol:release.audioProtocol,kind:'command',sessionId,
      requestId,commandId,method:'playback.play',expectedGeneration:0,timeoutMs:5000,
      params:{path:media,startCueFrame:1,endCueFrame:227,startSeconds:0,endSeconds:-1,mode:'shared'}}));
    assert.equal((await inbox.wait(message=>message.kind==='receipt'&&message.requestId===requestId)).accepted,true);
    const playing=await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='playing');
    assert.equal(playing.payload.actualOutput.sampleRate,48000);
    assert.equal(playing.payload.sourceStartPcmFrame,'640');
    assert.equal(playing.payload.sourceEndPcmFrame,'145280');
  }finally{
    socket?.destroy();
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    await waitForClose(child);
    fs.unlinkSync(media);fs.rmdirSync(directory);
  }
});

if(process.platform==='win32')test('native host keeps one stream across adjacent CUE spans',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aural-cue-continuous-'));
  const media=path.join(directory,'disc.wav');wav(media,44100);
  const sessionId=randomUUID(),nonce=randomUUID(),pipe=`\\\\.\\pipe\\aural-cue-continuous-${randomUUID()}`;
  const child=spawn(hostExecutable,[pipe,sessionId,nonce,String(process.pid)],
    {windowsHide:true,stdio:['ignore','ignore','pipe']});
  let diagnostics='';child.stderr.on('data',chunk=>{diagnostics+=chunk.toString();});
  let socket;
  try{
    socket=await connect(pipe);socket.on('error',()=>{});
    const inbox=new Inbox(socket);
    socket.write(encodeFrame({protocol:release.audioProtocol,kind:'hello',buildId:release.mainBuildId,
      sessionId,nonce,maxMessageBytes:release.audioProtocol.maxMessageBytes}));
    await inbox.wait(message=>message.kind==='hello');
    const requestId=randomUUID(),commandId=randomUUID();
    socket.write(encodeFrame({protocol:release.audioProtocol,kind:'command',sessionId,
      requestId,commandId,method:'playback.play',expectedGeneration:0,timeoutMs:5000,
      params:{path:media,startCueFrame:1,endCueFrame:75,nextCueStartFrame:75,nextCueEndFrame:150,
        startSeconds:0,endSeconds:-1,mode:'shared',allowConversion:true}}));
    assert.equal((await inbox.wait(message=>message.kind==='receipt'&&message.requestId===requestId)).accepted,true,diagnostics);
    const playing=await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='playing');
    assert.equal(playing.payload.sourceStartPcmFrame,'588');
    assert.equal(playing.payload.cueBoundaryPcmFrame,'44100');
    assert.equal(playing.payload.sourceEndPcmFrame,'88200');
    const boundary=await inbox.wait(message=>message.event==='playback.cueBoundary',5000);
    assert.equal(boundary.sessionId,sessionId);
    assert.equal(boundary.payload.sourcePcmFrame,'44100');
    assert.equal(boundary.payload.relativePcmFrame,'43512');
    const ended=await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='ended',5000);
    assert.equal(ended.sessionId,sessionId);
    assert.ok(BigInt(ended.sequence)>BigInt(boundary.sequence));
  }finally{
    socket?.destroy();
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    await waitForClose(child);
    fs.unlinkSync(media);fs.rmdirSync(directory);
  }
});

if(process.platform==='win32')test('two-span seek reports segment changes and can cross the boundary again',async()=>{
  await withTwoSpanHost(300,525,async({inbox,send})=>{
    assert.equal((await send('playback.pause',1)).accepted,true);
    await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='paused');
    assert.equal((await send('playback.seek',1,{positionUs:'4500000'})).accepted,true);
    const forward=await inbox.wait(message=>message.event==='playback.seekCompleted');
    assert.equal(forward.generation,2);
    assert.equal(forward.payload.cueSegmentIndex,1);
    assert.equal((await send('playback.seek',2,{positionUs:'500000'})).accepted,true);
    const backward=await inbox.wait(message=>message.event==='playback.seekCompleted');
    assert.equal(backward.generation,3);
    assert.equal(backward.payload.cueSegmentIndex,0);
    assert.equal((await send('playback.resume',3)).accepted,true);
    await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='playing');
    const boundary=await inbox.wait(message=>message.event==='playback.cueBoundary',5000);
    assert.equal(boundary.payload.sourcePcmFrame,'176400');
  });
});

if(process.platform==='win32')test('cancelling a queued CUE span stops at the first boundary',async()=>{
  await withTwoSpanHost(300,525,async({inbox,send})=>{
    assert.equal((await send('playback.cancelNext',1)).accepted,true);
    const again=await send('playback.cancelNext',1);
    assert.equal(again.accepted,false);
    assert.match(again.error,/already cancelled/);
    await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='ended',7000);
    assert.equal(inbox.messages.some(message=>message.event==='playback.cueBoundary'),false);
  });
});

if(process.platform==='win32')test('cancelling after the CUE boundary reports that it is too late',async()=>{
  await withTwoSpanHost(75,300,async({inbox,send})=>{
    await inbox.wait(message=>message.event==='playback.cueBoundary',5000);
    const tooLate=await send('playback.cancelNext',1);
    assert.equal(tooLate.accepted,false);
    assert.match(tooLate.error,/boundary already crossed/);
  });
});

for(const [rate,bits,firstFrame] of [[44100,16,'588'],[48000,24,'640']]){
  if(process.platform!=='win32')continue;
  test(`native host opens ${bits}-bit FLAC and preserves its CUE frame plan`,async()=>{
    const media=path.resolve(__dirname,`../native/audio-host/testdata/cue-gold-${rate}-${bits}bit.flac`);
    const sessionId=randomUUID(),nonce=randomUUID(),pipe=`\\\\.\\pipe\\aural-flac-${randomUUID()}`;
    const child=spawn(hostExecutable,[pipe,sessionId,nonce,String(process.pid)],
      {windowsHide:true,stdio:['ignore','ignore','pipe']});
    let diagnostics='';child.stderr.on('data',chunk=>{diagnostics+=chunk.toString();});
    let socket;
    try{
      socket=await connect(pipe);
      socket.on('error',()=>{});
      const inbox=new Inbox(socket);
      socket.write(encodeFrame({protocol:release.audioProtocol,kind:'hello',buildId:release.mainBuildId,
        sessionId,nonce,maxMessageBytes:release.audioProtocol.maxMessageBytes}));
      await inbox.wait(message=>message.kind==='hello');
      const requestId=randomUUID();
      socket.write(encodeFrame({protocol:release.audioProtocol,kind:'command',sessionId,
        requestId,commandId:randomUUID(),method:'playback.play',expectedGeneration:0,timeoutMs:5000,
        params:{path:media,startCueFrame:1,endCueFrame:149,startSeconds:0,endSeconds:-1,mode:'shared'}}));
      assert.equal((await inbox.wait(message=>message.kind==='receipt'&&message.requestId===requestId)).accepted,true);
      const playing=await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='playing');
      assert.equal(playing.payload.sourceStartPcmFrame,firstFrame,diagnostics);
      assert.equal(playing.payload.sourceEndPcmFrame,String(Math.floor(149*rate/75)));
      assert.equal(playing.payload.actualOutput.backend,'wasapi');
    }finally{
      socket?.destroy();
      if(child.exitCode===null&&child.signalCode===null)child.kill();
      await waitForClose(child);
    }
  });
}

if(process.platform==='win32')test('native seek clears timeline, preserves pause, and replays receipts without repeating seek',async()=>{
  const media=path.resolve(__dirname,'../native/audio-host/testdata/cue-gold-44100-16bit.flac');
  const sessionId=randomUUID(),nonce=randomUUID(),pipe=`\\\\.\\pipe\\aural-seek-${randomUUID()}`;
  const child=spawn(hostExecutable,[pipe,sessionId,nonce,String(process.pid)],
    {windowsHide:true,stdio:['ignore','ignore','pipe']});
  let diagnostics='';child.stderr.on('data',chunk=>{diagnostics+=chunk.toString();});
  let socket;
  try{
    socket=await connect(pipe);socket.on('error',()=>{});
    const inbox=new Inbox(socket);
    const send=(method,commandId,generation,params={})=>{
      const requestId=randomUUID();
      socket.write(encodeFrame({protocol:release.audioProtocol,kind:'command',sessionId,
        requestId,commandId,method,expectedGeneration:generation,timeoutMs:5000,params}));
      return inbox.wait(message=>message.kind==='receipt'&&message.requestId===requestId);
    };
    socket.write(encodeFrame({protocol:release.audioProtocol,kind:'hello',buildId:release.mainBuildId,
      sessionId,nonce,maxMessageBytes:release.audioProtocol.maxMessageBytes}));
    await inbox.wait(message=>message.kind==='hello');
    assert.equal((await send('playback.play',randomUUID(),0,{path:media,startCueFrame:1,endCueFrame:225,
      startSeconds:0,endSeconds:-1,mode:'shared'})).accepted,true,diagnostics);
    await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='playing');
    assert.equal((await send('playback.pause',randomUUID(),1)).accepted,true);
    await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='paused');
    const firstSeekId=randomUUID();
    const first=await send('playback.seek',firstSeekId,1,{positionUs:'1250000'});
    assert.equal(first.accepted,true);
    const firstDone=await inbox.wait(message=>message.event==='playback.seekCompleted'&&message.causedBy===firstSeekId);
    assert.equal(firstDone.generation,2);
    assert.equal(firstDone.payload.state,'paused');
    assert.equal(firstDone.payload.position,1.25);
    assert.equal(firstDone.payload.sourcePcmFrame,'55713');
    const secondSeekId=randomUUID();
    assert.equal((await send('playback.seek',secondSeekId,2,{positionUs:'500000'})).accepted,true);
    const secondDone=await inbox.wait(message=>message.event==='playback.seekCompleted'&&message.causedBy===secondSeekId);
    assert.equal(secondDone.generation,3);
    assert.equal(secondDone.payload.position,0.5);
    const replay=await send('playback.seek',firstSeekId,3,{positionUs:'1800000'});
    assert.equal(replay.accepted,true);
    assert.equal(replay.generation,first.generation);
    assert.equal((await send('playback.seek',randomUUID(),3,{positionUs:'5000000'})).accepted,false);
    await send('playback.snapshot',randomUUID(),3);
    const snapshot=await inbox.wait(message=>message.event==='playback.snapshot');
    assert.equal(snapshot.payload.state,'paused');
    assert.equal(snapshot.payload.position,0.5);
    assert.equal((await send('playback.resume',randomUUID(),3)).accepted,true);
    await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='playing');
  }finally{
    socket?.destroy();
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    await waitForClose(child);
  }
});

for(const rate of [44100,48000]){
if(process.platform==='win32')test(`exclusive ${rate} Hz output reports integer eligibility or an explicit float fallback`,async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aural-integer-plan-'));
  const media=path.join(directory,'stereo.wav');wav(media,rate);
  const sessionId=randomUUID(),nonce=randomUUID(),pipe=`\\\\.\\pipe\\aural-integer-${randomUUID()}`;
  const child=spawn(hostExecutable,[pipe,sessionId,nonce,String(process.pid)],
    {windowsHide:true,stdio:['ignore','ignore','pipe']});
  let socket;
  try{
    socket=await connect(pipe);socket.on('error',()=>{});
    const inbox=new Inbox(socket);
    socket.write(encodeFrame({protocol:release.audioProtocol,kind:'hello',buildId:release.mainBuildId,
      sessionId,nonce,maxMessageBytes:release.audioProtocol.maxMessageBytes}));
    await inbox.wait(message=>message.kind==='hello');
    const requestId=randomUUID();
    socket.write(encodeFrame({protocol:release.audioProtocol,kind:'command',sessionId,
      requestId,commandId:randomUUID(),method:'playback.play',expectedGeneration:0,timeoutMs:5000,
      params:{path:media,startCueFrame:1,endCueFrame:227,startSeconds:0,endSeconds:-1,mode:'exclusive',allowConversion:true}}));
    assert.equal((await inbox.wait(message=>message.kind==='receipt'&&message.requestId===requestId)).accepted,true);
    const playing=await inbox.wait(message=>message.event==='playback.stateChanged'&&message.payload.state==='playing');
    const output=playing.payload.actualOutput;
    assert.equal(output.hardwareVerified,false);
    assert.equal(output.mode,'exclusive');
    assert.equal(output.allowConversion,true);
    assert.equal(typeof output.adapterConversion,'boolean');
    if(output.applicationIntegerPath){
      assert.equal(output.format,'s16');
      assert.equal(output.deviceFormat,'s16');
      assert.equal(output.adapterConversion,false);
      assert.equal(output.sampleRate,output.deviceSampleRate);
      assert.equal(output.channels,output.deviceChannels);
    }else assert.equal(output.format,'f32');
    console.log(`exclusive output plan: ${JSON.stringify(output)}`);
  }finally{
    socket?.destroy();
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    await waitForClose(child);
    fs.unlinkSync(media);fs.rmdirSync(directory);
  }
});
}

for(const rate of [44100,48000]){
if(process.platform==='win32')test(`strict exclusive ${rate} Hz never silently converts`,async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aural-strict-output-'));
  const media=path.join(directory,'stereo.wav');wav(media,rate);
  const sessionId=randomUUID(),nonce=randomUUID(),pipe=`\\\\.\\pipe\\aural-strict-${randomUUID()}`;
  const child=spawn(hostExecutable,[pipe,sessionId,nonce,String(process.pid)],
    {windowsHide:true,stdio:['ignore','ignore','pipe']});
  let socket;
  try{
    socket=await connect(pipe);socket.on('error',()=>{});
    const inbox=new Inbox(socket);
    socket.write(encodeFrame({protocol:release.audioProtocol,kind:'hello',buildId:release.mainBuildId,
      sessionId,nonce,maxMessageBytes:release.audioProtocol.maxMessageBytes}));
    await inbox.wait(message=>message.kind==='hello');
    const requestId=randomUUID();
    socket.write(encodeFrame({protocol:release.audioProtocol,kind:'command',sessionId,
      requestId,commandId:randomUUID(),method:'playback.play',expectedGeneration:0,timeoutMs:5000,
      params:{path:media,startCueFrame:1,endCueFrame:227,startSeconds:0,endSeconds:-1,
        mode:'exclusive',allowConversion:false}}));
    assert.equal((await inbox.wait(message=>message.kind==='receipt'&&message.requestId===requestId)).accepted,true);
    const outcome=await inbox.wait(message=>message.event==='playback.error'||
      message.event==='playback.stateChanged'&&message.payload.state==='playing');
    if(outcome.event==='playback.error'){
      assert.match(outcome.payload.message,/原始格式输出不可用/);
      console.log(`strict ${rate} Hz refused: ${outcome.payload.message}`);
    }else{
      const output=outcome.payload.actualOutput;
      assert.equal(output.allowConversion,false);
      assert.equal(output.applicationIntegerPath,true);
      assert.equal(output.adapterConversion,false);
      assert.equal(output.format,'s16');
      assert.equal(output.deviceFormat,'s16');
      assert.equal(output.sampleRate,output.deviceSampleRate);
      assert.equal(output.channels,output.deviceChannels);
      console.log(`strict ${rate} Hz accepted: ${JSON.stringify(output)}`);
    }
  }finally{
    socket?.destroy();
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    await waitForClose(child);
    fs.unlinkSync(media);fs.rmdirSync(directory);
  }
});
}
