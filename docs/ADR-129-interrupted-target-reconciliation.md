# ADR-129 中断提交后的目标确认与曲库恢复

日期：2026-10-04。状态：0.123.0 源码阶段，schema54；运行与迁移验收集中到 MVP。继续完整 FR01–FR14 / WP01–WP11 / G1–G5 / AC01–AC19，FR12/AC12 尚未验收。

## 问题与边界

ADR-128 只接受保存完整 verified/done/退出结果的 native_verified 分支。原生进程可能已经替换文件，但最终 ACK、退出或数据库结果未保存。实际目标已经符合冻结计划时，继续保留原提交中断历史，通过独立只读核对恢复曲库。此操作不恢复、移动、删除或写入音乐文件，也不认证原提交的权限政策或进程最终结果。

认证目录仍空，无 Main、服务、preload 或界面的原生提交执行入口。缺失、损坏或截断日志、未替换源、原路径缺失、未知文件/身份、目录或租约变动仍保留恢复占用；后续认证原生恢复继续。原生两个非覆盖 rename 的路径缺失崩溃窗口没有因此消失。

## 后端判定与冻结

沿用明确确认的 commandId/jobId/baseRevision/inspectionId/confirmed 请求。调用方没有可选择的恢复模式。schema54 为 tag_commit_reprobe 增加不可变 mode，后端依据原提交及最新实际四工件报告决定：

- native-verified：原提交 native_verified、实际退出/最终证明已保存、最新四工件 replacement-observed、matched/verified/revision5。
- interrupted-target：原提交 recovery_required、最新完成且核对进程实际退出的 replacement-observed 报告；文件日志 revision3–5，阶段 victim_moved/replaced/verified，matched 或 fs-ahead。

两种模式均要求同一操作、文件、任务审核修订、内容修订、新提交恢复租约身份和 epoch，最新 inspection 身份/租约、原暂存日志摘要、完整文件提交日志链、所有已保存数据库阶段回执。fs-ahead 必须真正领先数据库阶段；matched 要求相同最终摘要与阶段。重新解析绑定持久 mode，再读取日志时及曲库事务内确认 SHA、revision、matched/fs-ahead 与选定报告完全一致。日志后来推进或新的报告出现时拒绝旧动作，重新核对。

schema54 迁移前保存 pre-v54 备份。新 mode INSERT 触发器约束原提交状态；旧 schema53 历史默认 native-verified，已保存旧证明原样保留。旧运行中动作重启后转 interrupted，需要新动作获得新格式证明。既有隔离迁移 fixture 维护降级链，SQL 和 fixture 没有运行。

## 独立证明与曲库事务

复用 ADR-128 的原 owner 应用读取协调、监督子进程实际 close、两次原生四工件排他读取快照、实际原字段/多值/清空、目标元数据摘要、保护块/图片/STREAMINFO、全文件及音频摘要与物理文件身份、普通 tags 解析、目录/路径/单链接/BigInt 观察复核。证明新增 mode、originalExitConfirmed、journalRevision。实际四文件和目录必须与所选报告以及前后快照一致，技术资料与目标头部一致。

单一 FULL-sync 事务再次验证绑定与证明，沿用原 fileId/itemId 更新流/时段/关联资料/本地来源/搜索/ReplayGain/观察，保留个人数据、手工覆盖和原身份，推进文件内容与租约修订，完成标签任务及新的独立证明。成功后原 owner 读取释放仍须不可变回执，普通读取和新租约等待释放；提交后的观察变动标记文件待重扫。

native-verified 继续将原提交置 committed。interrupted-target **不修改**原 tag_commit_operation.state/final_json/exit_confirmed/journal_revision/journal_sha256，也不补写旧阶段回执、不制造 ACK 或 done。reconciled 是任务 completed 且独立 interrupted-target 证明 completed 时的界面投影，数据库原生状态没有增加这个值。界面显示“目标及曲库已恢复”，退出信息明确标为原提交历史。

## 重启与历史隔离

原提交历史 recovery_required 在独立恢复后继续存在。因此启动清除观察/标记 missing 只能作用于当前 recovery_required 标签任务，且当前文件 recovery 租约的任务、leaseId、leaseRevision 与原提交全部匹配。已恢复文件以及随后新任务持有的租约不会因旧中断记录而再次禁用。完成但尚未释放的动作继续由启动/5秒协调补释放。

核对句柄在 SQLite 前已关闭，应用读取门禁不是操作系统永久锁；不宣称文件系统与曲库原子、外部写入完全排除或完整 ACL/SACL 已验证。后来变化仍交给文件观察/监听与下一读取。完整 ACL/时间政策、认证恢复、断裂日志、工件保留清理、批次/MP3/集合来源映射与全架构余项继续。

## MVP 验收清单与用户功能

MVP 集中验证 schema53→54 迁移/触发器/旧证明、matched 与 fs-ahead 的 rev3/4/5、原 final/退出/DB回执缺失与历史保留、四工件身份/摘要/目录变化、日志新增/截断、并行拒绝、取消与未知退出、数据库回滚、提交后变化、释放前崩溃/重试、已恢复文件重启和同文件随后新任务不会被旧历史失效。

用户要求的内嵌封面优先读取、播放栏封面进入详情、专辑/歌手/风格点击检索、歌词同步滚动、顺序/随机/循环模式和播放列表沿用现有源码；本轮静态检查了入口连接。实际缺失封面案例与交互尚未运行验证。ASIO 实机验证继续搁置。没有新安装包，最新已验证安装包仍为0.29.0。

## 本批次验证记录

Main／Renderer类型检查与构建通过（127模块，主块387.18kB／gzip121.76kB）；全部生产原生组件和既有金样编译通过，未运行；41个CommonJS语法、发行生成文件及分发清单（18个npm运行依赖／5个vendored组件）静态核对通过。没有执行程序、测试、SQL/迁移、真实媒体/音频或驱动。源码归档为 outputs/aural-prototype-v0.123-source.zip，归档时核对CRC。
