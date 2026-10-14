import type {PlaybackFileBinding} from './contracts.js';
const count=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=0xffffffffffffffffn;
export function readPlaybackFile(value:unknown,tagStamp:string|null):PlaybackFileBinding{
 const b=value as PlaybackFileBinding;
 if(!b||Object.keys(b).length!==8||b.version!==1||b.kind!=='windows-readonly-handle'||!count(b.volumeSerial)||BigInt(b.volumeSerial)>0xffffffffn||!count(b.fileIndex)||!count(b.byteLength)||BigInt(b.byteLength)===0n||!count(b.lastWriteTicks)||b.shareMode!=='read-only'||b.certification!=='pending')throw new Error('当前播放文件绑定无效');
 if(tagStamp!==null){
  const match=typeof tagStamp==='string'&&tagStamp.length<=42?/^(0|[1-9][0-9]{0,19}):(-?(0|[1-9][0-9]{0,19}))$/.exec(tagStamp):null;
  const ms=(BigInt(b.lastWriteTicks)-116444736000000000n)/10000n;
  // Legacy scan stamps use a JS number, so allow its sub-millisecond rounding at an integer boundary.
  if(!match||match[1]!==b.byteLength||ms-BigInt(match[2])>1n||BigInt(match[2])-ms>1n)throw new Error('本次打开的音乐与响度标签扫描记录不一致，请重新扫描');
 }
 return structuredClone(b);
}
