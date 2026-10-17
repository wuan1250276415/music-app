import type {PlaybackState} from './contracts.js';
export interface MediaCapabilityCase {
 backend:string;codec:string;container:{version:1;family:string;profile:number|null};sampleRate:number;channels:number;format:string;
 media:{encoding:string;validBits:number|null;containerBits:number|null};independentReference:boolean;seekCases:number;maxSeekError:number;fixtures:string[];
}
export interface MediaCapabilityManifest {
 format:'aural-media-capabilities';version:1;appVersion:string;createdAt:string;components:Record<string,string>;probeSha256:string;reportSha256:string;
 combinations:MediaCapabilityCase[];hardwareVerified:false;crossFileGaplessVerified:false;
}
export type MediaCapabilityView={status:'ready'|'unavailable';reason:string;manifest:MediaCapabilityManifest|null};
export const MEDIA_CAPABILITY_COMPONENTS=['audio-host.exe','avutil-60.dll','swresample-6.dll','avcodec-62.dll','avformat-62.dll'] as const;
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function readDecoderContainer(value:unknown,source:NonNullable<PlaybackState['decodedSource']>):NonNullable<NonNullable<PlaybackState['decodedSource']>['container']>{
 const c=value as NonNullable<NonNullable<PlaybackState['decodedSource']>['container']>;
 if(!c||Object.keys(c).length!==3||c.version!==1||!['wav','flac','mp3','mp4','adts','ogg','dsf','dff','unknown'].includes(c.family)||c.profile!==null&&(!Number.isSafeInteger(c.profile)||c.profile<0||c.profile>65535))throw new Error('实际容器与编码档位回执无效');
 const expected=source.codec==='aac'?['adts','mp4']:source.codec==='alac'?['mp4']:['opus','vorbis'].includes(source.codec)?['ogg']:source.codec.startsWith('dsd_')?['dsf','dff']:[source.codec];
 if(!expected.includes(c.family)||source.backend==='miniaudio'&&c.profile!==null)throw new Error('实际容器与编码来源不符');return {...c};
}
export function readMediaCapabilityManifest(value:unknown):MediaCapabilityManifest {
 const v=value as MediaCapabilityManifest;
 if(!v||Object.keys(v).length!==10||v.format!=='aural-media-capabilities'||v.version!==1||typeof v.appVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(v.appVersion)||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt))||!v.components||Object.keys(v.components).length!==5||MEDIA_CAPABILITY_COMPONENTS.some(k=>!hash(v.components[k]))||!hash(v.probeSha256)||!hash(v.reportSha256)||v.hardwareVerified!==false||v.crossFileGaplessVerified!==false||!Array.isArray(v.combinations)||!v.combinations.length||v.combinations.length>128)throw new Error('解码能力清单版本或范围无效');
 const seen=new Set<string>();
 for(const c of v.combinations){
  if(!c||Object.keys(c).length!==11||!['miniaudio','ffmpeg-8.1.3'].includes(c.backend)||!['wav','flac','mp3','aac','alac','vorbis','opus'].includes(c.codec)||!Number.isSafeInteger(c.sampleRate)||c.sampleRate<8000||c.sampleRate>768000||!Number.isSafeInteger(c.channels)||c.channels<1||c.channels>16||!['s16','s32','f32'].includes(c.format)||!c.media||Object.keys(c.media).length!==3||!['pcm-integer','pcm-float','lossless-integer','lossy'].includes(c.media.encoding)||[c.media.validBits,c.media.containerBits].some(n=>n!==null&&(!Number.isSafeInteger(n)||Number(n)<1||Number(n)>64))||typeof c.independentReference!=='boolean'||!Number.isSafeInteger(c.seekCases)||c.seekCases<1||c.seekCases>100000||!Number.isFinite(c.maxSeekError)||c.maxSeekError<0||c.maxSeekError>0.000002||!Array.isArray(c.fixtures)||!c.fixtures.length||c.fixtures.length>64||c.fixtures.some(n=>typeof n!=='string'||!/^[a-z0-9-]{1,100}$/.test(n)))throw new Error('解码能力组合或验证范围无效');
  readDecoderContainer(c.container,{backend:c.backend,codec:c.codec} as NonNullable<PlaybackState['decodedSource']>);
  const key=JSON.stringify([c.backend,c.codec,c.container,c.sampleRate,c.channels,c.format,c.media]);if(seen.has(key))throw new Error('解码能力组合重复');seen.add(key);
 }
 return structuredClone(v);
}
export function mediaCoverage(source:NonNullable<PlaybackState['decodedSource']>,view:MediaCapabilityView|null):string {
 if(!view||view.status!=='ready'||!view.manifest)return view?.reason||'正在核对当前构建的解码验证清单。';
 if(!source.container||!source.media)return '当前来源信息不足，尚不能匹配已验证的解码组合。';
 const same=view.manifest.combinations.some(c=>c.backend===source.backend&&c.codec===source.codec&&c.sampleRate===source.sampleRate&&c.channels===source.channels&&c.format===source.format&&c.container.family===source.container!.family&&c.container.profile===source.container!.profile&&c.media.encoding===source.media!.encoding&&c.media.validBits===source.media!.validBits&&c.media.containerBits===source.media!.containerBits);
 return same?'此组合已通过软件解码与精确跳转验证（短样本）；长曲性能、设备输出与无缝验收仍待完成。':'这首歌的容器、编码和参数组合尚未纳入软件验证。';
}
