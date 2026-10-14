import React from 'react';
import type {PlaybackState} from '../shared/contracts';
const reasons={disabled:'ReplayGain 已关闭',selected:'使用所选标签','missing-tags':'没有可用的 ReplayGain 标签；不加预增益','album-fallback-track':'缺少专辑增益，改用曲目标签','missing-r128':'没有有效 R128 标签；不加预增益或目标补偿','header-only':'只用 Opus 头部增益，不追加响度标签'};
const bases={'none':'无响度标签处理','file-replaygain':'文件／CUE ReplayGain','opus-r128':'Opus R128','opus-legacy-before-header':'传统 ReplayGain，头部增益前测量','opus-legacy-after-header':'传统 ReplayGain，头部增益后测量','opus-header-only':'Opus 头部增益'};
export function ProcessingPlanInfo({playback}:{playback:PlaybackState}):React.JSX.Element|null{
 const plan=playback.processingPlan;if(!plan)return null;
 const db=(v:number)=>`${v>0?'+':''}${v.toFixed(2)} dB`;
 return <section className="detail-clock" aria-label="本次音频处理计划"><strong>{plan.enabled?'PCM 音频处理':'应用增益处理关闭'}</strong>
  <p>音量 {db(plan.settings.volumeDb)}{plan.settings.muted?' · 静音':''} · {reasons[plan.reason]}</p>
  {plan.codecGain&&<><p>来源：{bases[plan.gainBasis]} · 解码器已应用头部增益 {db(plan.codecGainDb)}</p><p>应用追加目标 {db(plan.effectiveGainDb)} · 合计目标 {db(plan.totalEffectiveGainDb)}{plan.settings.muted?'（已静音，合计为静音前增益）':''}{plan.gainBasis==='opus-r128'?` · 目标 ${plan.settings.opusTargetLUFS} LUFS，基准补偿 ${db(plan.referenceOffsetDb)}`:''}</p><p>R128 曲目／专辑：{plan.codecGain.r128TrackStatus==='valid'?db(plan.codecGain.r128TrackQ78!/256):plan.codecGain.r128TrackStatus==='invalid'?'重复或非法':'缺失'} ／ {plan.codecGain.r128AlbumStatus==='valid'?db(plan.codecGain.r128AlbumQ78!/256):plan.codecGain.r128AlbumStatus==='invalid'?'重复或非法':'缺失'}</p><small>从本次打开的音乐文件读取；头部、标签及音频包所属 Ogg 页面已核对。{plan.codecGain.legacyPresent&&plan.gainBasis==='opus-r128'?'检测到传统标签，本策略忽略它们。':''}串接／播放中改变增益资料暂不支持；未启用应用处理时，头部增益后的超满幅不会由应用限幅。</small></>}
  {plan.enabled&&<><p>应用请求增益 {db(plan.requestedGainDb)} · 应用目标增益 {db(plan.effectiveGainDb)}{plan.peakLimited?' · 峰值保护降低了增益':''}</p><p>{plan.peakEvidence==='tag'?`参考解码后峰值 ${plan.peak}`:'缺少有效峰值，保护以解码后数字满幅为基准'} · {plan.samplePolicy==='hard-clip'?'超出范围的样本限制到满幅':'保留浮点超满幅值，后端仍可能削波'} · 未使用抖动</p><small>处理在播放回调以 20 毫秒线性过渡进行；显示的增益是目标，尚不代表设备已呈现，设备格式转换仍单独记录；峰值标签不代表真实峰值认证。{plan.codecGain?'Opus 增益标签来自本次同句柄读取；R128 不使用含糊的传统峰值标签。':plan.tags?.source==='cue'?'CUE 独立音轨值，专辑值可来自文件标签。':'使用最近扫描读取的文件标签，旧库可重新扫描补读。'}</small></>}
  {playback.processingCounts&&<p>本会话已处理的样本：限幅 {playback.processingCounts.clippedSamples} · 无效值置零 {playback.processingCounts.invalidSamples}（回调处理，含被丢弃或重播的帧，不等于设备已播放样本）</p>}
 </section>;
}
