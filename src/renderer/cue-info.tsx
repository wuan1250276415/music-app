import React from 'react';
import {CUE_GAP_LABELS} from '../shared/cue-history';
import type {LibraryItem} from '../shared/contracts';

function clock(frame:number|null):string{if(frame===null)return '未声明';const minute=Math.floor(frame/4500),second=Math.floor(frame%4500/75),tick=frame%75;return `${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}:${String(tick).padStart(2,'0')}`;}
export function CueInfo({item,onHistory}:{item:LibraryItem;onHistory?:()=>void}):React.JSX.Element|null{
 if(item.kind!=='cue')return null;
 const cue=item.cue;
 const embedded=cue?.parserVersion?.startsWith('aural-flac-cuesheet-')??false;
 const denominator=cue?.timeBaseDen??75;
 const stamp=(tick:number|null)=>tick===null?'未声明':denominator===75?clock(tick):`${Math.floor(tick/denominator/60).toString().padStart(2,'0')}:${(tick/denominator%60).toFixed(3).padStart(6,'0')}（${tick} 采样）`;
 return <details className="detail-cue-info"><summary>{cue?.hidden?'隐藏／前导音频':'CUE 编排信息'}</summary>{cue?<>
  <dl><dt>{embedded?'内嵌编排所在文件':'编排文件'}</dt><dd title={cue.documentPath}>{cue.documentPath}</dd><dt>编排类型</dt><dd>{embedded?'FLAC 内嵌 CUESHEET':'外部 CUE 文本'}</dd>{!embedded&&<><dt>文件编码</dt><dd>{cue.encoding??'尚未记录'}</dd></>}<dt>播放起点</dt><dd>{stamp(item.sourceSampleRange?.start??item.sourceStartCueFrame)}</dd><dt>前间隙归属</dt><dd>{CUE_GAP_LABELS[cue.gapPolicy]}</dd><dt>INDEX 00</dt><dd>{stamp(cue.index00Frame)}</dd><dt>INDEX 01</dt><dd>{stamp(cue.index01Frame)}</dd><dt>PREGAP</dt><dd>{stamp(cue.pregapFrame)}</dd><dt>POSTGAP</dt><dd>{stamp(cue.postgapFrame)}</dd>{cue.flags.length>0&&<><dt>标志</dt><dd>{cue.flags.join(' · ')}</dd></>}</dl>
  {cue.interpretationPending&&<p className="cue-info-pending">已选择重新解释编排，当前编排暂不可播放；新扫描验证成功后恢复。</p>}
  <p>{denominator===75?'时间以“分:秒:帧”显示，每秒 75 帧。':`时间以分、秒和原始采样位置显示，每秒 ${denominator} 个采样。`}原始 INDEX 保留；文件内前间隙按当前归属分配。隐藏条目保留从文件开头到首轨实际播放起点的音频，不与本轨前奏重复。</p>
  {(Boolean(cue.pregapFrame)||Boolean(cue.postgapFrame))&&<p className="cue-info-pending">PREGAP／POSTGAP 是声明间隙，当前播放尚未插入对应静音。</p>}
  {cue.flags.includes('PRE')&&<p className="cue-info-pending">此轨标有预加重；当前播放保留原始音频，未进行去加重处理。</p>}
  {cue.indices.some(index=>index.number>1)&&<p>子索引：{cue.indices.filter(index=>index.number>1).map(index=>`${String(index.number).padStart(2,'0')} ${stamp(index.frame)}`).join(' · ')}</p>}
  {cue.sourceHash&&<small title={cue.sourceHash}>来源摘要 {cue.sourceHash.slice(0,16)}…</small>}
  {embedded&&<p>{cue.embeddedTextState==='text-only'?'索引和曲目信息来自音频文件注释中的内嵌 CUE 文本。':cue.embeddedTextState==='matched'?'分轨索引来自内嵌二进制编排，曲目名称与艺人等信息来自已核对一致的内嵌 CUE 文本。':'索引来自音频文件的内嵌二进制编排；未提供名称的音轨以编号显示。'}原始来源内容与采样位置保留在曲库中。</p>}
  {cue.embeddedTextState==='rejected'&&<p className="cue-info-pending">{cue.embeddedTextNotice||'内嵌 CUE 文本与当前编排不一致，未采用其中的曲目信息。'}</p>}
  {cue.embeddedTextSourceHash&&<small title={cue.embeddedTextSourceHash}>内嵌文本摘要 {cue.embeddedTextSourceHash.slice(0,16)}…</small>}
  {onHistory&&<p><button onClick={onHistory}>{embedded?'查看内嵌 CUE 来源历史':'查看 CUE 原文与编排解释'}</button></p>}
 </>:<p>重新扫描后可查看此编排的索引与间隙信息。</p>}</details>;
}
