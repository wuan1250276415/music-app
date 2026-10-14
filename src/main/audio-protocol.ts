import { RELEASE } from '../shared/release.js';
const MAX_BYTES=RELEASE.audioProtocol.maxMessageBytes;
const decoder=new TextDecoder('utf-8',{fatal:true});

export type AudioMessage=Record<string,unknown>;

export function encodeFrame(message:AudioMessage):Buffer {
  const payload=Buffer.from(JSON.stringify(message),'utf8');
  if(!payload.length||payload.length>MAX_BYTES)throw new Error('音频协议消息超过限制');
  const frame=Buffer.allocUnsafe(payload.length+4);
  frame.writeUInt32LE(payload.length,0);
  payload.copy(frame,4);
  return frame;
}

export class FrameReader {
  private buffer=Buffer.alloc(0);
  constructor(private readonly receive:(message:AudioMessage)=>void,private readonly maxBytes:number=MAX_BYTES){if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_BYTES)throw new Error('音频协议缓冲预算无效');}
  push(chunk:Buffer):void {
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length>=4){
      const length=this.buffer.readUInt32LE(0);
      if(length===0||length>this.maxBytes)throw new Error('音频协议帧长度无效');
      if(this.buffer.length<length+4)return;
      const payload=this.buffer.subarray(4,length+4);
      this.buffer=this.buffer.subarray(length+4);
      const parsed=JSON.parse(decoder.decode(payload)) as unknown;
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('音频协议消息必须为对象');
      this.receive(parsed as AudioMessage);
    }
    if(this.buffer.length>this.maxBytes+4)throw new Error('音频协议缓冲区超过限制');
  }
  finish():void {if(this.buffer.length)throw new Error('音频协议收到不完整帧');}
}
