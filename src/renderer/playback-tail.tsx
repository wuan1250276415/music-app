import React from 'react';
import type {PlaybackTail} from '../shared/contracts';
export function PlaybackTailInfo({tail}:{tail:PlaybackTail|undefined}):React.JSX.Element|null{
 if(!tail)return null;
 return <section className="detail-clock" role="status"><strong>{tail.status==='flushing'?'正在处理歌曲尾部':tail.status==='draining'?'正在等待尾部输出':'歌曲尾部输出已结束'}</strong>
  {tail.status!=='completed'?<p>播放列表会在尾部处理完成后继续。仍可暂停、停止或跳转。</p>:<p>{tail.evidence==='exclusive-period-estimate'?'本次依据缓冲周期估计完成，设备没有提供精确的尾部位置。':'本次依据设备报告或缓冲读完状态完成。'}实际 DAC 输出仍待验证。</p>}
 </section>;
}
