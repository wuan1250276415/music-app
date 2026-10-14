const fs=require('node:fs');

function safe(size){const out=Buffer.alloc(4);out[0]=(size>>>21)&127;out[1]=(size>>>14)&127;out[2]=(size>>>7)&127;out[3]=size&127;return out;}
function tag(version,pictures,title='封面格式验证'){
 const frame=(id,body,flags=0)=>{const header=Buffer.alloc(10);header.write(id);(version===4?safe(body.length):(()=>{const size=Buffer.alloc(4);size.writeUInt32BE(body.length);return size;})()).copy(header,4);header[9]=flags;return Buffer.concat([header,body]);};
 const frames=[frame('TIT2',Buffer.concat([Buffer.from([1,255,254]),Buffer.from(title,'utf16le')])),frame('TPE1',Buffer.concat([Buffer.from([1,255,254]),Buffer.from('格式验证歌手','utf16le')])),frame('TALB',Buffer.concat([Buffer.from([1,255,254]),Buffer.from('格式验证专辑','utf16le')]))];
 for(const picture of pictures)frames.push(frame('APIC',Buffer.concat([Buffer.from([0]),Buffer.from('image/png\0','latin1'),Buffer.from([picture.type??3,0]),picture.bytes]),picture.flags??0));
 const body=Buffer.concat(frames),header=Buffer.alloc(10);header.write('ID3');header[3]=version;safe(body.length).copy(header,6);return Buffer.concat([header,body]);
}
function chunk(id,body,sentinel=false){const header=Buffer.alloc(8);header.write(id);header.writeUInt32LE(sentinel?0xffffffff:body.length,4);return Buffer.concat([header,body,body.length&1?Buffer.alloc(1):Buffer.alloc(0)]);}
function format(){const b=Buffer.alloc(16);b.writeUInt16LE(1);b.writeUInt16LE(2,2);b.writeUInt32LE(44100,4);b.writeUInt32LE(176400,8);b.writeUInt16LE(4,12);b.writeUInt16LE(16,14);return b;}
function wav(id3,{rf64=false,table=false}={}){
 const pcm=Buffer.alloc(44100*2*4),parts=[chunk('fmt ',format()),chunk('JUNK',Buffer.from([1,2,3]),table),chunk('JUNK',Buffer.from([4,5,6,7,8]),table),chunk('data',pcm,rf64)];
 if(id3)parts.push(chunk('id3 ',id3,table));
 const header=Buffer.alloc(12);header.write(rf64?'RF64':'RIFF');header.write('WAVE',8);
 if(!rf64){header.writeUInt32LE(4+parts.reduce((sum,p)=>sum+p.length,0),4);return Buffer.concat([header,...parts]);}
 const overrides=table?[['JUNK',3n],['JUNK',5n],...(id3?[['id3 ',BigInt(id3.length)]]:[])]:[],ds64=Buffer.alloc(28+12*overrides.length);
 ds64.writeBigUInt64LE(BigInt(4+8+ds64.length+parts.reduce((sum,p)=>sum+p.length,0)));ds64.writeBigUInt64LE(BigInt(pcm.length),8);ds64.writeBigUInt64LE(88200n,16);ds64.writeUInt32LE(overrides.length,24);
 overrides.forEach(([id,length],i)=>{ds64.write(id,28+i*12);ds64.writeBigUInt64LE(length,32+i*12);});header.writeUInt32LE(0xffffffff,4);return Buffer.concat([header,chunk('ds64',ds64),...parts]);
}
function dsf(id3){
 const sampleCount=2822400*2,perChannel=Math.ceil(sampleCount/8/4096)*4096,payload=Buffer.alloc(perChannel*2,0x69);
 const header=Buffer.alloc(28),fmt=Buffer.alloc(52),data=Buffer.alloc(12);header.write('DSD ');header.writeBigUInt64LE(28n,4);header.writeBigUInt64LE(BigInt(92+payload.length+(id3?.length??0)),12);header.writeBigUInt64LE(id3?BigInt(92+payload.length):0n,20);
 fmt.write('fmt ');fmt.writeBigUInt64LE(52n,4);fmt.writeUInt32LE(1,12);fmt.writeUInt32LE(2,20);fmt.writeUInt32LE(2,24);fmt.writeUInt32LE(2822400,28);fmt.writeUInt32LE(1,32);fmt.writeBigUInt64LE(BigInt(sampleCount),36);fmt.writeUInt32LE(4096,44);data.write('data');data.writeBigUInt64LE(BigInt(12+payload.length),4);
 return Buffer.concat([header,fmt,data,payload,...(id3?[id3]:[])]);
}
// Caller first marks this owned file sparse. The declared audio is >4GiB;
// only metadata/headers are physically written. No large buffer is allocated.
function largeRf64(filename,id3){
 const audioBytes=0x100000010,header=Buffer.alloc(80);header.write('RF64');header.writeUInt32LE(0xffffffff,4);header.write('WAVEds64',8);header.writeUInt32LE(28,16);header.writeBigUInt64LE(BigInt(80+audioBytes+8+id3.length+(id3.length&1)-8),20);header.writeBigUInt64LE(BigInt(audioBytes),28);header.writeBigUInt64LE(BigInt(audioBytes/4),36);chunk('fmt ',format()).copy(header,48);header.write('data',72);header.writeUInt32LE(0xffffffff,76);
 const fd=fs.openSync(filename,'r+');try{fs.writeSync(fd,header,0,header.length,0);fs.writeSync(fd,chunk('ID3 ',id3),0,8+id3.length+(id3.length&1),80+audioBytes);}finally{fs.closeSync(fd);}
 return {audioBytes,metadataAt:80+audioBytes,fileBytes:80+audioBytes+8+id3.length+(id3.length&1)};
}
module.exports={tag,wav,dsf,largeRf64};
