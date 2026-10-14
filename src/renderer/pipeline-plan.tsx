import React from 'react';
import type {AudioPipelinePlan,PlaybackState} from '../shared/contracts';

const stageNames:Record<string,string>={decode:'文件解码','dsd-lowpass-and-src':'DSD 滤波并转 PCM','opus-header-gain':'Opus 头部增益','gain-envelope':'音量与响度处理','gain-bypass':'跳过应用增益','pre-format-conversion':'前置样本格式转换','channel-conversion':'声道转换','linear-src':'线性重采样','post-format-conversion':'后置样本格式转换','wasapi-submit':'提交 WASAPI','windows-shared-engine':'Windows 共享混音'};
const qualityNames={lossless:'无损编码',lossy:'有损编码',unknown:'编码类型尚未完整确认','dsd-converted':'DSD 已转为 PCM'};
const sampleNames={processing:'启用了样本处理',conversion:'存在解码或输出格式转换','integer-candidate':'应用整数直通候选','unity-float-unverified':'应用浮点 unity 路径'};
const warningNames:Record<string,string>={'hardware-unverified':'设备播放尚未认证','source-valid-bits-unknown':'源文件有效位深未知','integer-output-precision':'源整数有效位超过本次整数容器容量','integer-to-float-precision':'超过 24 位的整数源转换为 float32，位保持尚未认证','float-precision-reduction':'源浮点超过 32 位，本次转换为 float32','decoder-format-transform-unverified':'解码器内部格式变化未完整确认','windows-shared-engine':'系统共享混音可进一步处理样本','src-delay-and-quality-unverified':'重采样音质与实际延迟待验证','dsd-filter-unverified':'DSD 转 PCM 滤波待验证','integer-output-without-dither':'本次转换为整数格式，未使用抖动'};
const pathNames={'passthrough':'直接传递','format-only':'仅样本格式转换','channels-only':'声道转换（可含格式转换）','resample-only':'重采样（可含格式转换）','resample-first':'先重采样、再声道转换','channels-first':'先声道转换、再重采样'};
const channelNames={'none':'无','passthrough':'直接传递','mono-out':'合并为单声道','mono-in':'单声道扩展','shuffle':'声道重排','weights':'按系数混音'};
const ditherNames={'none':'无','rectangular':'矩形','triangular':'三角形'};
const pcm=(format:string,rate:number,channels:number)=>`${(rate/1000).toLocaleString('zh-CN',{maximumFractionDigits:3})} kHz · ${channels} 声道 · ${format.toUpperCase()}`;

export function PipelinePlanInfo({plan,acceptance}:{plan?:AudioPipelinePlan;acceptance?:PlaybackState['planAcceptance']}):React.JSX.Element|null{
 if(!plan)return null;
 const c=plan.conversion,o=plan.output;
 return <section className="detail-clock" aria-label="本次播放处理链">
  <strong>本次播放处理链</strong>
  {acceptance&&<p>{acceptance.phase==='validated'?'配置已核对，正在准备启动':'播放前配置核对通过'}</p>}
  {plan.source.media&&<p>本次源证据：{plan.source.media.validBits===null?'有效位深未知':`${plan.source.media.validBits} 位`}{plan.source.media.containerBits!==null?`／${plan.source.media.containerBits} 位容器`:null} · {plan.source.media.evidence==='decoder-header'?'解码器读取的文件头':plan.source.media.evidence==='codec-context'?'解码器上下文报告':'尚未确认'}</p>}
  <p>{plan.stages.map(stage=>stageNames[stage]??stage).join(' → ')}</p>
  <p>{plan.source.codec.toUpperCase()} · {qualityNames[plan.encodedQuality]} · {sampleNames[plan.sampleStatus]}</p>
  <p>解码输出：{pcm(plan.source.format,plan.source.sampleRate,plan.source.channels)}</p>
  <p>设备格式：{pcm(o.deviceFormat,o.deviceSampleRate,o.deviceChannels)} · {o.mode==='exclusive'?'独占':'共享'} · {o.deviceName}</p>
  <p>{pathNames[c.executionPath]} · {c.resampling?'线性重采样':'未启用输出重采样'} · 抖动：{ditherNames[c.dither]}</p>
  <small>无损编码描述文件，整数路径描述应用处理；两者均不代表设备端已验证逐位一致。音量显示已接受的目标，设备呈现仍以时钟／尾部状态为依据。</small>
  <details><summary>范围、声道与缓冲参数</summary>
   {plan.source.fileBinding&&<><p>当前只读文件：{Number(BigInt(plan.source.fileBinding.byteLength)/1024n).toLocaleString('zh-CN')} KiB · 整数选择、浮点回退和跳转复用同一文件句柄</p><p>文件身份：卷 {plan.source.fileBinding.volumeSerial}／索引 {plan.source.fileBinding.fileIndex} · 这是当次 Windows 文件观察，不是内容哈希或跨设备身份认证。</p></>}
   <p>源 PCM 帧：{plan.span.startFrame} 至 {plan.span.endFrame??'文件结束'}（末端不含）{plan.span.boundaryFrame!==null?` · CUE 切段帧 ${plan.span.boundaryFrame} · 当前第 ${plan.span.segmentIndex+1} 段`:''}</p>
   <p>预读 {plan.buffers.preReadFrames} 帧／{(plan.buffers.preReadBytes/1024/1024).toFixed(2)} MiB · 设备缓冲 {plan.buffers.deviceFrames} 帧</p>
   <p>转换器报告延迟：输入 {c.inputLatencyFrames} 帧／输出 {c.outputLatencyFrames} 帧 · {plan.clockPolicy==='frame-preserving'?'保持帧数的映射':'扣除报告延迟的估计映射'}</p>
   <p>尾部：{plan.tailPolicy==='no-resampler'?'无输出重采样尾部预算':'输入报告延迟加 100 毫秒的有限预算'}</p>
   <p>声道策略：{channelNames[c.channelPath]}{c.channelConversion?` · ${c.channelMode}`:''}</p>
   {c.inputMap&&<p>输入声道标识：{c.inputMap.join(', ')}；输出声道标识：{c.outputMap?.join(', ')}</p>}
   {c.shuffle&&<p>输出取自输入声道（从 0 开始）：{c.shuffle.map(i=>i===255?'静音':i).join(', ')}</p>}
   {c.weights&&<><p>混音系数（行＝输入，列＝输出）：{c.weightRepresentation==='s16-fixed'?'原始整数定点表示':'浮点表示'}</p><pre style={{maxWidth:'100%',overflowX:'auto'}}>{c.weights.map(row=>row.join('  ')).join('\n')}</pre></>}
   <p>{plan.warnings.map(warning=>warningNames[warning]??warning).join('；')}。</p>
  </details>
 </section>;
}
