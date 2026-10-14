import React,{useEffect,useRef} from 'react';
import type {CueVersionReview,CueReferenceState,CueReviewTrack} from '../shared/cue-version-review';
import {CUE_GAP_LABELS} from '../shared/cue-history';

const states:Record<CueReferenceState,string>={'catalog-online':'曲库记录在线','outside-root':'引用越过当前目录','missing-record':'缺少曲库记录',offline:'曲库记录不可用',ignored:'已忽略',removed:'已移出曲库','restore-pending':'等待重新核对','writeback-held':'写回或恢复占用','parse-error':'媒体解析有错误',unobserved:'缺少文件观察记录'};
const ranges:Record<CueReviewTrack['rangeState'],string>={'catalog-bounded':'位于记录长度内',unbounded:'记录长度未知','outside-duration':'超出记录长度',unavailable:'当前记录不可用'};
const seconds=(frame:number)=>`${(frame/75).toFixed(3)} 秒`;
export function CueVersionReviewPreview({value,disabled,onPage,onClose,onSelect,stale}:{value:CueVersionReview;disabled:boolean;onPage:(offset:number)=>void;onClose:()=>void;onSelect:(followDisk:boolean)=>void;stale:boolean}):React.JSX.Element {
 const section=useRef<HTMLElement|null>(null);useEffect(()=>{section.current?.focus();},[value.mappingSha256,value.offset]);
 const selectable=!disabled&&!stale&&!value.invalid&&!value.warnings.length&&!value.warningsOmitted&&value.visibleTracks>0&&value.rootAuthorized&&value.rootStatus==='online'&&value.unavailableTracks===0;
 return <section className="scan-task-detail" ref={section} tabIndex={-1} aria-label="CUE 历史版本解释与引用复审">
  <h3>历史版本解释与曲库引用复审</h3><p>专辑：{value.album||'未记录'} · 艺人：{value.performer||'未记录'}{value.metadataOmitted?'（资料已缩短显示）':''}</p>
  <p className="scan-task-path">保存时：{value.savedRootPath} ／ {value.savedSourcePath}<br/>当前曲库：{value.rootPath??'目录已移除'} ／ {value.sourcePath}</p>
  <p>{CUE_GAP_LABELS[value.request.gapPolicy]} · 当前解码：{value.currentEncoding}<br/>保存版本：{value.savedTracks} 轨 · 当前解释：{value.visibleTracks} 轨、{value.hiddenTracks} 段前导音频</p>
  <p>这是按所选历史原文及编码重新解释的曲库记录预览。选择原文后将启动扫描，核对实际文件和全部范围，通过后更新编排。音乐和磁盘 CUE 原文件保留。</p>
  {!value.rootAuthorized&&<p className="scan-task-error">当前目录尚未重新授权或已移除，不能据此恢复编排。</p>}{value.rootStatus!=='online'&&<p className="scan-task-notice">目录状态：{value.rootStatus==='scanning'?'正在扫描':value.rootStatus==='offline'?'离线':'不可用'}。这里的文件信息可能尚未更新。</p>}
  {value.sourcePending&&<p className="scan-task-notice">此来源已有待扫描的解释设置；本次复审没有改变该任务。</p>}{value.parseError&&<p className="scan-task-error">解析失败：{value.parseError}</p>}{value.invalid&&!value.parseError&&<p className="scan-task-error">当前解释存在无效编排，需要先处理原文问题。</p>}
  {value.warnings.map((warning,index)=><p className="scan-task-notice" key={index}>{warning}</p>)}{value.warningsOmitted&&<p>这里只显示部分诊断，完整原文仍保留在历史中。</p>}
  <p>{value.referenceCount} 个音轨引用，其中 {value.catalogOnlineReferences} 个有在线曲库记录；{value.boundedTracks} 段位于记录长度内，{value.unavailableTracks} 段缺少可用记录或范围依据。曲库观察与长度尚未和实际文件重新核对。</p>
  {value.tracks.length>0&&<><p>范围单位为 CUE 75 帧／秒，结束位置不包含。末轨未声明结束位置时显示“文件结尾”，不补造精确采样数。</p><table className="cue-backup-comparison"><caption>第 {value.offset+1}–{value.offset+value.tracks.length} 项，共 {value.totalTracks} 项</caption><thead><tr><th scope="col">音轨与资料</th><th scope="col">声明引用／曲库记录</th><th scope="col">解释范围</th></tr></thead><tbody>{value.tracks.map((track,index)=><tr key={value.offset+index}>
   <td>{track.hidden?'前导音频':`音轨 ${track.number}`} · {track.title}<br/>{track.performer}{track.omitted&&<p>过长资料已缩短显示。</p>}</td>
   <td className="scan-task-path">{track.reference.reference}<br/>{track.reference.relativePath??'未匹配当前目录'}<br/>{states[track.reference.state]}{track.reference.omitted&&<p>过长路径已缩短显示。</p>}</td>
   <td>{seconds(track.startFrame)} 至 {track.endFrame===null?'文件结尾':seconds(track.endFrame)}<br/>INDEX 01：{seconds(track.index01Frame)}<br/>{ranges[track.rangeState]}{track.reference.durationSeconds!==null&&<p>文件记录长度：{track.reference.durationSeconds.toFixed(3)} 秒</p>}</td>
  </tr>)}</tbody></table></>}
  <div className="cue-history-export-actions">{value.offset>0&&<button disabled={disabled} onClick={()=>onPage(value.offset-128)}>上一页范围</button>}{value.nextOffset!==null&&<button disabled={disabled} onClick={()=>onPage(value.nextOffset!)}>下一页范围</button>}</div>
  <div className="cue-history-export-actions"><button disabled={!selectable} onClick={()=>onSelect(false)}>选择此历史原文，扫描核对后应用</button>{value.request.versionId===value.request.latestVersion&&<button disabled={!selectable} onClick={()=>onSelect(true)}>跟随磁盘 CUE，扫描核对后应用</button>}</div>
  {stale&&<p className="scan-task-notice">曲库记录已变化，请重新读取并复审后提交。</p>}{!selectable&&!disabled&&!stale&&<p className="scan-task-notice">请先处理原文诊断、目录状态和全部引用范围，再选择原文。</p>}
  <p>历史选择会持续使用这份原文；跟随磁盘会使用后续读到的磁盘版本。已选择的历史原文在磁盘 CUE 缺失时仍会纳入扫描；音乐引用核对通过后才应用。来源备份可先明确导入到现有来源历史，再复审选择。</p>
  <details><summary>来源及复审摘要</summary><p>{value.rawBytes} 字节 · 保存于 {new Date(value.createdAt).toLocaleString()}<br/>保存解析：{value.savedParser} · 当前解析：{value.currentParser}</p><p>历史原文摘要</p><code className="cue-history-hash">{value.sourceHash}</code><p>当前曲库引用复审摘要</p><code className="cue-history-hash">{value.mappingSha256}</code><p>提交时重新计算此记录摘要；实际文件仍由后续扫描核对。它不能证明历史原文当时引用的音乐与当前文件内容相同。</p></details>
  <button disabled={disabled} onClick={onClose}>关闭历史复审</button>
 </section>;
}
