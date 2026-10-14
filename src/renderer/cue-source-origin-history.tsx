import React from 'react';
import type {CueSourceOriginsPage} from '../shared/cue-source-origins';
export function CueSourceOriginHistory({value,disabled,onNext,onInspect,onExport}:{value:CueSourceOriginsPage;disabled:boolean;onNext:()=>void;onInspect:(commandId:string)=>void;onExport:(commandId:string)=>void}):React.JSX.Element {
 return <section className="scan-task-detail" aria-label="所选版本的原来源备份"><h3>此版本的原来源备份</h3><p>以下是导入登记记录。查阅和重新导出时会独立核对完整原备份；导出保持原字节、旧来源身份与旧解析结果。</p>
  {!value.items.length?<p>此版本没有保存的导入备份。</p>:value.items.map(item=><article key={item.commandId} className="scan-task-detail"><p>导入于 {new Date(item.createdAt).toLocaleString()} · 原版本保存于 {new Date(item.originalCreatedAt).toLocaleString()} · 原文 {item.rawBytes} 字节</p><p className="scan-task-path">原位置：{item.rootPath} ／ {item.relativePath}</p>{item.omitted&&<p>过长位置已缩短显示，完整内容保留在原备份中。</p>}<p>原版本</p><code className="cue-history-hash">{item.originalVersionId}</code><p>原备份摘要</p><code className="cue-history-hash">{item.archiveSha256}</code><div className="cue-history-export-actions"><button disabled={disabled} onClick={()=>onInspect(item.commandId)}>查阅并核对原备份</button><button disabled={disabled} onClick={()=>onExport(item.commandId)}>重新导出完整原备份</button></div></article>)}
  {value.nextCursor&&<button disabled={disabled} onClick={onNext}>下一页原备份记录</button>}
 </section>;
}
