const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {_electron}=require(process.env.AURAL_PLAYWRIGHT_MODULE||'playwright-core');
const {DatabaseSync}=require('node:sqlite');
const {LibraryDatabase}=require('../dist/main/library/database.js');
const {scanRoot}=require('../dist/main/library/scanner.js');

async function until(check,label,timeout=10000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await check();if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error(`Timed out: ${label}`);
}

async function main(){
  const root=path.resolve(__dirname,'..');
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-ui-pressure-'));
  const data=path.join(scratch,'userdata');
  const music=path.join(scratch,'music');
  fs.mkdirSync(path.join(data,'library'),{recursive:true});fs.mkdirSync(music,{recursive:true});
  const sampleRate=44100,frames=sampleRate*15,pcm=Buffer.alloc(frames*4),header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);
  header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(sampleRate*4,28);
  header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);header.write('data',36);
  header.writeUInt32LE(pcm.length,40);
  fs.writeFileSync(path.join(music,'pressure.wav'),Buffer.concat([header,pcm]));
  const db=new LibraryDatabase(path.join(data,'library','library.db'));
  await scanRoot(db,db.addRoot(music),()=>{});db.close();
  const legacyV3=process.env.AURAL_PRESSURE_LEGACY_V3==='1';
  if(legacyV3){
    const legacy=new DatabaseSync(path.join(data,'library','library.db'));
    require('./legacy-schema.cjs').stripV5(legacy);
    legacy.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; DROP TABLE playable_span; DROP TABLE media_stream; PRAGMA user_version=3; COMMIT;');
    legacy.close();
  }
  const installed=process.env.AURAL_PRESSURE_EXE;
  const app=await _electron.launch({executablePath:installed||path.join(root,'node_modules','electron','dist','electron.exe'),
    args:installed?[]:[root],env:{...process.env,AURAL_TEST:'1',AURAL_TEST_DATA_DIR:data}});
  try{
    app.process().stderr?.on('data',d=>console.error('ELECTRON:',String(d)));
    const win=await app.firstWindow();await win.locator('.track-row').first().waitFor({timeout:15000});
    if(legacyV3){
      const backups=fs.readdirSync(path.join(data,'library')).filter(name=>name.includes('.pre-v4-')&&name.endsWith('.bak'));
      assert.equal(backups.length,1);
    }
    const items=(await win.evaluate(()=>window.music.list({view:'all',limit:100}))).items;
    assert.equal(items.length,1);
    await win.evaluate(async id=>window.music.play(id,[id],{commandId:crypto.randomUUID(),baseRevision:(await window.music.queue()).revision}),items[0].id);
    const before=await until(async()=>{
      const value=await win.evaluate(()=>window.music.playback());
      return value.state==='playing'&&value.diagnostics?.callbackCount>10?value:null;
    },'playing telemetry');
    const busyMs=3000;
    await win.evaluate(duration=>{
      const node=document.createElement('div');node.style.position='fixed';node.style.top='0';
      document.body.append(node);
      const deadline=performance.now()+duration;
      for(let i=0;performance.now()<deadline;i++){
        node.style.width=`${i%120}px`;
        node.getBoundingClientRect();
      }
      node.remove();
    },busyMs);
    const after=await until(async()=>{
      const value=await win.evaluate(()=>window.music.playback());
      return value.diagnostics?.callbackCount>before.diagnostics.callbackCount?value:null;
    },'telemetry after renderer pressure');
    const deltaCallbacks=after.diagnostics.callbackCount-before.diagnostics.callbackCount;
    const deltaUnderrunFrames=after.diagnostics.bufferUnderrunFrames-before.diagnostics.bufferUnderrunFrames;
    const deltaUnderrunCallbacks=after.diagnostics.bufferUnderrunCallbacks-before.diagnostics.bufferUnderrunCallbacks;
    assert.ok(after.positionSeconds-before.positionSeconds>=2.5,
      `timeline did not progress: ${before.positionSeconds} → ${after.positionSeconds}`);
    assert.ok(deltaCallbacks>0);
    assert.equal(deltaUnderrunFrames,0,`buffer starvation under renderer pressure: ${deltaUnderrunFrames} frames`);
    assert.equal(deltaUnderrunCallbacks,0);
    console.log({busyMs,deltaCallbacks,deltaUnderrunCallbacks,deltaUnderrunFrames,
      beforeSeconds:before.positionSeconds,afterSeconds:after.positionSeconds});
    const queueCommands=await win.evaluate(async()=>{
      const before=await window.music.queue();
      const duplicate={commandId:crypto.randomUUID(),baseRevision:before.revision};
      const [first,second]=await Promise.all([
        window.music.setRepeat('all',duplicate),window.music.setRepeat('all',duplicate)
      ]);
      const stale=await window.music.setRepeat('one',
        {commandId:crypto.randomUUID(),baseRevision:before.revision})
        .then(()=>false,error=>String(error).includes('队列版本已变化'));
      const after=await window.music.queue();
      return {before:before.revision,first:first.revision,second:second.revision,
        after:after.revision,repeat:after.repeat,stale};
    });
    assert.equal(queueCommands.first,queueCommands.before+1);
    assert.equal(queueCommands.second,queueCommands.first);
    assert.equal(queueCommands.after,queueCommands.first);
    assert.equal(queueCommands.repeat,'all');
    assert.equal(queueCommands.stale,true);
    await win.evaluate(()=>window.music.stop());
  }finally{
    await app.close();
    if(path.dirname(scratch)===os.tmpdir()&&path.basename(scratch).startsWith('aural-ui-pressure-'))
      fs.rmSync(scratch,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
