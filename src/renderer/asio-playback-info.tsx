import React from 'react';
import type {AsioPlaybackView} from '../shared/asio-playback';
export function AsioPlaybackInfo({value}:{value:AsioPlaybackView|undefined}):React.JSX.Element|null{
 if(!value)return null;const o=value.output,c=value.clock;
 return <section className="output-actual"><h3>ASIO 实际输出</h3><p>{o.driverName||o.identity.description||o.identity.registryName} · 驱动版本 {o.driverVersion}</p>
  <p>{(o.sampleRate/1000).toFixed(1)} kHz · {o.channels.length} 声道 · 源 {o.format}／{o.validBits} bit · 缓冲 {o.bufferFrames} 帧</p><p>输出映射：{o.channels.map(ch=>`${ch.index+1} ${ch.name||''} (${ch.floating?'浮点':'整数'} ${ch.validBits} bit)`).join('、')}</p>
  <p>{o.numericConversion?'有 PCM 精度转换':'保持源精度的打包候选'} · {value.plan.processing.enabled?'数字处理已启用':'未启用数字增益'} · 输出延迟 {o.outputLatencyFrames} 帧</p>
  <p>进度：{c.authority==='driver-reported'?'驱动位置与延迟映射':c.authority==='paused-bookmark'?'暂停书签':'回调消费估计'}</p>
  {value.tail&&<p>尾部：{value.tail.status==='draining'?'等待输出完成':value.tail.evidence==='driver-clock'?'驱动时钟达到末尾并已释放':'按报告延迟和缓冲周期估计完成并已释放'}</p>}
  <small>参数来自驱动回执，实际输出、数值精度与时间边界尚待验证。</small>
 </section>;
}
