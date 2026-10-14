import type {DecoderSourceEvidence,PlaybackState} from './contracts.js';
export function readSourceEvidence(value:unknown,source:NonNullable<PlaybackState['decodedSource']>):DecoderSourceEvidence{
 const v=value as DecoderSourceEvidence;
 const bit=(x:unknown)=>x===null||typeof x==='number'&&Number.isSafeInteger(x)&&x>=1&&x<=64;
 if(!v||Object.keys(v).length!==6||v.version!==1||!['pcm-integer','pcm-float','lossless-integer','lossy','dsd','unknown'].includes(v.encoding)||!['decoder-header','codec-context','unknown'].includes(v.evidence)||!bit(v.validBits)||!bit(v.containerBits)||v.validBits!==null&&v.containerBits!==null&&v.validBits>v.containerBits)throw new Error('解码器源位深证据无效');
 const integer=['pcm-integer','lossless-integer'].includes(v.encoding);
 const conversion=integer?(source.format==='f32'?'integer-to-float':'integer-output'):v.encoding==='pcm-float'?'float-output':v.encoding==='lossy'?'lossy-decode':v.encoding==='dsd'?'dsd-to-pcm':'unknown';
 if(v.decoderConversion!==conversion||v.encoding==='lossless-integer'&&v.validBits!==null&&v.validBits>32||v.encoding==='pcm-float'&&source.format!=='f32'||['lossy','dsd','unknown'].includes(v.encoding)&&(v.validBits!==null||v.containerBits!==null)||v.encoding==='lossless-integer'&&v.containerBits!==null||['pcm-integer','pcm-float'].includes(v.encoding)&&v.containerBits===null||v.encoding==='unknown'&&v.evidence!=='unknown'||v.encoding!=='unknown'&&v.evidence!== (source.backend==='miniaudio'?'decoder-header':'codec-context'))throw new Error('位深证据与解码格式冲突');
 if(source.codec==='flac'&&v.encoding!=='lossless-integer'||source.codec==='alac'&&v.encoding!=='lossless-integer'||source.codec==='wav'&&!['pcm-integer','pcm-float','lossy','unknown'].includes(v.encoding)||['mp3','aac','vorbis','opus'].includes(source.codec)&&v.encoding!=='lossy'||source.codec.startsWith('dsd_')&&v.encoding!=='dsd')throw new Error('位深证据与实际编码冲突');
 return structuredClone(v);
}
