import type {PlaybackTail} from './contracts.js';
const counter=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=0xffffffffffffffffn;
export function readPlaybackTail(value:unknown,sourceRate:number,deviceRate:number,mode:'shared'|'exclusive',generation:number):PlaybackTail{
 const p=value as PlaybackTail;
 if(!p||Object.keys(p).length!==15||p.version!==1||!['flushing','draining','completed'].includes(p.status)||!['pending','device-clock','shared-padding','exclusive-period-estimate'].includes(p.evidence)||p.sourceSampleRate!==sourceRate||p.deviceSampleRate!==deviceRate||!Number.isSafeInteger(sourceRate)||sourceRate<=0||sourceRate>1536000||!Number.isSafeInteger(deviceRate)||deviceRate<=0||deviceRate>1536000||!counter(p.sourceFrame)||!counter(p.inputEndFrame)||!counter(p.filterTailInputFrames)||p.hardwareVerified!==false||p.policy!==(sourceRate===deviceRate?'no-resampler':'linear-src-100ms')||sourceRate===deviceRate&&p.filterTailInputFrames!=='0'||sourceRate!==deviceRate&&BigInt(p.filterTailInputFrames)<BigInt(Math.ceil(sourceRate/10)))throw new Error('歌曲尾部回执无效');
 if(p.status==='flushing'){
  if(p.targetOutputFrames!==null||p.committedOutputFrames!==null||p.packetPaddingFrames!==null)throw new Error('歌曲尾部提交阶段无效');
 }else if(!counter(p.targetOutputFrames)||!counter(p.committedOutputFrames)||!counter(p.packetPaddingFrames)||BigInt(p.committedOutputFrames)!==BigInt(p.targetOutputFrames)+BigInt(p.packetPaddingFrames))throw new Error('歌曲尾部提交范围无效');
 if(p.status!=='completed'){
  if(p.evidence!=='pending'||p.proof!==null||p.probeHresult!==null)throw new Error('未完成的歌曲尾部不能确认结束');
 }else{
  const proof=p.proof;
  if(p.evidence==='pending'||!proof||Object.keys(proof).length!==5||!counter(proof.bufferFrames)||BigInt(proof.bufferFrames)===0n||BigInt(p.packetPaddingFrames!)>=BigInt(proof.bufferFrames)||!Number.isSafeInteger(proof.elapsedMs)||proof.elapsedMs<0||proof.elapsedMs>30000||typeof p.probeHresult!=='string'||!/^0x[0-9A-F]{8}$/.test(p.probeHresult))throw new Error('歌曲尾部完成依据无效');
  if(p.evidence==='device-clock'){
   if(mode!=='exclusive'||p.probeHresult!=='0x00000000'||!counter(proof.clockPosition)||!counter(proof.clockFrequency)||BigInt(proof.clockFrequency)===0n||BigInt(proof.clockFrequency)>1000000000000n||proof.paddingFrames!==null||BigInt(proof.clockPosition)*BigInt(deviceRate)/BigInt(proof.clockFrequency)<BigInt(p.committedOutputFrames!))throw new Error('歌曲尾部设备位置无效');
  }else if(p.evidence==='shared-padding'){
   if(mode!=='shared'||p.probeHresult!=='0x00000000'||proof.paddingFrames!=='0'||proof.clockPosition!==null||proof.clockFrequency!==null)throw new Error('歌曲尾部缓冲确认无效');
  }else if(mode!=='exclusive'||proof.paddingFrames!==null||proof.clockPosition!==null||proof.clockFrequency!==null||BigInt(proof.elapsedMs)<(BigInt(proof.bufferFrames)*3000n+BigInt(deviceRate)-1n)/BigInt(deviceRate)+100n)throw new Error('歌曲尾部周期估计无效');
 }
 return {...p,proof:p.proof?{...p.proof}:null,generation,receivedAt:Date.now()};
}
