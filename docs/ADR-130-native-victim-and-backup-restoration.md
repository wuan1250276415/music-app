# ADR-130 原生旧文件与备份恢复组件

日期：2026-10-04。状态：0.124.0 源码/编译阶段，schema54保持。覆盖 WP09/FR12/AC12 的恢复底座；完整 FR01–FR14/WP01–WP11/G1–G5/AC01–AC19 目标保持，尚未验收。

## 问题与实现范围

提交或恢复的两个移动之间可能中断，使歌曲原路径暂时缺失；也可能实际目标已写入，但用户需要恢复旧标签。ADR-129 可以确认目标并更新曲库，不能恢复文件。本批次实现独立原生 tag-file-restorer.exe、两种恢复方式、严格协议/证据和监督客户端。

此组件尚未接入 TagWriteManager/Main/服务/preload/界面的实际执行入口。阶段持久日志与数据库回执/CAS租约生命周期、六工件中断核对、恢复后的来源重新解析/曲库事务/读取释放、完整ACL政策和认证继续。只能称恢复底座已实现，不能称恢复闭环或 AC12 已通过；本批次没有执行文件操作。

## 独立认证与冻结身份

新增 release/tag-restore-certification.json，独立于提交认证目录；version1、最多16项，每项 id/adapter/filesystem/scheme/mode/evidenceSha256。适配器 aural-flac-restore-v1、local-ntfs，scheme 分别 exclusive-handle-restore-victim-v1、exclusive-handle-restore-backup-v1。模式对应认证、证据摘要必须有效，恢复 ID 不得与提交 ID 重复。当前两个目录均空，不允许通过环境变量或 IPC 打开。

生成独立 TypeScript/native 清单，客户端和原生组件均检查模式与认证后再打开文件。协议v1绑定独立 operationId、原 commitOperationId、jobId、当前恢复 leaseId/leaseRevision、certificateId、模式、来源/备份根、原三文件提交基准、最新四文件实际快照、原暂存和提交日志SHA，以及旧工件/恢复副本/被移走目标的三个不同UUID。没有任意恢复目标路径参数，两个新工件名称由原生固定生成。

纯协议历史解析可以显式跳过当前认证校验，实际客户端 run 没有这个绕过选项。只有未来由当前任务、不可变日志/全部数据库回执、最新核对及新租约派生的请求才能接入执行；本轮原生不能直接读取/证明 Library 的原日志，这是后续协调层职责。

## 路径、物理身份与载荷

受控本地可写 NTFS，固定授权根及其祖先和源父目录句柄，拒绝重解析/硬链接/ADS/无法保留属性。四个现存工件同时 share0 持有，缺失名称明确复核；完整文件/元数据/音频SHA、大小、物理文件身份与选定快照一致。根和父目录卷/文件ID/创建时间匹配冻结证据。

备份必须等于原来源的完整 FLAC 载荷且是原备份物理文件；旧工件若存在必须为原来源物理文件，原路径和暂存若存在必须为已写入目标物理文件；任何未知、busy、unreadable 或两个目标名称同时出现均拒绝。来源与目标音频摘要/字节数相同，而完整摘要必须不同。缺失原路径时可从仍存在的旧工件或有效备份恢复，始终保留备份与暂存。

hash 保证复制载荷一致，不是解码金样或音质认证。64GiB/文件、32MiB FLAC metadata/1024块等既有边界保持。

## 两种方式与六阶段

阶段固定为 locked/prepared/intent/displaced/restored/verified，每个阶段必须获得上层不可变日志 fsync 和数据库 FULL-sync 回执后才 ACK；没有仅收到消息即可继续的路径。原生30秒ACK期限，客户端严格顺序和六角色证明，最终 done 必须与 verified 持久阶段一致。

