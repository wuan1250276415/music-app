// Invoked at MVP validation; source batches only compile this harness.
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const executable=path.resolve(__dirname,'../native/audio-host/build/dsd-gold.exe');
const result=spawnSync(executable,[],{windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:65536});
assert.ifError(result.error);
assert.equal(result.status,0,result.stderr||'DSD software gold failed');
assert.deepEqual(JSON.parse(result.stdout),{cases:13,devicesOpened:0,asioLoaded:false});
console.log('DSD software gold passed; device certification remains pending');
