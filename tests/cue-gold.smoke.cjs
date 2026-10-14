const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');

if(process.platform==='win32')test('native decoder slices adjacent CUE spans sample for sample',()=>{
  const executable=path.resolve(__dirname,'../native/audio-host/build/cue-gold.exe');
  const fixtures=[
    path.resolve(__dirname,'../native/audio-host/testdata/cue-gold-44100-16bit.flac'),
    path.resolve(__dirname,'../native/audio-host/testdata/cue-gold-48000-24bit.flac')
  ];
  const result=spawnSync(executable,fixtures,{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/44100\/48000\/44117 Hz/);
  assert.match(result.stdout,/FLAC 16-bit\/24-bit gold passed/);
  assert.match(result.stdout,/integer PCM gold passed/);
  assert.match(result.stdout,/continuous two-span gold passed/);
});
