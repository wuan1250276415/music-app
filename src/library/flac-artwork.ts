import type {FileHandle} from 'node:fs/promises';
import {MAX_IMAGE_BYTES} from './artwork.js';

type Picture={position:number;length:number;front:boolean};
// RFC 9639 §§8.1/8.8. Inspect offsets before allocating an image; text
// comments are independent of native PICTURE blocks and need not be parsed.
export async function flacArtworkPictures(handle:FileHandle,size:number,signal:AbortSignal):Promise<Picture[]|null>{
  const deadline=performance.now()+20000;
  const check=()=>{signal.throwIfAborted();if(performance.now()>deadline)throw new Error('FLAC 封面读取超过时间预算');};
  const read=async(position:number,length:number):Promise<Buffer>=>{
    check();if(!Number.isSafeInteger(position)||position<0||length<0||position+length>size)throw new Error('FLAC 封面元数据越界');
    const bytes=Buffer.alloc(length);let offset=0;
    while(offset<length){check();const result=await handle.read(bytes,offset,length-offset,position+offset);if(!result.bytesRead)throw new Error('FLAC 封面元数据不完整');offset+=result.bytesRead;}
    return bytes;
  };
  if(size<4||!(await read(0,4)).equals(Buffer.from('fLaC')))return null;
  const pictures:Picture[]=[];let position=4,blocks=0,pictureBlocks=0;
  while(true){
    if(++blocks>1024||position+4>32*1024*1024)throw new Error('FLAC 封面元数据超过预算');
    const header=await read(position,4),type=header[0]&127,length=header.readUIntBE(1,3),start=position+4,end=start+length;
    if(end>size||end>32*1024*1024||type===127||blocks===1&&(type!==0||length!==34)||blocks>1&&type===0)throw new Error('FLAC 元数据块结构无效');
    if(type===6){
      if(++pictureBlocks>64)throw new Error('FLAC 内嵌图片数量超过预算');
      // A malformed/linked/oversized picture may be skipped in favour of another
      // embedded picture. Structural chain errors above remain explicit errors.
      if(length>=32){
        const first=await read(start,8),pictureType=first.readUInt32BE(0),mimeLength=first.readUInt32BE(4);
        if(pictureType<=20&&mimeLength<=1024&&start+12+mimeLength+20<=end){
          const mime=await read(start+8,mimeLength),descriptionAt=start+8+mimeLength;
          const descriptionLength=(await read(descriptionAt,4)).readUInt32BE(0),dimensionsAt=descriptionAt+4+descriptionLength;
          if(descriptionLength<=64*1024&&dimensionsAt+20<=end){
            const dimensions=await read(dimensionsAt,20),imageLength=dimensions.readUInt32BE(16),imageAt=dimensionsAt+20;
            if(mime.toString('ascii')!=='-->'&&imageLength>0&&imageLength<=MAX_IMAGE_BYTES&&imageAt+imageLength===end)
              pictures.push({position:imageAt,length:imageLength,front:pictureType===3});
          }
        }
      }
    }
    position=end;
    if(header[0]&128){if(position>=size)throw new Error('FLAC 文件缺少音频载荷');break;}
  }
  return [...pictures.filter(picture=>picture.front),...pictures.filter(picture=>!picture.front)];
}

export async function readFlacArtworkPicture(handle:FileHandle,picture:Picture,signal:AbortSignal):Promise<Buffer>{
  const bytes=Buffer.alloc(picture.length);let offset=0;const deadline=performance.now()+20000;
  while(offset<bytes.length){signal.throwIfAborted();if(performance.now()>deadline)throw new Error('FLAC 图片读取超过时间预算');const result=await handle.read(bytes,offset,bytes.length-offset,picture.position+offset);if(!result.bytesRead)throw new Error('FLAC 内嵌图片不完整');offset+=result.bytesRead;}
  return bytes;
}
