# ADR-149：Library维护停止与一致快照捕获

日期：2026-10-09。状态：Library侧私有协议和快照捕获源码已接入，Main／Renderer流程、维护监督与完整恢复仍未接通或运行。对应架构 §22、FR13／WP11；延续ADR-148，不替代完整备份恢复目标。

## 全局维护身份

`CatalogMaintenance` 在Library进程维护唯一操作UUID和随机租约token。状态为 idle／draining／frozen／capturing／releasing／released／failed。进入draining立即拒绝新的普通RPC，包括会懒加载或修改缓存的读取；进入维护前已登记请求全部settle后才能确认frozen。

Library只在可信parentPort提供 `catalogMaintenanceState`、`catalogMaintenanceBegin`、`catalogMaintenanceCapture`、`catalogMaintenanceRelease`，尚无Renderer可调用入口。状态／文件位置和租约token只留在Main—Library私有通道。重试同一捕获请求沿用原promise和结果；改变pending内容不能复用同一捕获身份。释放意图固定，已请求释放后不能开启新捕获；正在捕获时释放必须等待实际捕获结束。

此阶段身份和回执仅在当前进程内，不提供崩溃后重放或原操作持久回执。失败不能根据RPC超时自动解除维护。停止阶段失败保留failed及占用，不能宣称frozen；恢复需要应用重启后核对。捕获文件失败保留独立暂存资料，Library仍保持frozen，等待明确释放或后续处理。

## 各类资源停止

- 搜索派生索引与恢复轮询：清除计时器／提升索引代次，回调和恢复循环检查全局维护；开始前已在途恢复工作需settle。
- 普通及恢复文件读取：`FileReadGate.quiesceAll` 使用独立全局owner，阻止新读取、请求已有可取消读取停止并等待登记promise结束。释放全局维护不解除既有逐文件写回／恢复占用。
- 扫描：暂停队列pump，终止当前扫描并等待整次runQueue退出。当前任务以原owner在事务中转为interrupted，保留安全检查点、不执行缺失对账；已存在取消请求仍确认cancelled。已排队任务保留；释放后只恢复队列，interrupted任务需用户明确继续。媒体监督退出不明确保持halted，不能建立快照。
- 目录监听：保存合并中的变化、关闭watcher、失效在途probe代次，登记并等待实际probe promise；维护期间tick不执行reconcile等数据库写入。保留维护前系统暂停意图，释放不会强行恢复之前已暂停的监听。
- 波形：暂停新分析及队列pump，取消当前分析并等待原进程close和整个任务结束；未运行的队列保留。当前取消结果不是无损续算，仍需后续完整分析任务恢复功能。
- 媒体解析：等待全部登记读取和进程结束，busy／waiting／uncertain任何未归零均不能确认维护。正常取消与生命周期不确定仍沿用现有监督分类。
- 写回／核对／恢复：立即发送既有取消信号、清空短期预览，再等待全部阶段工作、预览和恢复释放promise；要求暂存、核对、提交、恢复原生客户端均quiescent。保留日志、工件、原租约及未决恢复状态，维护不代替文件恢复认证。
- 在线数据源：暂停新的broker请求、清理缓存并请求取消；新增实际lane处理promise登记。查询promise在取消后可能先reject，因此还要等待后台fetch／解析lane真正结束，不能仅等待RPC。

所有drain使用allSettled收尾，失败不能让其他已登记drain成为未观察promise。尚未接入Main音频／ASIO面板／历史导出等资源的维护停止，这些必须在正式备份流程进入Library维护前完成。

## 一致数据库快照

`LibraryDatabase.createCatalogBackupDatabase` 只用于维护协调器持有的冻结连接。通过Node的SQLite Backup API按128页批次创建快照，不复制活动DB单文件。目的文件在独立暂存目录中以wx保留，核对原身份；复制后再次核对来源、版本和11项关键计数。

只在自有目的数据库上设置synchronous FULL及journal_mode DELETE，关闭连接并sync；源库日志模式不改变。随后调用ADR-148的独立readOnly完整性／FK／页面边界／来源／计数检查，目的数据库无需WAL、SHM或journal文件。该流程仍须MVP实际验证Backup API、目的文件保留方式、日志模式、兼容和故障行为。

源码核对发现既有migrate入口仍使用最高67和67短路，而迁移已经能生成68：修正为最高68及68短路，让67可以进入68迁移，并保留拒绝更高版本。这是源码修复，未运行67→68、68重开或更高版本负例。

## 完整资料快照树

在 `userData/backups/catalog` 下为原操作新建独立UUID暂存目录，继承并观察普通父目录。规范数据库、已验证的Renderer pending原文、存在的Main播放历史pending，以及允许的tag-backups和三类阶段日志均进入快照。目录列举、来源复制、最终清单均有路径／文件类型／单链接／身份／长度／时间观察和总量预算；未知managed资料不静默漏掉。

Renderer pending采用原字符串，保留原请求UUID及隔离副本，编码后仍要求4MiB以内。Main pending存在／缺失状态与复制前后观察核对，若仍在变化则捕获失败。**Main内存中的尚未保存检查点及Renderer新修改并未由Library自动冻结；后续Main／Renderer协调器必须先完成它们的停止与捕获，不能直接调用此接口宣称完整备份。**

数据库驻留歌词、配置、歌单、历史和缓存随库保留；音乐原文件、源目录内恢复工件和系统凭据仍按ADR-148排除／依赖原来源。组件清单记录Aural core及固定注册的三个Provider，包括尚未启用的能力；按现有Provider契约记录版本 `1`，不虚构 `1.0.0` 或动态插件发现。

开始前按数据库页尺寸、managed工件和pending计算载荷，检查64GiB预算与额外64MiB可用空间；完成后再按实际快照重算清单和摘要。磁盘空间只是当次观察，不是预留容量。目录／文件mode不是Windows DACL能力锁，不承诺阻止外部进程替换祖先目录。

成功返回自有stagePath与规范manifest，**尚不生成或发布用户备份文件**。打包需要Main后续使用容器函数，并在实际维护进程退出和重新校验后发布。捕获失败保留独立目录及原数据，没有自动递归删除或覆盖。

## 仍需接入

1. Main维护状态、音频／分析／输出探针／面板／历史导出实际退出、窗口几何与队列／历史flush、Renderer冻结和pending捕获。
2. 可信保存／选取位置、独立维护进程／Windows Job硬预算、取消／休眠／退出和持久操作日志／重启对账。
3. 备份容器打包发布、恢复预览、原库回滚快照、关闭所有连接后恢复替换、阶段日志与启动故障回滚。
4. 原来源重新授权、设备／凭据确认、pending原回执及未决写回工件对账；缓存可选策略、迁移checksum及完整领域核对。
5. MVP的SQL、真实文件、维护交错、损坏／磁盘满／超时／崩溃／目录链接／进程故障、UI、大库及发布门槛。

45分钟检查覆盖捕获中的异步步骤，但不能在同步SQLite完整性检查或阻塞原生I/O中强制中断；Backup API没有在此模块提供取消接口。没有把超时当实际退出，强制预算仍需独立维护进程监督。本批只做类型、构建及发行静态核对，不调用新函数或运行SQL、备份、恢复、应用、测试、媒体或驱动。完整FR13、WP11及架构目标仍未完成；仅ASIO实机继续搁置，无新安装包。
