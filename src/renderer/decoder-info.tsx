import {useEffect,useState} from 'react';
import {mediaCoverage,type MediaCapabilityView} from '../shared/media-capabilities';
import type {PlaybackState} from '../shared/contracts';
export function DecoderInfo({source}:{source:NonNullable<PlaybackState['decodedSource']>}):React.JSX.Element {
 const dsd=source.dsdConversion;
 const [capabilities,setCapabilities]=useState<MediaCapabilityView|null>(null);
 useEffect(()=>{let alive=true;void window.music.mediaCapabilities().then(value=>{if(alive)setCapabilities(value);}).catch(()=>{if(alive)setCapabilities({status:'unavailable',manifest:null,reason:'解码验证信息暂不可用。'});});return()=>{alive=false;};},[source.fileBinding?.fileIndex,source.fileBinding?.lastWriteTicks,source.codec]);
 return <p className="detail-decoder">
  {dsd?`${dsd.container.toUpperCase()} · DSD${dsd.bitRate/44100} · ${dsd.bitRate.toLocaleString()} bit/s/声道 → PCM`:
   `解码：${source.backend==='miniaudio'?'内置音频解码':'FFmpeg'}${source.codec?` · ${source.codec.toUpperCase()}`:''}`}
  {' · '}{source.sampleRate.toLocaleString()} Hz · {source.channels} 声道 · {source.format.toUpperCase()}
  {dsd&&<small>已选择低通降采样，转换增益 {dsd.gainDb} dB；Native／DoP 未启用。转换质量与滤波延迟验收待完成。</small>}
  {!dsd&&<small>{mediaCoverage(source,capabilities)}</small>}
 </p>;
}
