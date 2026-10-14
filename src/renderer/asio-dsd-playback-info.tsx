import React from 'react';
import type {AsioDsdPlaybackView} from '../shared/asio-dsd';
export function AsioDsdPlaybackInfo({value}:{value:AsioDsdPlaybackView|undefined}):React.JSX.Element|null {
 if(!value)return null;const {source,output,plan,clock,tail}=value,transport=output.transport==='dop'?'DoP':'Native DSD';
 return <section className="output-actual" aria-label="原始 DSD 播放信息">
  <h3>{transport} 实际播放配置</h3>
  <p>{output.driverName||output.identity.registryName} · 驱动版本 {output.driverVersion}</p>
  <p>{source.container.toUpperCase()} · DSD{Math.round(source.bitRate/44100)} · {(source.bitRate/1000000).toLocaleString('zh-CN',{maximumFractionDigits:4})} MHz · {source.channels} 声道</p>
  <p>本次范围：{plan.range.startTick}–{plan.range.endTick} 原始位；起始书签 {plan.range.initialTick} 位。</p>
  <p>输出声道：{output.channels.map(channel=>`${channel.index+1} ${channel.name||''}`).join('、')} · 缓冲 {output.bufferFrames} {output.deviceFrameUnit==='dsd-bit'?'DSD 位':'PCM 承载帧'}</p>
  <p>{output.transport==='dop'?`${output.deviceSampleRate.toLocaleString()} Hz 整数承载，封装原始 DSD 位流`:'原始位流按驱动要求的位序打包'}；不进行软件音量、ReplayGain 或重采样，请使用设备硬件音量。</p>
  {plan.dopAuthorization&&<p>DoP 档案：{plan.dopAuthorization.dacName} · 修订 {plan.dopAuthorization.revision} · 用户确认，未实机认证。</p>}
  <p>进度依据：{clock.authority==='paused-bookmark'?'原始位数暂停书签':clock.authority==='driver-reported'?'驱动位置与报告延迟映射':'回调消费估计'} · 输出延迟 {output.outputLatencyFrames} {output.deviceFrameUnit==='dsd-bit'?'DSD 位':'承载帧'}。</p>
  {tail&&<p>曲尾：{tail.status==='draining'?'等待设备完成':tail.evidence==='driver-clock'?'驱动位置达到末尾，输出与来源已释放':'按报告延迟和缓冲周期估计完成，输出与来源已释放'}。</p>}
  {value.counts&&<p>已发布 {value.counts.publishedSourceBits} 个原始位 · 回调 {value.counts.callbackCount} 次 · 缓冲饥饿 {value.counts.underrunFrames} {output.deviceFrameUnit==='dsd-bit'?'位':'承载帧'}。</p>}
  <small>源码已接入；设备输出、数值精度与呈现边界仍待验证。原始 DSD 的实时分析副本继续开发。</small>
 </section>;
}
