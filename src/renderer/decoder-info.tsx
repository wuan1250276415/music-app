import type {PlaybackState} from '../shared/contracts';
export function DecoderInfo({source}:{source:NonNullable<PlaybackState['decodedSource']>}):React.JSX.Element {
 const dsd=source.dsdConversion;
 return <p className="detail-decoder">
  {dsd?`${dsd.container.toUpperCase()} · DSD${dsd.bitRate/44100} · ${dsd.bitRate.toLocaleString()} bit/s/声道 → PCM`:
   `解码：${source.backend==='miniaudio'?'内置音频解码':'FFmpeg'}${source.codec?` · ${source.codec.toUpperCase()}`:''}`}
  {' · '}{source.sampleRate.toLocaleString()} Hz · {source.channels} 声道 · {source.format.toUpperCase()}
  {dsd&&<small>已选择低通降采样，转换增益 {dsd.gainDb} dB；Native／DoP 未启用。转换质量与滤波延迟验收待完成。</small>}
  {!dsd&&<small>显示解码后的参数；完整格式与设备验收待完成。</small>}
 </p>;
}
