import type {AudioDeviceCapabilities,AudioFormatCandidate,AudioExclusiveProbe} from './contracts.js';
import {validEndpoint} from './audio-output.js';
const hr=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9A-F]{8}$/.test(v);
const integer=(v:unknown,min:number,max:number):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const formatKey=(f:AudioFormatCandidate)=>JSON.stringify([f.format,f.containerBits,f.validBits,f.sampleRate,f.channels,f.channelMask,f.representation]);
const rates=[8000,11025,16000,22050,32000,44100,48000,88200,96000,176400,192000,352800,384000,705600,768000];
const layouts=[[1,4],[2,3],[4,51],[6,1551],[8,1599]];
const samples:Array<[AudioFormatCandidate['format'],number,number]>=[['u8',8,8],['pcm',16,16],['pcm',24,24],['pcm',32,24],['pcm',32,32],['float',32,32]];
const matrix=new Set<string>();
for(const rate of rates)for(const [channels,mask] of layouts)for(const [format,bits,valid] of samples)for(const legacy of [false,true]){
 if(legacy&&(channels>2||bits!==valid))continue;
 matrix.add(formatKey({format,containerBits:bits,validBits:valid,sampleRate:rate,channels,channelMask:legacy?0:mask,representation:legacy?'waveformatex':'extensible'}));
}
function readFormat(value:unknown):AudioFormatCandidate{
 const f=value as AudioFormatCandidate;
 if(!f||!['u8','pcm','float','unknown'].includes(f.format)||!integer(f.containerBits,0,64)||!integer(f.validBits,0,f.containerBits)||!integer(f.sampleRate,1,1536000)||!integer(f.channels,1,32)||!integer(f.channelMask,0,0xffffffff)||!['waveformatex','extensible'].includes(f.representation))throw new Error('设备格式信息无效');
 return {format:f.format,containerBits:f.containerBits,validBits:f.validBits,sampleRate:f.sampleRate,channels:f.channels,channelMask:f.channelMask,representation:f.representation};
}
export function validateAudioCapabilities(value:unknown,deviceId:string,deviceName:string,deviceRevision=0):AudioDeviceCapabilities{
 const p=value as AudioDeviceCapabilities;
 if(!p||Object.keys(p).length!==12||p.deviceId!==deviceId||!validEndpoint(p.deviceId)||!validEndpoint(deviceName)||p.evidence!=='driver-reported'||p.driverVersion!==null||p.firmwareVersion!==null||p.hardwareVerified!==false||p.matrixVersion!=='wasapi-pcm-candidates-v1'||typeof p.incomplete!=='boolean'||!hr(p.mixHresult)||!hr(p.periodHresult)||!Array.isArray(p.exclusiveProbes)||p.exclusiveProbes.length!==matrix.size)throw new Error('设备能力回执无效');
 const mixFormat=p.mixFormat===null?null:readFormat(p.mixFormat);
 if(mixFormat&&p.mixHresult!=='0x00000000')throw new Error('共享格式查询结果不一致');
 let periods:AudioDeviceCapabilities['periods']=null;
 if(p.periods!==null){
  const period=p.periods,valid=(s:unknown):s is string=>typeof s==='string'&&/^[1-9][0-9]{0,8}$/.test(s)&&BigInt(s)<=100000000n;
  if(!period||Object.keys(period).length!==2||!valid(period.default100ns)||!valid(period.minimum100ns)||BigInt(period.minimum100ns)>BigInt(period.default100ns)||p.periodHresult!=='0x00000000')throw new Error('设备周期回执无效');
  periods={default100ns:period.default100ns,minimum100ns:period.minimum100ns};
 }
 const seen=new Set<string>(),probes:AudioExclusiveProbe[]=[];
 for(const row of p.exclusiveProbes){
  const f=readFormat(row),key=formatKey(f);
  if(Object.keys(row).length!==9||!matrix.has(key)||seen.has(key)||!['reported','unsupported','error'].includes(row.status)||!hr(row.hresult)||(row.status==='reported')!==(row.hresult==='0x00000000')||(row.status==='unsupported')!==(row.hresult==='0x88890008'))throw new Error('独占格式查询结果无效');
  seen.add(key);probes.push({...f,status:row.status,hresult:row.hresult});
 }
 if((!mixFormat||!periods||probes.some(row=>row.status==='error'))&&!p.incomplete)throw new Error('设备能力缺失状态无效');
 return {deviceId,deviceName,observedAt:Date.now(),deviceRevision,evidence:'driver-reported',driverVersion:null,firmwareVersion:null,mixFormat,mixHresult:p.mixHresult,periods,periodHresult:p.periodHresult,exclusiveProbes:probes,matrixVersion:p.matrixVersion,incomplete:p.incomplete,hardwareVerified:false};
}
