import type {FileHandle} from 'node:fs/promises';
import type {IPicture} from 'music-metadata';
import {MAX_IMAGE_BYTES} from './artwork.js';

const MAX_TAG_BYTES=32*1024*1024;
type Read=(position:number,length:number)=>Promise<Buffer>;
export interface Id3ArtworkResult {pictures:IPicture[];container:'other'|'id3'|'dsf'|'wav'|'rf64';complete:boolean}
type TagLocation={position:number;limit:number};

// EBU Tech3306: ds64 is first; sentinel sizes use its primary data size or
// ordered additional chunk sizes. Seek over audio, never allocate its payload.
async function waveTagLocations(read:Read,head:Buffer,size:number):Promise<TagLocation[]> {
  const rf64=head.toString('ascii',0,4)==='RF64',locations:TagLocation[]=[];
  let end=head.readUInt32LE(4)+8,position=12,dataSize:bigint|null=null,primaryData=false;
  const table:Array<{id:string;size:bigint;used:boolean}>=[];
  if(rf64){
    const header=await read(12,8),length=header.readUInt32LE(4);
    if(header.toString('ascii',0,4)!=='ds64'||length<28||length>28+1024*12||20+length+(length&1)>size)throw new Error('RF64 长度表无效或超过预算');
    const values=await read(20,length),count=values.readUInt32LE(24);
    if(count>1024||28+count*12>length)throw new Error('RF64 长度表不完整或超过预算');
    const riffSize=values.readBigUInt64LE(0);dataSize=values.readBigUInt64LE(8);
    const extent=head.readUInt32LE(4)===0xffffffff?riffSize+8n:BigInt(end);
    if(extent>BigInt(size)||extent>BigInt(Number.MAX_SAFE_INTEGER)||extent<BigInt(20+length+(length&1)))throw new Error('RF64 容器边界无效');
    end=Number(extent);position=20+length+(length&1);
    for(let i=0;i<count;i++)table.push({id:values.toString('latin1',28+i*12,32+i*12),size:values.readBigUInt64LE(32+i*12),used:false});
  }else if(end<12||end>size)throw new Error('WAV 封面块边界无效');
  let chunks=0;
  while(position<end){
    if(++chunks>1024||position+8>end)throw new Error('WAV 封面块链不完整或超过预算');
    const chunk=await read(position,8),id=chunk.toString('latin1',0,4),short=chunk.readUInt32LE(4);
    if(rf64&&id==='ds64')throw new Error('RF64 长度表重复');
    let length=BigInt(short);
    if(rf64&&short===0xffffffff){
      if(id==='data'&&!primaryData){length=dataSize!;primaryData=true;}
      else{const entry=table.find(value=>!value.used&&value.id===id);if(!entry)throw new Error('RF64 块缺少有效长度');entry.used=true;length=entry.size;}
    }else if(id==='data')primaryData=true;
    const start=position+8,next=BigInt(start)+length+(length&1n);
    if(next>BigInt(end)||next>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('WAV 封面块越界');
    if(id.toLowerCase()==='id3 '){
      if(locations.length>=4)throw new Error('WAV 内嵌标签数量超过预算');
      if(length<10n)throw new Error('WAV 内嵌标签不完整');
      locations.push({position:start,limit:start+Number(length)});
    }
    position=Number(next);
  }
  return locations;
}

function synchsafe(bytes:Buffer,offset:number):number {
  if(offset+4>bytes.length||bytes.subarray(offset,offset+4).some(value=>value>127))throw new Error('ID3 长度字段无效');
  return bytes[offset]*2097152+bytes[offset+1]*16384+bytes[offset+2]*128+bytes[offset+3];
}

function tagExtent(header:Buffer,position:number,limit:number):{version:3|4;length:number;end:number}|null {
  if(header.toString('ascii',0,3)!=='ID3')return null;
  const version=header[3];if(version!==3&&version!==4)return null;
  if(header[4]===255||header[5]&(version===3?31:15))throw new Error('ID3 封面标签头无效');
  const length=synchsafe(header,6),end=position+10+length+(version===4&&header[5]&16?10:0);
  if(length>MAX_TAG_BYTES-20||end>limit)throw new Error('ID3 封面标签越界或超过预算');
  return {version,length,end};
}

// Reverse once: v2.3 transforms the entire tag body; v2.4 transforms each frame.
// Work in the bounded owned buffer, never in an audio or database buffer.
function deunsynchronise(bytes:Buffer):Buffer {
  let target=0;
  for(let source=0;source<bytes.length;source++){
    const value=bytes[source];bytes[target++]=value;
    if(value===255&&bytes[source+1]===0)source++;
  }
  return bytes.subarray(0,target);
}

function attachedPicture(frame:Buffer,version:3|4):IPicture|null {
  if(frame.length<5)return null;
  const encoding=frame[0];if(encoding>(version===3?1:3))return null;
  const mimeEnd=frame.indexOf(0,1);
  if(mimeEnd<1||mimeEnd>1025||mimeEnd+2>=frame.length)return null;
  const mime=frame.toString('latin1',1,mimeEnd);if(mime==='-->')return null;
  const type=frame[mimeEnd+1];if(type>20)return null;
  const descriptionAt=mimeEnd+2,wide=encoding===1||encoding===2;
  let imageAt=-1;
  for(let offset=descriptionAt;offset<Math.min(frame.length,descriptionAt+64*1024+2);offset+=wide?2:1){
    if(frame[offset]===0&&(!wide||frame[offset+1]===0)){imageAt=offset+(wide?2:1);break;}
  }
  if(imageAt<0||imageAt>=frame.length||frame.length-imageAt>MAX_IMAGE_BYTES)return null;
  return {format:mime,data:frame.subarray(imageAt),type:type===3?'Cover (front)':'Other'};
}

function tagPictures(raw:Buffer,header:Buffer,version:3|4):{pictures:IPicture[];complete:boolean} {
  const body=version===3&&header[5]&128?deunsynchronise(raw):raw;
  let offset=0;
  if(header[5]&64){
    if(body.length<6)throw new Error('ID3 扩展标签头不完整');
    if(version===3){
      const length=body.readUInt32BE(0),flags=body.readUInt16BE(4);
      if(flags&32767||length!==(flags&32768?10:6)||length+4>body.length)throw new Error('ID3 扩展标签头无效');
      offset=length+4;
      if(body.readUInt32BE(6)>body.length-offset)throw new Error('ID3 填充长度无效');
    }else{
      const length=synchsafe(body,0),flags=body[5];
      if(length<6||length>body.length||body[4]!==1||flags&143)throw new Error('ID3 扩展标签头无效');
      let field=6;
      for(const [flag,expected] of [[64,0],[32,5],[16,1]])if(flags&flag){
        if(field>=length||body[field++]!==expected||field+expected>length)throw new Error('ID3 扩展字段无效');
        field+=expected;
      }
      if(field!==length)throw new Error('ID3 扩展字段长度无效');
      offset=length;
    }
  }
  const pictures:IPicture[]=[];let frames=0,pictureFrames=0,complete=true;
  while(offset<body.length){
    if(body[offset]===0){
      if(body.subarray(offset).some(value=>value!==0))throw new Error('ID3 填充内容无效');
      break;
    }
    if(++frames>4096||offset+10>body.length)throw new Error('ID3 封面帧链不完整或超过预算');
    const id=body.toString('latin1',offset,offset+4);
    if(!/^[A-Z0-9]{4}$/.test(id))throw new Error('ID3 帧身份无效');
    const length=version===3?body.readUInt32BE(offset+4):synchsafe(body,offset+4),end=offset+10+length;
    if(!length||end>body.length)throw new Error('ID3 帧长度越界');
    const format=body[offset+9];
    if(id==='APIC'){
      if(++pictureFrames>64)throw new Error('ID3 内嵌图片数量超过预算');
      // Compression/encryption and unknown format flags stay with the general
      // parser. Never treat their transformed bytes as an image or fetch a URL.
      const unsupported=version===3?format&223:format&188;
      if(unsupported)complete=false;
      if(!unsupported){
        let frame=body.subarray(offset+10,end);
        if(version===4&&(header[5]&128||format&2))frame=deunsynchronise(frame);
        let extra=format&(version===3?32:64)?1:0;
        if(version===4&&format&1){
          if(frame.length<extra+4)throw new Error('ID3 图片长度指示不完整');
          const expected=synchsafe(frame,extra);extra+=4;
          if(expected!==frame.length-extra)throw new Error('ID3 图片长度指示不一致');
        }
        const picture=attachedPicture(frame.subarray(extra),version);if(picture)pictures.push(picture);
      }
    }
    offset=end;
  }
  return {pictures,complete};
}

// Extract only APIC; malformed text, duration parsing and the audio payload do
// not participate. Callers keep the existing general parser for other formats.
export async function readId3Artwork(handle:FileHandle,size:number,signal:AbortSignal):Promise<Id3ArtworkResult> {
  const deadline=performance.now()+20000;let remaining=MAX_TAG_BYTES;
  const read:Read=async(position,length)=>{
    signal.throwIfAborted();
    if(performance.now()>deadline)throw new Error('ID3 封面读取超过时间预算');
    if(!Number.isSafeInteger(position)||!Number.isSafeInteger(length)||position<0||length<0||position+length>size||length>remaining)throw new Error('ID3 封面读取越界或超过预算');
    remaining-=length;const bytes=Buffer.alloc(length);let offset=0;
    while(offset<length){
      signal.throwIfAborted();if(performance.now()>deadline)throw new Error('ID3 封面读取超过时间预算');
      const result=await handle.read(bytes,offset,length-offset,position+offset);
      if(!result.bytesRead)throw new Error('ID3 封面数据不完整');offset+=result.bytesRead;
    }
    return bytes;
  };
  if(size<10)return {pictures:[],container:'other',complete:false};
  const head=await read(0,Math.min(size,28));
  const locations:TagLocation[]=[];let container:Id3ArtworkResult['container']='other',complete=true;
  if(head.toString('ascii',0,3)==='ID3'){container='id3';locations.push({position:0,limit:size});}
  else if(head.toString('ascii',0,4)==='DSD '){
    container='dsf';
    if(head.length!==28||head.readBigUInt64LE(4)!==28n||head.readBigUInt64LE(12)!==BigInt(size))throw new Error('DSF 封面定位头无效');
    const pointer=head.readBigUInt64LE(20);if(pointer===0n)return {pictures:[],container,complete:true};
    if(pointer>BigInt(size-10)||pointer<28n)throw new Error('DSF 封面指针越界');
    const format=await read(28,12),formatSize=format.readBigUInt64LE(4);
    if(format.toString('ascii',0,4)!=='fmt '||formatSize<52n||formatSize>BigInt(size-40))throw new Error('DSF 格式块无效');
    const dataAt=28+Number(formatSize),data=await read(dataAt,12),dataSize=data.readBigUInt64LE(4);
    if(data.toString('ascii',0,4)!=='data'||dataSize<12n||BigInt(dataAt)+dataSize>pointer)throw new Error('DSF 封面指针落入音频块');
    locations.push({position:Number(pointer),limit:size});
  }else if(['RIFF','RF64'].includes(head.toString('ascii',0,4))&&head.toString('ascii',8,12)==='WAVE'){
    container=head.toString('ascii',0,4)==='RF64'?'rf64':'wav';locations.push(...await waveTagLocations(read,head,size));
  }else complete=false;
  const pictures:IPicture[]=[];
  for(const location of locations){
    const header=await read(location.position,10),extent=tagExtent(header,location.position,location.limit);
    if(!extent){complete=false;continue;}
    if(extent.version===4&&header[5]&16){
      const footer=await read(extent.end-10,10);
      if(footer.toString('ascii',0,3)!=='3DI'||!footer.subarray(3).equals(header.subarray(3)))throw new Error('ID3 封面标签尾不一致');
    }
    const result=tagPictures(await read(location.position+10,extent.length),header,extent.version);pictures.push(...result.pictures);complete&&=result.complete;
    if(pictures.length>64)throw new Error('ID3 内嵌图片数量超过预算');
  }
  signal.throwIfAborted();if(performance.now()>deadline)throw new Error('ID3 封面读取超过时间预算');
  return {pictures,container,complete};
}

export async function id3ArtworkPictures(handle:FileHandle,size:number,signal:AbortSignal):Promise<IPicture[]> {
  return (await readId3Artwork(handle,size,signal)).pictures;
}
