const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');

if(process.platform==='win32')test('native PCM callback consumes exact ring frames',()=>{
  const executable=path.resolve(__dirname,'../native/audio-host/build/pcm-ring-gold.exe');
  const result=spawnSync(executable,[],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/PCM ring wrap, boundary, cancellation, seek isolation and underrun gold passed/);
});
