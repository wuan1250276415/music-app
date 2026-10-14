import React,{useEffect,useRef} from 'react';
import type {CueBundleInspection} from '../shared/cue-source-export';
import {CUE_GAP_LABELS,type CueEncoding} from '../shared/cue-history';
const labels:Record<CueEncoding,string>={auto:'自动检测','utf-8':'UTF-8','utf-16le':'UTF-16 LE','utf-16be':'UTF-16 BE',gb18030:'GB18030'};
export function CueSourceBackupPreview({value,disabled,importDisabled,onClose,target,onImport}:{value:CueBundleInspection;disabled:boolean;importDisabled:boolean;onClose:()=>void;target:{rootPath:string;relativePath:string}|null;onImport:()=>void}):React.JSX.Element {
 const section=useRef<HTMLElement|null>(null);useEffect(()=>{section.current?.focus();},[value.archiveSha256]);
 return <section className="scan-task-detail cue-backup-preview" ref={section} tabIndex={-1} aria-label="CUE 来源备份预览">
  <h3>来源备份 · {value.name}</h3><p className="scan-task-path">备份记录的位置：{value.rootPath} ／ {value.relativePath}</p><p>保存时间：{new Date(value.createdAt).toLocaleString()} · {value.rawBytes} 字节 · {CUE_GAP_LABELS[value.gapPolicy]}</p>
  <p>保存时编码：{labels[value.encoding]} · 请求选择：{labels[value.requestedEncoding]}<br/>保存时解析：{value.snapshotParser} · {value.snapshotTracks} 轨<br/>当前解析：{value.currentParsed?`${value.currentParser} · ${value.currentTracks} 轨 · ${value.currentEncoding?labels[value.currentEncoding]:'未知编码'}`:'预检查未通过，尚未执行'}</p>
  {value.snapshotNotice&&<p className="scan-task-notice">保存时提示：{value.snapshotNotice}</p>}{value.currentNotice&&<p className={value.currentInvalid?'scan-task-error':'scan-task-notice'}>当前提示：{value.currentNotice}</p>}
  <p>此预览只核对备份内容和原文解析，不读取其中引用的音乐文件。备份中的来源身份与位置尚未匹配当前曲库，不能据此直接恢复播放编排。</p>
  {target?<><h4>明确导入目标</h4><p className="scan-task-path">{target.rootPath} ／ {target.relativePath}</p><button disabled={disabled||importDisabled} onClick={onImport}>将此备份添加到以上来源的历史</button><p>原备份完整保留，当前解释将登记为目标来源的历史版本。导入不会改变磁盘最新观察、已有原文选择或播放编排；导入后请复审版本并明确选择，再扫描应用。</p></>:<p>可选择已有 CUE 来源后明确添加到其历史，也可在下方选择音乐目录和相对位置，登记为新来源。</p>}
  <details><summary>来源摘要与版本</summary><p>原文摘要</p><code className="cue-history-hash">{value.sourceHash}</code><p>备份文件摘要</p><code className="cue-history-hash">{value.archiveSha256}</code><p>保存的解析版本</p><code className="cue-history-hash">{value.versionId}</code></details>
  <h4>原文预览</h4>{value.textError?<p className="scan-task-error">无法按保存时编码解码：{value.textError}</p>:<pre className="cue-source-text" tabIndex={0} aria-label="来源备份 CUE 原文">{value.text||'（空原文）'}</pre>}{value.textTruncated&&<p>显示前 131072 个字符，原始备份中的字节保留完整。</p>}
  {value.files.length>0&&<details><summary>当前解析声明的音频引用（未读取）</summary>{value.files.map((name,index)=><p className="scan-task-path" key={index}>{name}</p>)}{value.filesTruncated&&<p>这里只显示部分引用名称。</p>}</details>}
  <button disabled={disabled} onClick={onClose}>关闭备份预览</button>
 </section>;
}
