const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {AudioController}=require('../dist/main/main/audio.js');

function writeWav(file){
  const rate=44100,frames=rate*12,pcm=Buffer.alloc(frames*4),header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);
  header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*4,28);
  header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);
  header.write('data',36);header.writeUInt32LE(pcm.length,40);
  fs.writeFileSync(file,Buffer.concat([header,pcm]));
}

async function until(predicate,message){
  const deadline=Date.now()+5000;
  while(!predicate()){
    if(Date.now()>deadline)throw new Error(message);
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}

if(process.platform==='win32')test('controller reconciles a crashed host and starts a fresh session',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aural-audio-crash-'));
  const media=path.join(directory,'silence.wav');writeWav(media);
  const executable=path.resolve(__dirname,'../native/audio-host/build/audio-host.exe');
  const published=[];
  const audio=new AudioController(executable,state=>published.push(state));
  const item={id:'crash-test',path:media,available:true,sourceStartSeconds:0,sourceEndSeconds:null,durationSeconds:12};
  try{
    await audio.play(item);
    await until(()=>audio.snapshot().state==='playing','initial host did not start');
    const first=audio.session.process;
    first.kill();
    await until(()=>audio.snapshot().state==='error','host crash did not reach error state');
    assert.match(audio.snapshot().message,/音频进程退出|音频通道意外关闭/);
    assert.ok(published.some(state=>state.state==='error'));

    await audio.play(item);
    await until(()=>audio.snapshot().state==='playing','replacement host did not start');
    const second=audio.session.process;
    assert.notEqual(first.pid,second.pid);
    audio.stop();
    await until(()=>second.exitCode!==null||second.signalCode!==null,'replacement host did not exit');
  }finally{
    audio.stop();
    await Promise.all([...audio.retired]);
    fs.unlinkSync(media);fs.rmdirSync(directory);
  }
});

if(process.platform==='win32')test('rapid track switches retire each host before starting its successor',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aural-audio-switch-'));
  const media=path.join(directory,'silence.wav');writeWav(media);
  const executable=path.resolve(__dirname,'../native/audio-host/build/audio-host.exe');
  const audio=new AudioController(executable,()=>{});
  const item={id:'switch-test',path:media,available:true,sourceStartSeconds:0,sourceEndSeconds:null,durationSeconds:12};
  try{
    let previous=null;
    for(let index=0;index<4;index++){
      await audio.play({...item,id:`switch-${index}`});
      await until(()=>audio.snapshot().state==='playing',`host ${index} did not start`);
      const current=audio.session.process;
      if(previous){
        assert.ok(previous.exitCode!==null||previous.signalCode!==null,`host ${index-1} remained alive`);
        assert.notEqual(previous.pid,current.pid);
      }
      previous=current;
    }
    audio.stop();
    await until(()=>previous.exitCode!==null||previous.signalCode!==null,'last host did not exit');
  }finally{
    audio.stop();
    await Promise.all([...audio.retired]);
    fs.unlinkSync(media);fs.rmdirSync(directory);
  }
});

if(process.platform==='win32')test('controller waits for seek completion and coalesces queued targets',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aural-audio-seek-'));
  const media=path.join(directory,'silence.wav');writeWav(media);
  const executable=path.resolve(__dirname,'../native/audio-host/build/audio-host.exe');
  const audio=new AudioController(executable,()=>{});
  const item={id:'seek-test',path:media,available:true,sourceStartSeconds:0,sourceEndSeconds:null,durationSeconds:12};
  try{
    await audio.play(item);
    await until(()=>audio.snapshot().state==='playing','host did not start');
    const pid=audio.session.process.pid;
    await assert.rejects(audio.seek(-1),/无效跳转位置/);
    const first=audio.seek(2);
    const superseded=audio.seek(3);
    const latest=audio.seek(5);
    const states=await Promise.all([first,superseded,latest]);
    assert.ok(states[0].positionSeconds>=2&&states[0].positionSeconds<2.5);
    assert.ok(states[1].positionSeconds>=5&&states[1].positionSeconds<5.5);
    assert.ok(states[2].positionSeconds>=5&&states[2].positionSeconds<5.5);
    assert.equal(audio.session.process.pid,pid);
    audio.pause();
    await until(()=>audio.snapshot().state==='paused','pause did not complete');
    const paused=await audio.seek(1.25);
    assert.equal(paused.state,'paused');
    assert.equal(paused.positionSeconds,1.25);
  }finally{
    audio.stop();
    await Promise.all([...audio.retired]);
    fs.unlinkSync(media);fs.rmdirSync(directory);
  }
});
