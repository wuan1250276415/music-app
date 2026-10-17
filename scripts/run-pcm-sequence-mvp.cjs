const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{createHash,randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..'),fixtures=path.join(root,'tests/fixtures/decoder-gold'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'aural-pcm-sequence-')),exe=path.join(root,'native/audio-host/build/pcm-sequence-gold.exe');
const hash=value=>createHash('sha256').update(value).digest('hex'),fileHash=name=>hash(fs.readFileSync(name));
const manifest=require('../tests/fixtures/decoder-gold/manifest.json');for(const item of manifest.cases)assert.equal(fileHash(path.join(fixtures,item.file)),item.sha256);
const report={version:require('../package.json').version,completed:false,scope:'producer core only: actual production PCM adapter, independent lossless PCM and separately composed lossy baselines; no audio-host/queue/UI/device integration or physical gapless acceptance',cases:[],failures:[],scratch};
const source=(name,start=0,end=48000*13/4)=>({entryId:randomUUID(),file:path.join(fixtures,name),start,end});
function independent(sources,format){return Buffer.concat(sources.map(s=>{const name=path.basename(s.file),bits=name.includes('-24.')?24:16,bytes=format==='s16'?2:4,result=Buffer.alloc((s.end-s.start)*2*bytes);for(let frame=s.start;frame<s.end;frame++)for(let channel=0;channel<2;channel++){const i=frame*2+channel,full=(i*937%16000001)-8000000,value=bits===16?full>>8:full,offset=((frame-s.start)*2+channel)*bytes;if(format==='f32')result.writeFloatLE(value/(bits===16?32768:8388608),offset);else if(format==='s16')result.writeInt16LE(value,offset);else result.writeInt32LE(value<<(32-bits),offset);}return result;}));}
function run(id,sources,extra={},expected={}){
 const total=sources.reduce((sum,s)=>sum+s.end-s.start,0),boundaries=sources.reduce((a,s)=>{a.push((a.at(-1)||0)+s.end-s.start);return a;},[]),seeks=[0,total-1,Math.floor(total/2),...boundaries.filter((_,i)=>i<12||i===boundaries.length-2).flatMap(n=>[n-1,n,n+1])].filter(n=>n>=0&&n<total);
 const request={sources,seeks,...extra},filename=path.join(scratch,id+'.json');
 if(expected.format){const reference=path.join(scratch,id+'.pcm');fs.writeFileSync(reference,independent(sources,expected.format));request.reference=reference;}
 fs.writeFileSync(filename,JSON.stringify(request));const process=spawnSync(exe,[filename],{cwd:path.dirname(exe),encoding:'utf8',windowsHide:true,timeout:130000,maxBuffer:8*1024*1024});let result;
 try{result=JSON.parse(process.stdout.trim());assert.equal(process.status,0,result.error||process.stderr||process.error?.message);assert.equal(result.completed,true);if(expected.opens!==undefined)assert.equal(result.sequentialOpens,expected.opens);if(expected.shared!==undefined)assert.equal(result.sharedCueTransitions,expected.shared);if(expected.format){assert.equal(result.format,expected.format);assert.equal(result.decodedSha256,fileHash(request.reference));}if(extra.replaceReleasedSource)assert.equal(result.replacementRejected,true);report.cases.push({id,...result});console.log(id+': passed');}
 catch(error){report.failures.push({id,error:error.message,result});console.error(id+': '+error.message);}
}
const split=(name,count,end)=>Array.from({length:count},(_,i)=>source(name,Math.floor(i*end/count),Math.floor((i+1)*end/count)));
const frames48=48000*13/4,frames44=44100*13/4;
run('four-lossless-files-f32',['wav-48000-16.wav','flac-48000-16.flac','alac-48000-16.m4a','wav-48000-16.wav'].map(n=>source(n)),{verifyReadLocks:true},{format:'f32',opens:4,shared:0});
run('lossless-mixed-24-f32',['wav-48000-24.wav','flac-48000-24.flac','alac-48000-24.m4a'].map(n=>source(n,17,frames48-13)),{},{format:'f32',opens:3});
run('lossless-integer-s16',['wav-48000-16.wav','flac-48000-16.flac','alac-48000-16.m4a'].map(n=>source(n)),{integer:true},{format:'s16',opens:3});
run('lossless-integer-s32',['wav-44100-24.wav','flac-44100-24.flac','alac-44100-24.m4a'].map(n=>source(n,1,frames44-1)),{integer:true},{format:'s32',opens:3});
for(const [name,end] of [['mp3-mp3-44100.mp3',frames44],['aac-m4a-48000.m4a',frames48],['vorbis-ogg-48000.ogg',frames48],['opus-opus-48000.opus',frames48]])run('lossy-'+name,Array.from({length:4},()=>source(name,0,end)),{},{opens:4,shared:0});
run('mixed-lossy-same-pcm',['mp3-mp3-48000.mp3','aac-m4a-48000.m4a','vorbis-ogg-48000.ogg','opus-opus-48000.opus'].map(n=>source(n)),{},{opens:4});
run('cue-31-exact-non-sector-spans',split('flac-44100-24.flac',31,frames44),{},{format:'f32',opens:1,shared:30});
run('cue-500-short-spans',split('wav-48000-16.wav',500,frames48),{},{format:'f32',opens:1,shared:499});
run('cue-file-cue-rolling',[...split('flac-48000-24.flac',9,frames48),source('alac-48000-24.m4a'),...split('wav-48000-24.wav',7,frames48)],{},{format:'f32',opens:3,shared:14});
run('same-image-disjoint-spans',[source('flac-48000-16.flac',10000,17001),source('flac-48000-16.flac',0,1023),source('flac-48000-16.flac',1024,4017),source('flac-48000-16.flac',10000,17001)],{},{format:'f32',opens:4,shared:0});
const first=path.join(scratch,'replace-released.wav');fs.copyFileSync(path.join(fixtures,'wav-48000-16.wav'),first);
run('physical-file-replacement-on-backward-seek',[{...source('wav-48000-16.wav'),file:first},source('flac-48000-16.flac')],{replaceReleasedSource:path.join(fixtures,'wav-48000-16.wav')},{format:'f32',opens:2});
run('empty-plan',[],{expectOpenFailure:-2});
const duplicate=source('wav-48000-16.wav');run('duplicate-entry-id',[duplicate,{...duplicate}],{expectOpenFailure:-2});
run('oversized-plan',Array.from({length:501},()=>source('wav-48000-16.wav',0,1)),{expectOpenFailure:-2});
run('empty-span',[source('wav-48000-16.wav',1,1)],{expectOpenFailure:-2});
run('frame-overflow',[source('wav-48000-16.wav',0,9007199254740992)],{expectOpenFailure:-2});
run('missing-first',[{...source('wav-48000-16.wav'),file:path.join(scratch,'missing.wav')}],{expectOpenFailure:-7});
run('missing-next',[source('wav-48000-16.wav'),{...source('wav-48000-16.wav'),file:path.join(scratch,'missing.wav')}],{expectOpenFailure:-7});
run('different-rate',[source('wav-48000-16.wav'),source('wav-44100-16.wav',0,frames44)],{expectOpenFailure:-200});
const mono=Buffer.from(fs.readFileSync(path.join(fixtures,'wav-48000-16.wav')));mono.writeUInt16LE(1,22);mono.writeUInt32LE(48000*2,28);mono.writeUInt16LE(2,32);const monoFile=path.join(scratch,'mono.wav');fs.writeFileSync(monoFile,mono);
run('different-layout',[source('wav-48000-16.wav'),{...source('wav-48000-16.wav'),file:monoFile}],{expectOpenFailure:-200});
run('different-integer-output',[source('wav-48000-16.wav'),source('flac-48000-24.flac')],{integer:true,expectOpenFailure:-200});
run('foreign-file-binding',[{...source('wav-48000-16.wav'),expectedBinding:{version:1,kind:'windows-readonly-handle',volumeSerial:'0',fileIndex:'0',byteLength:'1',lastWriteTicks:'0',shareMode:'read-only',certification:'pending'}}],{expectOpenFailure:-33});
run('cancel-before-open',[source('wav-48000-16.wav')],{cancelBeforeOpen:true,expectOpenFailure:-51});
run('cancel-before-read',[source('wav-48000-16.wav')],{cancelAfterOpen:true,expectReadFailure:-51});
run('premature-eof-not-silence',[source('wav-48000-16.wav',0,frames48+17)],{expectReadFailure:-10});
run('later-missing-source',[source('wav-48000-16.wav'),source('flac-48000-16.flac'),{...source('wav-48000-16.wav'),file:path.join(scratch,'missing.wav')}],{expectReadFailure:-7});
run('later-rate-change',[source('wav-48000-16.wav'),source('flac-48000-16.flac'),source('wav-44100-16.wav',0,frames44)],{expectReadFailure:-200});
report.completed=report.failures.length===0;report.devicesOpened=0;report.audioHostIntegrated=false;report.crossFileGaplessHardwareVerified=false;
report.fingerprints=Object.fromEntries(['native/audio-host/pcm-sequence.hpp','native/audio-host/pcm-sequence-gold.cpp','native/audio-host/ffmpeg-decoder.hpp','native/audio-host/build-pcm-sequence-gold.ps1','native/audio-host/build/pcm-sequence-gold.exe','scripts/run-pcm-sequence-mvp.cjs','tests/fixtures/decoder-gold/manifest.json',...require('../native/ffmpeg/lock.json').libraries.map(n=>'native/audio-host/build/'+n)].map(n=>[n,fileHash(path.join(root,n))]));
if(process.env.AURAL_PCM_SEQUENCE_REPORT)fs.writeFileSync(process.env.AURAL_PCM_SEQUENCE_REPORT,JSON.stringify(report,null,2));console.log(JSON.stringify({completed:report.completed,passed:report.cases.length,failed:report.failures.length,scratch}));process.exitCode=report.completed?0:1;
