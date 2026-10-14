import React from 'react';
import type {MetadataCandidate} from '../shared/contracts';
export function MetadataMatchReasons({candidate}:{candidate:MetadataCandidate}):React.JSX.Element|null{
 const evidence=candidate.matchEvidence;if(!evidence)return null;
 const label={exact:'一致',similar:'相近',different:'有差异',missing:'信息不足','edition-title':'标题相近，版本待核对',close:'接近',near:'略有差异'};
 return <section className="metadata-match-reasons" aria-label="候选匹配依据"><p className="metadata-note">排序参考歌名、歌手、专辑和时长；分数不是正确概率，仍需确认发行版与字段。</p>
  {evidence.retrieval?.kind==='fingerprint'&&<p className="metadata-note">查询依据：当前音频片段的指纹关联，来源排序值 {evidence.retrieval.score.toFixed(3)}，不是正确概率。已明确选择录音，发行版、版本差异和字段仍须独立审核。</p>}
  {evidence.retrieval?.kind==='confirmed-recording'&&<p className="metadata-note">读取依据：本地已确认录音 {evidence.retrieval.recordingId}；歌名、艺人或时长差异仍需审核，录音标识不确认发行版。</p>}{evidence.retrieval?.kind==='isrc'&&<p className="metadata-note">查询依据：录音编码 {evidence.retrieval.isrc}，来源关联 {evidence.retrieval.recordingCount} 个录音。编码不证明录音或发行版身份，仍需逐项审核。</p>}<ul><li>歌名：{label[evidence.title.kind]}</li><li>歌手：{label[evidence.artist.kind]}</li><li>专辑：{label[evidence.album.kind]}</li><li>时长：{label[evidence.duration.kind]}{evidence.duration.differenceSeconds!==null?` · 相差 ${evidence.duration.differenceSeconds.toFixed(2)} 秒`:''}</li></ul>
  {!!evidence.warnings.length&&<p className="metadata-note" role="status">{evidence.warnings.join('；')}</p>}
 </section>;
}
