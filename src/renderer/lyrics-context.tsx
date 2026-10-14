import React from 'react';
import type {LyricsScopeSnapshot} from '../shared/contracts';

export function LyricsContext({value}:{value:LyricsScopeSnapshot|null|undefined}):React.JSX.Element{
 if(!value)return <p>此版本未保存导入时的曲目信息与范围。旧数据保留原文，不推测历史起点。</p>;
 const {item,catalog}=value,start=item.sourceStartCueFrame===null?item.sourceStartSeconds:item.sourceStartCueFrame/75,end=item.sourceEndCueFrame===null?item.sourceEndSeconds:item.sourceEndCueFrame/75;
 return <details className="lyrics-document-context"><summary>导入时的歌曲与范围</summary><p>{item.title} · {item.artist} · {item.album}</p><p>{item.kind==='cue'?'CUE 虚拟曲目':'音频文件'} · 源音频 {start.toFixed(3)} 秒至 {end===null?'文件结束':`${end.toFixed(3)} 秒`}{item.sourceStartCueFrame!==null?` · 75 fps 帧 ${item.sourceStartCueFrame} 至 ${item.sourceEndCueFrame===null?'结束':item.sourceEndCueFrame}`:''}</p><p>{item.codec}{item.sampleRate!==null?` · ${item.sampleRate} Hz`:''}{item.bitsPerSample!==null?` · ${item.bitsPerSample} bit`:''}{item.discNumber!==null?` · 碟 ${item.discNumber}`:''}{item.trackNumber!==null?` · 轨 ${item.trackNumber}`:''}</p><small className="lyrics-document-hash">原始音频路径：{item.path}</small><small className="lyrics-document-hash">曲目 ID：{item.id} · 文件 ID：{item.fileId}</small><small className="lyrics-document-hash">范围 ID：{value.scope}</small>{catalog&&<small className="lyrics-document-hash">录音：{catalog.recordingId} · 发行：{catalog.releaseId} · 发行曲目：{catalog.releaseTrackId} · 当时曲目修订 {catalog.revision} / 发行修订 {catalog.releaseRevision}</small>}<p>保存时的信息供历史查阅；恢复此版本只改变其原范围内的启用状态。</p></details>;
}
