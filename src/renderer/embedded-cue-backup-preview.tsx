import React,{useEffect,useRef} from 'react';
import type {EmbeddedCueBundleInspection} from '../shared/embedded-cue-bundle';
import type {EmbeddedCueState} from '../shared/embedded-cue-history';

const labels:Record<EmbeddedCueState,string>={binary:'二进制编排',matched:'二进制与文本一致','text-only':'内嵌文本编排',rejected:'文本未采用',absent:'没有内嵌编排'};
export function EmbeddedCueBackupPreview({value,disabled,onClose}:{value:EmbeddedCueBundleInspection;disabled:boolean;onClose:()=>void}):React.JSX.Element {
 const section=useRef<HTMLElement|null>(null);useEffect(()=>{section.current?.focus();},[value.archiveSha256]);
 return <section className="scan-task-detail cue-backup-preview" ref={section} tabIndex={-1} aria-label="内嵌 CUE 来源备份预览">
  <h3>内嵌来源备份 · {value.name}</h3><p className="scan-task-path">保存时的位置：{value.rootPath} ／ {value.relativePath}</p>
  <p>保存时间：{new Date(value.capturedAt).toLocaleString()}{value.provenance==='retained-v68'?' · 曲库升级时保留':''}<br/>专辑：{value.album||'未记录'} · 艺人：{value.artist||'未记录'}</p>{value.metadataTruncated&&<p>过长的专辑或艺人资料已缩短显示，原备份保留完整内容。</p>}
  <p>原始来源与保存版本摘要核对通过。备份尚未匹配当前曲库或核对原音乐文件。</p>
  <table className="cue-backup-comparison"><caption>来源解释结果</caption><thead><tr><th scope="col">项目</th><th scope="col">保存版本</th><th scope="col">当前解释</th></tr></thead><tbody>
   <tr><th scope="row">采用状态</th><td>{labels[value.saved.state]}</td><td>{labels[value.current.state]}</td></tr>
   <tr><th scope="row">音轨数</th><td>{value.saved.tracks}</td><td>{value.current.tracks}</td></tr>
   <tr><th scope="row">采样率</th><td>{value.saved.sampleRate??'未知'} Hz</td><td>{value.current.sampleRate??'未知'} Hz</td></tr>
   <tr><th scope="row">完整采样数</th><td>{value.saved.totalSamples??'未知'}</td><td>{value.current.totalSamples??'未知'}</td></tr>
  </tbody></table>
  {value.saved.notice&&<p className="scan-task-notice">保存版本提示：{value.saved.notice}</p>}{value.current.notice&&<p className="scan-task-notice">当前提示：{value.current.notice}</p>}
  <p>{value.interpretationChanged?'当前解释与保存版本不同，请在后续恢复时核对音轨范围和资料。':'当前解释与保存版本一致。'}这里只复审备份内容，不能据此确认实际文件可播放或直接恢复编排。</p>
  {value.textHash&&<><h4>原始内嵌文本</h4>{value.textError?<p className="scan-task-error">{value.textError}</p>:<pre className="cue-source-text" tabIndex={0} aria-label="内嵌来源备份原文">{value.text||'（空文本）'}</pre>}{value.textTruncated&&<p>显示前 131072 个字符，原始备份中的字节保留完整。</p>}</>}
  {value.tracks.length>0&&<details><summary>当前解释的音轨与原采样范围</summary>{value.tracks.map((track,index)=><p key={index}>{track.hidden?'前导音频':`音轨 ${track.number}`} · {track.title} · {track.performer}<br/>采样范围：{track.startSample} 至 {track.endSample}（结束位置不包含）</p>)}{value.tracksTruncated&&<p>这里只显示部分音轨或缩短后的曲目信息。</p>}</details>}
  {value.files.length>0&&<details><summary>文本中声明的 FILE 名称（未读取）</summary>{value.files.map((file,index)=><p className="scan-task-path" key={index}>{file}</p>)}{value.filesTruncated&&<p>这里只显示部分名称。</p>}</details>}
  {value.binaryHash&&<details><summary>二进制编排与索引</summary><pre className="cue-source-text" tabIndex={0} aria-label="来源备份二进制索引">{value.binaryText}</pre>{value.binaryTruncated&&<p>预览省略部分内容，原备份中的二进制块保留完整。</p>}</details>}
  <details><summary>摘要与解析版本</summary><p>原音乐文件记录：{value.fileBytes} 字节</p><p>保存版本：{value.saved.binaryParser??'无二进制'} ／ {value.saved.textParser??'无文本'}<br/>当前解析：{value.current.binaryParser??'无二进制'} ／ {value.current.textParser??'无文本'}</p>
   <p>来源版本摘要</p><code className="cue-history-hash">{value.versionId}</code><p>备份文件摘要</p><code className="cue-history-hash">{value.archiveSha256}</code>
   {value.binaryHash&&<><p>原二进制块：{value.binaryBytes} 字节</p><code className="cue-history-hash">{value.binaryHash}</code></>}{value.textHash&&<><p>完整原文本字段：{value.textBytes} 字节</p><code className="cue-history-hash">{value.textHash}</code></>}
  </details><button disabled={disabled} onClick={onClose}>关闭备份预览</button>
 </section>;
}
