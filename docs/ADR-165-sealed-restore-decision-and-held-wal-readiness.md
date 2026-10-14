# ADR-165 恢复完成决策封存与冻结 WAL 就绪

状态：源码实现，运行验收待 MVP。日期：2026-10-10。版本：0.159.0。

## 目的与决定

ADR-164 已经整理中断任务并保存新的 DELETE 模式完整清单。正式恢复使用 WAL 前，先持久封存当前角色及三方准备结果，再让同一实际 Library 进程转换和检查连接。否则中断后只能看到已经变化的数据库文件，没有解释其变化的原决策。

本批的 decision-sealed 是不可变完成决策，service-ready-held 是仍冻结的服务准备结果，均不是应用恢复完成。普通服务 ready 标志、dormant 模式与三方维护占用保持；恢复后的应用仍不能使用普通业务或后台任务。

## 封存与文件核对

Main 核对当前实际新文档、同一曲库实例、目录身份和完整 normal-prepared 清单，然后保存 decision-sealed。该决策绑定原事务、独立 completion UUID、激活、candidate/original 角色、正常准备及 manifest、pending、hydration、renderer-ready 摘要，以及本次明确的后台恢复意图。封存后再次核对完整曲库，才保存 service-ready-intent。

服务请求既绑定决策内容摘要，也绑定原不可变封存记录的实际规范文件 SHA；全局链解析使用已经读取的原记录 SHA，不能以调用者宣称的摘要替代。新请求包含同一实例、租约、目录、随机挑战和正常准备摘要。两项意图均持久在实际 WAL 转换之前。

## 同一进程实际 SQLite 核对

Library 独立读取全局链，要求 service-ready-intent 是当前最后记录，且原正常准备与本进程保留结果完全一致。实际转换前核对所有 library 文件、十组使用状态和权限策略。然后在原暂停连接执行 WAL 转换，读取 schema68、foreign_keys、synchronous=FULL，并要求 integrity_check(1) 为 ok、foreign_key_check 无任何返回行。

转换后重新读取来源、11表数量、十组使用状态和权限；核对目录仍属原身份、维护 operation/token/phase=frozen、网络停止，以及搜索/文件恢复计时器和实际工作为空。回执绑定实际 PID、构建、实例、请求及这些结果。Main 仍按原实际进程核对后保存 service-ready-held。

WAL 会改变数据库头及日志布局。因此转换前原文摘要和转换后逻辑/连接证据分开记录，不要求活动 WAL 连接的文件集合等于旧 DELETE 清单，也不声称此阶段已产生可供重启放行的应用完成证明。

## 主流程与状态投影

Main 私有 prepareCompletion 顺序接通可写准备、pending 保留/处理、Main 使用状态重建、受控新文档、普通服务准备和完成决策/WAL 就绪。重载之前沿用原 frame 授权；之后沿用原 Main 操作并独立核对实际新文档，不继续信任旧 frame 的 IPC，也不让准备视图发起应用恢复。

Library 的十组状态读取提取为同一只读投影，避免 hydration、normal preparation、WAL readiness 使用不同字段或默认队列。所有调用者负责读取前后维护租约与目录/文件核对。

## 失败与剩余范围

重复的完全相同请求复用原工作，改变请求拒绝；45分钟监督和所有者生命周期中断保持。WAL 转换、检查或记录失败时保留原封存决策、原库、候选、留档和三方占用。不能按旧 DELETE 清单移动或猜测回滚，也不能释放后台或把 missing ACK 当完成。

当前最长全局链36/48条；单帧、累计及事务保留边界保持。应用最终 completed、Library/Main/Renderer 有序释放及真实回执、普通 App 挂载和交互、未决重启核对及处理界面、完整领域/迁移校验和及实际配额清理仍待完成。全部 FR01–FR14、WP01–WP11、G1–G5、AC01–AC19 保留；FR13/WP11/AC17 未验收。

## 验证

Main/Renderer 类型及构建、生产原生和既有金样仅编译通过，未执行。41个CommonJS来源只做语法检查；发行文件及最终分发清单静态核对通过（18个npm运行依赖、5个vendored组件、Electron44.4.5）；最后Main改动重新构建并刷新清单。本轮未打包或运行安装目录检查。没有运行应用、SQL/迁移、worker、恢复、媒体、驱动或测试。真实 WAL/完整性/FK、导航和流程交错、故障与长时运行留至 MVP。仅 ASIO 实机验证暂停；实际缺图待复现，无新安装包。
