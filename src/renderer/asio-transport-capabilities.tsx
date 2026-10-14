import React from 'react';
import type {AsioCapabilities,AsioSupport} from '../shared/asio-output';
const labels:Record<AsioSupport,string>={reported:'驱动报告支持',unsupported:'驱动报告不支持',unreported:'未报告', 'query-failed':'查询失败'};
const rateName=(rate:number):string=>rate>=2822400?`${(rate/1000000).toFixed(4)} MHz`:`${(rate/1000).toFixed(3).replace(/\.?0+$/,'')} kHz`;
export function AsioTransportCapabilities({report}:{report:AsioCapabilities}):React.JSX.Element {
 const mode=report.ioMode==='dsd'?'DSD':report.ioMode==='pcm'?'PCM':'未确认';
 const nativeTypes=report.channels.filter(channel=>channel.sampleType===32||channel.sampleType===33);
 return <details className="output-actual"><summary>驱动报告的模式与采样率</summary>
  <p>当前模式：{mode}。以下信息来自驱动查询，尚未经过实机验证。读取过程中不会切换模式或开始播放。</p>
  <dl>{report.ioFormats.map(item=><React.Fragment key={item.requestedFormat}><dt>{item.requestedFormat===1?'Native DSD 模式':'PCM 模式'}</dt><dd title={`ASIO 返回值 ${item.error}，格式值 ${item.returnedFormat}`}>{labels[item.support]}</dd></React.Fragment>)}</dl>
  <p>{report.ioMode==='dsd'?`当前 DSD 模式报告 ${nativeTypes.length} 个可识别的一位 DSD 输出声道。`:'Native DSD 的声道格式需要在 DSD 模式下重新核对。'} 样本类型 32／33 的位序分别为低位／高位优先；类型 40 属于八位 DSD，不能按一位位流输出。</p>
  <ul>{report.sampleRates.map(item=><li key={item.rate} title={`ASIO 返回值 ${item.error}`}>{rateName(item.rate)}：{labels[item.support]}</li>)}</ul>
  {report.ioMode!=='pcm'&&report.ioMode!=='dsd'&&<p>当前模式未确认，采样率查询不能作为 PCM 或 DSD 的播放授权。</p>}
  <p>PCM 采样率支持不代表 DAC 能识别 DoP。DSD 直传仍在接入，当前应用只提供显式转 PCM 或停止策略。</p>
 </details>;
}
