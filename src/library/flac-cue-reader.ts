import type {FileHandle} from 'node:fs/promises';
import {parseFlacCueBlock,type FlacCueSource} from './flac-cuesheet.js';
import {parseFlacCueText,FLAC_CUE_TEXT_LIMIT,type FlacCueTextSource} from './flac-cue-text.js';

export async function readEmbeddedFlacCues(handle:FileHandle,size:number,signal:AbortSignal):Promise<{cue:FlacCueSource|null;text:FlacCueTextSource|null}|undefined> {
 const deadline=performance.now()+20000;let reads=0,bytesRead=0;
 const read=async(position:number,length:number)=>{
  if(!Number.isSafeInteger(size)||!Number.isSafeInteger(position)||!Number.isSafeInteger(length)||position<0||length<0||position+length>size||(bytesRead+=length)>32*1024*1024)throw new Error('FLAC 内嵌编排元数据越界或超过读取预算');
  const bytes=Buffer.alloc(length);let done=0;
  while(done<length){signal.throwIfAborted();if(performance.now()>deadline)throw new Error('FLAC 内嵌编排读取超过时间预算');if(++reads%64===0)await new Promise<void>(resolve=>setImmediate(resolve));const result=await handle.read(bytes,done,length-done,position+done);if(!result.bytesRead)throw new Error('FLAC 内嵌编排元数据不完整');done+=result.bytesRead;}
  return bytes;
 };
 if(size<4||(await read(0,4)).toString('ascii')!=='fLaC')return undefined;
 let position=4,blocks=0,streamInfo:Buffer|undefined,cue:FlacCueSource|null=null,text:FlacCueTextSource|null=null,commentSeen=false;
 while(true){
  if(++blocks>1024||position+4>32*1024*1024)throw new Error('FLAC 内嵌编排元数据链超过预算');
  const header=await read(position,4),type=header[0]&127,length=header.readUIntBE(1,3),start=position+4,end=start+length;
  if(end>size||end>32*1024*1024||type===127||blocks===1&&(type!==0||length!==34)||blocks>1&&type===0)throw new Error('FLAC 内嵌编排元数据链无效');
  if(type===0)streamInfo=await read(start,34);
  if(type===5){if(cue||length>256*1024)throw new Error('FLAC CUESHEET 重复或超过预算');cue=parseFlacCueBlock(await read(start,length),streamInfo!,start);}
  if(type===4){
   if(commentSeen||length<8)throw new Error('FLAC 注释块重复或不完整');commentSeen=true;
   let at=start;
   const u32=async()=>{if(at+4>end)throw new Error('FLAC 注释长度不完整');const value=(await read(at,4)).readUInt32LE();at+=4;return value;};
   const vendor=await u32();if(vendor>1048576||at+vendor+4>end)throw new Error('FLAC 注释 vendor 越界或超过预算');at+=vendor;
   const count=await u32();if(count>32768)throw new Error('FLAC 注释数量超过预算');
   for(let index=0;index<count;index++){
    const n=await u32();if(n<2||at+n>end)throw new Error('FLAC 注释字段越界');
    const nameBytes=await read(at,Math.min(n,257)),split=nameBytes.indexOf(61);
    if(split<1||split>256||nameBytes.subarray(0,split).some(value=>value<32||value>126))throw new Error('FLAC 注释字段名无效或超过预算');
    if(nameBytes.subarray(0,split).toString('ascii').toUpperCase()==='CUESHEET'){
     if(text||n>FLAC_CUE_TEXT_LIMIT)throw new Error('FLAC 内嵌 CUE 文本重复或超过预算');
     text=parseFlacCueText(await read(at,n),streamInfo!,start,index);
    }
    at+=n;
   }
   if(at!==end)throw new Error('FLAC 注释块有未识别的尾部数据');
  }
  position=end;if(header[0]&128){if(position>=size)throw new Error('FLAC 文件缺少音频载荷');break;}
 }
 signal.throwIfAborted();return {cue,text};
}
