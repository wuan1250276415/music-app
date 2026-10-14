import React from 'react';
import type {RootStatus} from '../shared/contracts';
export function CueSourceRegisterForm({roots,rootId,relativePath,disabled,onRoot,onPath,onReload,onSubmit}:{roots:Array<{id:string;path:string;status:RootStatus}>;rootId:string;relativePath:string;disabled:boolean;onRoot:(id:string)=>void;onPath:(value:string)=>void;onReload:()=>void;onSubmit:()=>void}):React.JSX.Element {
 const root=roots.find(value=>value.id===rootId);
 return <section className="scan-task-detail" aria-label="从来源备份创建新CUE来源"><h3>在音乐目录中创建新来源</h3><p>选择已登记的音乐目录和 CUE 相对位置。这里只登记来源和导入历史，不创建磁盘文件，不授予目录权限，也不自动应用编排。</p>
  <label>目标音乐目录<select aria-label="新CUE来源音乐目录" value={rootId} disabled={disabled} onChange={event=>onRoot(event.target.value)}><option value="">请选择音乐目录</option>{roots.map(value=><option key={value.id} value={value.id}>{value.path}{value.status==='offline'?'（离线）':''}</option>)}</select></label>
  <label>CUE 相对位置<input aria-label="新CUE来源相对路径" maxLength={4096} value={relativePath} disabled={disabled} placeholder="例如 Disc 1/album.cue" onChange={event=>onPath(event.target.value)}/></label>
  {root&&relativePath&&<p className="scan-task-path">登记目标：{root.path} ／ {relativePath}</p>}
  {!roots.length&&<p>请先在曲库中添加音乐目录，再读取当前目录列表。</p>}
  <div className="cue-history-export-actions"><button disabled={disabled} onClick={onReload}>重新读取音乐目录</button><button disabled={disabled||!root||!relativePath.trim()} onClick={onSubmit}>将备份登记为以上位置的新来源</button></div>
  <p>已有相同位置时会提示打开原来源。新来源没有磁盘观察；登记后请复审引用、明确选择历史原文，再扫描核对音乐。</p>
 </section>;
}
