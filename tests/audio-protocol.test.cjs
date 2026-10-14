const test=require('node:test');
const assert=require('node:assert/strict');
const {FrameReader,encodeFrame}=require('../dist/main/main/audio-protocol.js');

test('audio frames handle split headers, split UTF-8 and coalesced messages',()=>{
  const seen=[];const reader=new FrameReader(value=>seen.push(value));
  const first=encodeFrame({kind:'event',payload:{title:'序曲'}});
  const second=encodeFrame({kind:'receipt',accepted:true});
  reader.push(first.subarray(0,2));reader.push(first.subarray(2,7));reader.push(Buffer.concat([first.subarray(7),second]));
  assert.deepEqual(seen,[{kind:'event',payload:{title:'序曲'}},{kind:'receipt',accepted:true}]);
  reader.finish();
});

test('audio frames reject oversized, malformed, invalid UTF-8 and truncated input',()=>{
  const receive=()=>{};
  const length=Buffer.alloc(4);length.writeUInt32LE(1024*1024+1);
  assert.throws(()=>new FrameReader(receive).push(length),/长度无效/);
  const invalid=Buffer.from([1,0,0,0,0xff]);
  assert.throws(()=>new FrameReader(receive).push(invalid));
  const malformed=Buffer.from([1,0,0,0,0x5b]);
  assert.throws(()=>new FrameReader(receive).push(malformed),/Unexpected end|JSON/);
  const reader=new FrameReader(receive);reader.push(encodeFrame({a:1}).subarray(0,5));
  assert.throws(()=>reader.finish(),/不完整帧/);
});
