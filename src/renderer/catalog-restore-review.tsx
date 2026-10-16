import type {CatalogRestoreReview} from '../shared/catalog-restore-review';
import type {RestoreDomainScope} from '../shared/catalog-restore-compatibility';
import {useEffect,useState} from 'react';
const domains:Record<RestoreDomainScope,string>={settings:'应用设置',outputs:'音频输出偏好',providers:'在线数据源设置',playlists:'歌单规则', 'filter-presets':'筛选预设','counting-policy':'播放统计设置','lyrics-preferences':'歌词设置','genre-tree':'风格树','online-artwork':'已保存封面与修改记录','metadata-workflows':'元数据审核任务','background-recognition':'后台音频识别','tag-stage-batches':'后台标签备份批次'};
const providerNames:Record<string,string>={musicbrainz:'MusicBrainz','cover-art-archive':'Cover Art Archive',acoustid:'AcoustID'};
const pendingName=(key:string)=>key.startsWith('aural-playback-policy-pending-v2.invalid.')?'此前未确认的播放设置':({'aural-filter-preset-pending-v1':'筛选预设','aural-playback-policy-pending-v2':'播放设置','aural-rule-import-pending-v1':'规则导入','aural-smart-playlist-pending-v1':'智能歌单编辑','aural-smart-playlist-restore-pending-v1':'智能歌单恢复'} as Record<string,string>)[key]??'待核对资料';
export function CatalogRestoreReviewPanel({review}:{review:CatalogRestoreReview}){
 const {evidence,compatibility}=review;
 const [rootsOpen,setRootsOpen]=useState(false),[rootPage,setRootPage]=useState(0),rootPages=Math.max(1,Math.ceil(evidence.roots.length/50));
 useEffect(()=>setRootPage(0),[review.checkSha256]);
 const page=Math.min(rootPage,rootPages-1);
 return <section className="catalog-backup-history" aria-labelledby="catalog-restore-review-title">
  <h3 id="catalog-restore-review-title">恢复前审核</h3>
  <p>以下内容来自本次独立核对的备份快照。审核页面不替换当前曲库。</p>
  <dl><dt>核对时间</dt><dd><time dateTime={review.checkedAt}>{new Date(review.checkedAt).toLocaleString()}</time></dd><dt>曲库来源</dt><dd className="catalog-backup-digest">{evidence.origin}</dd><dt>数据库摘要</dt><dd className="catalog-backup-digest">{evidence.databaseSha256}</dd></dl>
  <h4>恢复后的访问设置</h4>
  <p className="catalog-backup-note">恢复会停止播放。备份中的音乐目录须重新选择并确认，自动扫描和在线数据源保持关闭；系统登录凭据需要重新设置。旧扫描、写回及凭据操作保留供核对，不会自动继续。</p>
  <details onToggle={event=>setRootsOpen(event.currentTarget.open)}><summary>音乐目录（{evidence.roots.length}）</summary>{rootsOpen&&(evidence.roots.length===0?<p>备份没有登记音乐目录。</p>:<><ul>{evidence.roots.slice(page*50,(page+1)*50).map(root=><li key={root.id}><span className="catalog-backup-digest">{root.path}</span><span>恢复后须重新确认</span></li>)}</ul>{rootPages>1&&<div className="catalog-backup-actions" role="group" aria-label="音乐目录分页"><button disabled={page===0} onClick={()=>setRootPage(n=>Math.max(0,n-1))}>上一页</button><span aria-live="polite">{page+1} / {rootPages}</span><button disabled={page===rootPages-1} onClick={()=>setRootPage(n=>Math.min(rootPages-1,n+1))}>下一页</button></div>}</>)}</details>
  <details><summary>在线数据源（{evidence.providers.length}）</summary><ul>{evidence.providers.map(provider=><li key={provider.id}><strong>{providerNames[provider.id]??provider.id}</strong><span>备份中{provider.enabled?'已启用':'未启用'} · 恢复后关闭</span></li>)}</ul></details>
  <h4>保留的待处理资料</h4>
  <p>旧扫描任务 {evidence.tasks.scans.toLocaleString()} 项，标签写回任务 {evidence.tasks.tagWrites.toLocaleString()} 项，凭据操作记录 {evidence.tasks.credentialCommands.toLocaleString()} 项。数量包含已结束的历史记录。</p>
  <p>待保存播放历史 {evidence.historyPendingBytes.toLocaleString()} 字节；标签恢复工件 {review.preview.writebackFiles.toLocaleString()} 个。它们会保留，仍须核对原文件和原操作。</p>
  {evidence.pendingKeys.length>0?<ul>{evidence.pendingKeys.map(key=><li key={key}>{pendingName(key)}</li>)}</ul>:<p>没有登记界面待核对资料。</p>}
  <details><summary>已检查的设置范围</summary><ul>{compatibility.domains.map(domain=><li key={domain.id}>{domains[domain.id]}：{domain.rows.toLocaleString()} 条</li>)}</ul><p className="catalog-backup-note">已检查数据库结构、完整性、关联和上述设置。该结果不代表全部业务资料或音乐目录权限均已验证。</p></details>
 </section>;
}
