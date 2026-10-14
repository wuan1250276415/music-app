import React from 'react';
import type {TagRecoveryView,TagArtifactRole,TagRecoveryClassification} from '../shared/tag-recovery';
const roles:Record<TagArtifactRole,string>={original:'原文件',backup:'备份文件',temporary:'临时文件'};
const classifications:Record<TagRecoveryClassification,string>={unchanged:'原文件与已验证来源一致',staged:'原文件、备份及临时文件均已核对','restore-available':'原文件缺失，备份可供后续恢复','recovery-required':'实际文件仍需进一步核对','source-baseline-unavailable':'缺少完整原文件基准','journal-unconfirmed':'阶段日志未能确认'};
const states={present:'已读取',missing:'缺失',busy:'被其他程序占用',unreadable:'无法读取'};
export function TagRecoveryResult({value,resolved=false}:{value:TagRecoveryView;resolved?:boolean}):React.JSX.Element {
 return <section className="tag-recovery-result" aria-label="恢复文件核对">
  <h4>{value.state==='running'?'正在核对恢复文件':value.state==='completed'?'恢复文件核对结果':value.state==='cancelled'?'文件核对已取消':value.state==='interrupted'?'上次核对已中断':'文件核对未完成'}</h4>
  {value.state==='running'&&<div className="tag-write-progress"><span>{value.phase?`核对${roles[value.phase]}`:'等待文件读取组件退出'}</span><progress aria-label="恢复文件核对进度" max={1} value={Number(value.bytes)/Math.max(1,Number(value.total))}/><small>{(Number(value.bytes)/1048576).toFixed(1)} / {(Number(value.total)/1048576).toFixed(1)} MiB</small></div>}
  {value.error&&<p role="status" className="collection-error">{value.error}</p>}
  {value.report&&<><strong>{classifications[value.report.classification]}</strong><p>{value.report.reason}</p><table><thead><tr><th>文件</th><th>状态</th><th>大小</th></tr></thead><tbody>{value.report.actual.files.map(file=><tr key={file.role}><td>{roles[file.role]}</td><td>{states[file.state]}{file.state==='present'&&!file.flac?' · FLAC 结构未确认':''}</td><td>{file.identity?`${(Number(file.identity.bytes)/1048576).toFixed(1)} MiB`:'—'}</td></tr>)}</tbody></table>
   <details><summary>查看本次文件核对记录</summary><p>此结果是核对时的文件快照；后续处理须再次读取。{resolved?'后续保留文件操作已完成，请参看下方处理及重扫状态。':'本次核对未解除恢复占用。'}未替换或删除文件。</p>{value.report.actual.files.map(file=><div key={file.role}><b>{roles[file.role]}</b>{file.sha256&&<p>完整摘要 <code>{file.sha256}</code></p>}{file.flac&&<p>音频摘要 <code>{file.flac.audioSha256}</code></p>}{file.identity&&<p>文件身份 <code>{file.identity.volume}:{file.identity.fileId}</code></p>}{file.reason&&<p>读取说明：{file.reason}</p>}</div>)}</details>
  </>}
  <small>{new Date(value.updatedAt).toLocaleString()} · {value.exitConfirmed?'本次核对组件已停止':'本次核对组件停止尚未确认'}</small>
 </section>;
}
