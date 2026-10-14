const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {MediaParser}=require('../dist/main/library/media-worker-client.js');
const {mediaStat}=require('../dist/main/library/media-worker-protocol.js');
const {createHash}=require('node:crypto');

const fixtures=path.join(__dirname,'fixtures');
function imageToken(file){return createHash('sha256').update(fs.readFileSync(path.join(fixtures,file))).digest('hex');}
async function loadArtwork(item){
  const handle=await fs.promises.open(item.path,'r');
  try{
    const rootPath=path.dirname(item.path),parser=new MediaParser(),signal=new AbortController().signal;
    const request={rootPath,realRootPath:await fs.promises.realpath(rootPath),fullPath:item.path,relativePath:path.basename(item.path),before:mediaStat(await handle.stat()),thumbnailSize:256,rejectedTokens:[]};
    const embedded=await parser.artwork({...request,artworkSource:'embedded'},signal);
    return embedded??await parser.artwork({...request,artworkSource:'sidecar'},signal);
  }
  finally{await handle.close();}
}
function workspace(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aural-artwork-'));
  t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});
  return dir;
}

test('embedded audio artwork takes priority over a nearby cover for file and CUE items',async t=>{
  const dir=workspace(t);
  const audio=path.join(dir,'song.mp3');
  fs.copyFileSync(path.join(fixtures,'embedded-cover.mp3'),audio);
  fs.copyFileSync(path.join(fixtures,'sidecar-blue.png'),path.join(dir,'cover.png'));
  const expected=imageToken('embedded-red.png');
  for(const kind of ['file','cue']){const image=await loadArtwork({path:audio,kind});assert.equal(image.token,expected);assert.equal(image.sourceKind,'embedded');assert.match(image.url,/^data:image\/jpeg;base64,/);assert.ok(image.width<=256&&image.height<=256);}
});

test('local folder cover is used when the audio file has no embedded picture',async t=>{
  const dir=workspace(t);
  const audio=path.join(dir,'untagged.wav');
  const wave=Buffer.alloc(46);wave.write('RIFF');wave.writeUInt32LE(38,4);wave.write('WAVE',8);wave.write('fmt ',12);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(44100,24);wave.writeUInt32LE(88200,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(2,40);
  fs.writeFileSync(audio,wave);
  fs.copyFileSync(path.join(fixtures,'sidecar-blue.png'),path.join(dir,'folder.png'));
  const image=await loadArtwork({path:audio,kind:'file'});assert.equal(image.token,imageToken('sidecar-blue.png'));assert.equal(image.sourceKind,'sidecar');
  fs.unlinkSync(path.join(dir,'folder.png'));
  assert.equal(await loadArtwork({path:audio,kind:'file'}),null);
});
