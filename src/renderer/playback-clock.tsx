import React from 'react';
import type {PlaybackClock as Clock} from '../shared/contracts';
const reasons:Record<string,string>={'src-mapping-pending':'采样率转换的时间映射仍在开发','converter-mapping-pending':'格式转换的时间映射仍待核对','converter-timeline-unavailable':'输出转换的时间线暂时不可用','submission-invalid':'设备提交记录不可用','clock-beyond-submission':'设备位置超过已确认提交范围','clock-unavailable':'设备时钟暂时不可读','clock-reading-delayed':'设备时钟读取延迟','clock-frequency-invalid':'设备时钟频率无效','clock-stalled':'设备时钟未推进','clock-regressed':'设备时钟计数回退','clock-overflow':'设备时钟计数超过映射范围','timeline-unavailable':'播放时间线暂时不可用','source-mapping-invalid':'源位置映射暂时不可用'};
export function PlaybackClockInfo({clock}:{clock:Clock|undefined}):React.JSX.Element|null{
 if(!clock)return null;
 return <section className="detail-clock"><strong>播放位置依据：{clock.authority==='device-reported'?'设备报告位置':clock.authority==='converter-estimate'?'按设备位置换算的转换估计':clock.authority==='paused-bookmark'?'暂停／跳转书签':'音频回调估计'}</strong>
  {clock.authority==='callback-estimate'&&<p>{reasons[clock.reason]??'暂时使用回调消费位置'}；进度和歌词可能领先于实际声音。</p>}
  {clock.authority==='device-reported'&&<p>已按保持帧数的播放时间线换算，并核对设备成功接收的范围。设备数字输出与声画同步仍待实机验证。</p>}
  {clock.authority==='converter-estimate'&&<p>已核对成功提交范围，并扣除转换器报告的延迟。转换滤波的实际延迟与同步误差仍待验证。</p>}
  {clock.authority==='paused-bookmark'&&<p>{clock.bookmarkBasis==='device-frozen'?'书签来自停止瞬间的设备报告位置。':clock.bookmarkBasis==='converted-frozen'?'书签由停止瞬间的设备位置和转换延迟估算。':clock.bookmarkBasis==='recent-position'?'设备位置暂时不可映射，书签采用最近一次位置；恢复时可能重复或跳过少量音频。':'书签来自所选播放位置。'}继续播放后重新读取设备位置。</p>}
 </section>;
}