1. locked：重新持有并核对四个文件，确认新恢复副本/被移走目标名称缺失。
2. prepared：victim 使用完整旧工件；backup 以 CREATE_NEW/share0 在同目录生成 .aural-job-UUID.restore，复制已核对备份，写入/flush/回读全载荷。空间预检至少来源大小+16MiB，不能保证后续空间不变；失败留下可识别的部分工件，不删除或复用。
3. intent：冻结来源权限/时间策略，再核对全部持有身份和缺失名称。
4. displaced：原路径若有已写入目标，用同父目录句柄将其非覆盖移动到 .aural-job-UUID.displaced；原路径本来缺失则明确确认缺失，不制造目标工件。
5. restored：将旧工件或恢复副本用同目录非覆盖句柄移动放回原路径，不覆盖后来新出现的文件。
6. verified：再次读取全部现存文件摘要/身份，恢复后原路径必须符合完整原来源；核对时间/权限策略，在最后ACK后复核，再发 done。

非覆盖移动使用 [FILE_RENAME_INFO/SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)；固定父目录句柄和相对叶名称，ReplaceIfExists=false。两个移动的原路径缺失窗口显式存在，不宣称原子交换、目录持久化或掉电恢复已经认证。外部抢先创建名称会使动作失败，所有已保留文件/副本留下供后续六工件核对；没有自动回滚、删除、覆盖或暗中重试。

证明六个固定角色 original/backup/temporary/victim/replacement/displaced、目录物理身份、lease/认证/日志SHA/三个工件UUID。阶段之间恢复策略和选择来源物理身份不可变化；backup 副本必须有独立物理身份，victim 恢复保持原来源物理身份。备份恢复不更改旧工件，旧工件恢复不创建备份副本。

## 权限、时间与监督

victim 保留已有来源DACL/owner/group和基本属性，来源创建/修改时间必须仍符合原提交基准。backup 的新文件创建/修改时间来自原来源基准，lastAccess/属性/DACL来自实际备份；owner/group与新文件不同且需要特权时拒绝，不尝试修改所有者。

备份阶段未保存可重建原ACL的完整安全描述符，因此 backup 的权限明确标为 restoration-source-dacl，**不能宣称恢复了原文件完整ACL**；SACL/audit仍 not-certified。完整 ACL/时间政策、备份安全描述符保存与认证是后续工作，独立空认证清单防止将这项限制带入当前用户文件写入。

抽取既有提交组件的原生文件/摘要/安全/移动帮助函数与监督入口到 tag-file-transaction.hpp，共用固定父进程身份、Job一个进程/128MiB、8小时wall/6小时CPU、父进程退出或stdin EOF终止、有限帧/序列/进度/诊断。提交函数保留原逻辑，并修正源位于驱动器根目录时旧工件路径重复分隔符问题。

TagFileRestorer 共用既有实际close及阶段回调退休的传输规则，固定执行文件和环境、严格请求/帧预算，最终六阶段和 done 才成功，未知退出不重用实例。回调必须先持久化恢复意图及回执，下一批接入协调层。未来停止/重启需按实际六文件和持久日志解释；本次没有应用读取释放或曲库提交。

## 后续与 MVP 验收

继续完整恢复日志/数据库租约和旧提交历史隔离，六工件检查与失败重进、恢复来源预览/解析/曲库事务和 owner 读取释放，断裂日志、完整ACL政策、保留清理、批次/MP3/集合来源及全架构余项。

MVP集中验证两个模式、原路径缺失/已有目标、独立认证拒绝、共享/链接/目录替换/ADS/属性边界、所有阶段中断/满盘/目标名竞态/半复制、ACK或数据库结果丢失、改写再改回、权限与时间/flush/掉电、异常退出及回调退休、恢复后重新解析与音频金样、重启及用户个人身份保留。SQL/迁移、程序、测试、媒体/音频/驱动本轮均不运行。用户的封面和播放详情需求沿用，实际缺失封面与交互待MVP；ASIO实机继续搁置。

## 本批次验证

Main／Renderer类型检查及构建通过（127模块，主块387.18kB／gzip121.76kB）；全部生产原生组件、新恢复程序及既有金样编译通过，未运行；41个CommonJS语法、发行生成文件与分发清单（18个npm运行依赖／5个vendored组件）静态核对通过。没有执行程序、测试、SQL/迁移、真实媒体、音频或驱动。没有新安装包，最新已验证仍0.29.0。源码归档 outputs/aural-prototype-v0.124-source.zip，归档时核对CRC。
