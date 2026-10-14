import React from 'react';
import type {MetadataNetworkState} from '../shared/contracts';
export function MetadataNetworkControls({state,busy,searching,now,cancel,toggle,clear}:{state:MetadataNetworkState|null;busy:boolean;searching:boolean;now:number;cancel:()=>void;toggle:(enabled:boolean)=>void;clear:()=>void}):React.JSX.Element{
 const retry=state?.retryAt&&state.retryAt-now>1500?Math.ceil((state.retryAt-now)/1000):0;
 return <div className="metadata-network-controls">
  <label><input type="checkbox" aria-label="启用在线元数据查询" checked={state?.enabled??true} disabled={!state||busy&&!searching} onChange={event=>toggle(event.target.checked)}/>启用在线查询</label>
  <p className="metadata-note" role="status">{!state?'正在读取查询状态…':!state.enabled?'在线查询已暂停':state.blocked?'数据源拒绝访问，请检查联系信息后重新启用':retry?retry>3600?'数据源要求较长时间暂停，请稍后再试':`请求暂缓，约 ${retry} 秒后可继续尝试`:state.queued?`正在查询，另有 ${state.queued} 个请求等待`:state.active?'正在访问数据源':'仅在点击搜索后查询'}{state?` · ${state.cacheEntries} 条短期候选缓存`:''}</p>
  <div>{searching&&<button onClick={cancel}>取消当前搜索</button>}<button disabled={!state||busy&&!searching} onClick={clear}>清除候选缓存</button></div>
  <small>使用系统网络设置。清除缓存会取消查询和已有候选预览，已确认的曲库资料保留。</small>
  {state?.retentionMode==='preview-only'&&<p className="metadata-note" role="status">当前只允许候选预览；新的在线修改已暂停保存。可在“数据源设置”中调整。</p>}
 </div>;
}
