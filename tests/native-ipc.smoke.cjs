const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const net=require('node:net');
const path=require('node:path');
const {FrameReader,encodeFrame}=require('../dist/main/main/audio-protocol.js');
const release=require('../release/manifest.json');

const executable=path.resolve(__dirname,'../native/audio-host/build/audio-host.exe');
const protocol={major:release.audioProtocol.major,minor:release.audioProtocol.minor};

async function start(){
  const sessionId=randomUUID(),nonce=randomUUID(),pipe=`\\\\.\\pipe\\aural-contract-${randomUUID()}`;
  const child=spawn(executable,[pipe,sessionId,nonce,String(process.pid)],{windowsHide:true,stdio:'ignore'});
  const deadline=Date.now()+5000;
  const connect=()=>new Promise((resolve,reject)=>{
    const socket=net.createConnection(pipe);
    socket.once('connect',()=>resolve(socket));
    socket.once('error',error=>{socket.destroy();reject(error);});
  });
  let socket;
  while(!socket){
    try{socket=await connect();}
    catch(error){if(Date.now()>deadline){child.kill();throw error;}await new Promise(resolve=>setTimeout(resolve,25));}
  }
  return {child,socket,sessionId,nonce};
}

function exited(child){
  return new Promise((resolve,reject)=>{
    if(child.exitCode!==null){resolve(child.exitCode);return;}
    const timer=setTimeout(()=>{child.kill();reject(new Error('audio host did not exit'));},5000);
    child.once('exit',code=>{clearTimeout(timer);resolve(code);});
  });
}

if(process.platform==='win32'){
  test('native IPC accepts v1 handshake and rejects oversized next frame',async()=>{
    const {child,socket,sessionId,nonce}=await start();
    try{
      const hello=new Promise((resolve,reject)=>{
        const reader=new FrameReader(resolve);
        socket.on('data',chunk=>{try{reader.push(chunk);}catch(error){reject(error);}});
      });
      socket.write(encodeFrame({protocol,kind:'hello',buildId:release.mainBuildId,sessionId,nonce,maxMessageBytes:release.audioProtocol.maxMessageBytes}));
      const message=await hello;
      assert.equal(message.kind,'hello');
      assert.deepEqual(message.protocol,protocol);
      assert.equal(message.sessionId,sessionId);
      assert.equal(message.nonce,nonce);
      const oversized=Buffer.alloc(4);oversized.writeUInt32LE(release.audioProtocol.maxMessageBytes+1);
      socket.write(oversized);
      assert.equal(await exited(child),3);
    }finally{socket.destroy();child.kill();}
  });
  test('native IPC rejects incompatible major before accepting playback',async()=>{
    const {child,socket,sessionId,nonce}=await start();
    try{
      socket.write(encodeFrame({protocol:{major:release.audioProtocol.major+1,minor:0},kind:'hello',buildId:release.mainBuildId,sessionId,nonce,maxMessageBytes:release.audioProtocol.maxMessageBytes}));
      assert.equal(await exited(child),3);
    }finally{socket.destroy();child.kill();}
  });
}
