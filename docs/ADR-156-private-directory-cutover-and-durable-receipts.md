# ADR-156 私有曲库目录切换与持久阶段回执

日期：2026-10-10；源码批次：0.150.0；状态：已实现私有底座，完整恢复编排尚未接通，运行验收待 MVP。

## 背景与范围

恢复暂存与兼容性核对不能代替活动曲库的实际替换。目录切换需要先确认 Renderer、Main 及 Library 的资源停止，并在进程异常或断电后保留判断依据。本批只提供单次目录移动的固定原语及持久记录，不新增恢复应用按钮，不调用该原语，也不创建整库恢复事务、候选库或回滚快照。

## 固定动作与前置条件

Main 绑定本次应用的真实 userData，仅允许以下四个动作；transactionId 与 operationId 必须为 UUID：

| 动作 | 来源 | 目标 |
|---|---|---|
| retire-original | userData/library | backups/restore-transactions/transactionId/data/original-library |
| install-candidate | data/candidate/library | userData/library |
| retire-candidate | userData/library | data/retired-candidate |
| restore-original | data/original-library | userData/library |

相对目录均位于同一 userData。事务、data、candidate 根必须已经存在，普通目录及其实际位置、卷／文件索引／创建时间身份必须与原请求相同。Main 必须持有同一事务的 frozen 维护 owner，Library 服务的实际所有者已退出，应用没有退出或休眠。备份、恢复暂存和目录移动互斥。没有任意来源或目标路径接口，没有覆盖、删除、复制退路或 Renderer 直接调用入口。

## 原生移动与监督

Windows 适配器限定本地可写固定 NTFS 卷。每一级祖先保持不共享删除的目录句柄，拒绝 reparse、重定向和变化后的身份。来源使用带 DELETE 权限且不共享的目录句柄；目标父目录固定句柄申请 FILE_ADD_SUBDIRECTORY／FILE_TRAVERSE。目标叶子必须不存在，查询失败、父目录缺失和权限失败不能当作不存在。

调用 SetFileInformationByHandle(FileRenameInfo)，RootDirectory 为固定目标父句柄，FileName 为固定叶子，ReplaceIfExists 为 FALSE。该接口的相对名称与禁止覆盖语义见 [Microsoft FILE_RENAME_INFO 文档](https://learn.microsoft.com/zh-cn/windows/win32/api/winbase/ns-winbase-file_rename_info)。前置观察不能证明运行时移动必定成功；API 返回和后续身份核对均为必要条件。

四个顺序阶段为 locked、intent、moved、verified。每阶段发送完整固定证明，Main 保存并同步原记录，返回原操作／序号／完整记录 SHA256 ACK 后原生进程才继续。移动后再次核对句柄最终路径、来源不存在、根身份及原目录身份。没有目录 FlushFileBuffers 成功声明；持久日志不证明断电后目录名称持久，启动必须重新观察实际目录。

传输为长度前缀帧，Main 严格核对字段、操作身份、顺序、阶段和证明；单帧 64KiB、总输出 384KiB、stderr 16KiB、有界 UTF-8。监督绑定父进程实际 PID／映像，原生 Job 限制与父死亡守卫保持；Main 单次期限为 45 秒。中断发送停止并反复等待真实 close，不把 kill 返回或超时当作退出。收到全部阶段／done 仍必须等实际正常进程退出。

## 持久记录

固定目录为 backups/restore-transactions/transactionId/moves/operationId。每事务最多 16 个单次移动目录，每目录仅 request.json、0001.json 至 0004.json、exit.json 六个已知文件。新操作目录独占创建，已有操作不重新执行、不收养；所有记录使用 wx、同步写入及普通单链接文件／句柄与路径一致核对。

request 绑定原请求、moves 和操作目录身份。阶段记录绑定完整 request 文件摘要、前条文件摘要和规范固定字段帧；读取拒绝字节顺序差异、额外字段、重复键、缺口及未知文件。exit 独立记录仅在真实正常退出、全部阶段、目标身份和来源缺失核对通过后写入。历史 verified 阶段不能伪装为进程已退出；历史 exit 也不代替当前目录观察。

发生不确定原生结果后 Main 保持不确定占用，拒绝后续移动；重启或完整恢复核对机制必须处理真实目录状态，不能自动释放或猜测回滚。五类生命周期事件（服务异常退出、窗口重新加载、Renderer 退出、窗口关闭、休眠）均中断私有移动；退出等待不证明期限内已干净结束。

## 打开曲库之前的启动核对

Main 在创建 Library 进程之前只读检查 restore-transactions 根；不存在或普通空根可以沿用普通启动。最多读取 64 个事务／每事务 16 个移动记录，拒绝链接、重定向、超预算和读取中身份／登记列表变化。重开请求必须绑定当前 userData、事务／移动 UUID 和原规范文件摘要，再读取完整阶段链。

每事务观察 live／candidate／original／retired-candidate 四个固定槽位身份；每移动观察来源和目标，分别报告来源仍在且目标为空、目标持有原身份且来源为空、目标持有原身份但来源已被另一目录占用、其余冲突。阶段数和历史实际退出回执单独报告，不从记录顺序猜测当前名称。未知资料或损坏记录保留并阻止打开曲库。

本批尚无全局恢复／回滚完成回执和新 Library 启动证明，因此有任何整库恢复事务登记均停止打开曲库并显示原因，即使单次移动 exit.json 完整也不能通过。当前未接通的恢复应用流程不会创建这些事务。后续完整协调器必须增加终态证明与实际目录一致检查及受控恢复界面；本批不自动回滚、删除资料或创建空库替代未决曲库。Node 目录观察仍不是 OS 原子锁或硬 I/O 期限，真实竞争和故障验证待 MVP。

## 后续完整恢复要求

仍需创建受控候选库与当前曲库一致快照、全局事务意图和阶段记录，连接受控 Library 实际退出／新库启动证明，持有维护资源直到成功或回滚完成；在已接入的启动只读观察之上增加全局终态核对和中断切换恢复编排。还需处理 pending 隔离／审核、来源权利和外部路径、配额与受控清理。完成这些及运行故障演练后才能开放应用恢复入口。

## 验证边界

Main 与 Renderer 构建、类型检查、原生编译及发行静态检查用于确认源码可构建。本批未执行应用、目录移动原语、SQL／迁移、备份恢复、测试、媒体或驱动；不声明目录切换、断电恢复或整库恢复已验收。schema68、音频 IPC1.22、媒体协议10不变。无新安装包；仅 ASIO 实机验证搁置，完整架构范围保持。
