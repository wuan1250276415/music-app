# ADR-091：Windows 系统媒体会话

日期：2026-10-02；源码 0.86.0；schema v38、音频 IPC 1.19、媒体协议 6 不变。系统媒体组件采用独立协议 1。

## 范围与接口证据

实现架构 §19 桌面能力中的 Windows 系统媒体会话，覆盖歌曲／歌手／专辑／专辑艺人、本地封面、位置／时长、播放／暂停／上一首／下一首／停止／seek，以及系统界面提供时的循环／随机请求。已有播放栏、歌词与详情入口不替换；系统面板与托盘使用同一 Playback API 和队列。

Microsoft 的 [GetForWindow 文档](https://learn.microsoft.com/en-us/windows/win32/api/systemmediatransportcontrolsinterop/nf-systemmediatransportcontrolsinterop-isystemmediatransportcontrolsinterop-getforwindow)明确要求顶层窗口属于调用进程。因此独立组件不能接收 Electron Main 的 HWND 并宣称该窗口归自己所有。此处创建组件自己的隐藏顶层窗口，使用相同 AUMID `dev.aural.music`、窗口标题及版本资源中的 Aural 名称；不使用 message-only HWND。

[Microsoft 手动 SMTC 文档](https://learn.microsoft.com/en-us/windows/apps/develop/media-playback/system-media-transport-controls)提供手动状态、显示更新、时间线及事件接口。这里直接映射现有音频状态，不创建第二套 MediaPlayer 或静音音频流；使用本机 Windows SDK 10.0.19041 的 WinRT ABI 与 WRL 构建，避免引入 Electron 原生 addon ABI。

## 原生组件

- 新增 `native/system-media` 与打包资源 `system-media.exe`。独立进程持有窗口、WinRT 对象与事件注册；退出时停用会话、解绑事件、清空显示并销毁窗口。确认实际启动父 PID，并持有父进程句柄，Main 退出时组件终止。Main 正常关闭先发送 shutdown，最多 1.5 秒后强制终止尚未关闭的组件。
- 标题等文本限制为 4096 UTF-8 字节、拒绝 NUL 与非法 UTF-8。缩略图只接收已监督规范化的 JPEG，最多 384 KiB，以内存流交给 WinRT，不传音乐文件路径、临时文件或网络 URL。清空封面明确设置空引用，切歌不会保留上一首的图片。
- 位置使用既有 PlaybackState 的观察值，限定七天以内；已知时长时显示时间线，只有可定位状态提供 seek 范围。更新在状态／队列／资料改变时发起，连续位置按五秒桶刷新；没有独立设备时钟或精确呈现认证。Play／Pause 采用声明式、幂等操作，已有播放／暂停会话保持这两个能力可用，重复 Play 不转成 Pause。
- 系统回调只尝试放入最多八条操作，竞争时丢弃，不等待 Main、不写管道；Stop 在已接受的队列中优先清除其他待发操作。输入线程保留最新快照，UI／WinRT 线程处理窗口消息和更新；输入通过管道可读字节轮询退出，不使用可能在 join 时永久等待的阻塞 stdin。
- 输入帧最多 1 MiB，每五秒最多 64 帧／8 MiB；输出帧最多 4096 字节。每个帧核对独立协议、构建身份、nonce、顺序与完整字段。Main 一次只等待一个更新回执，并按每五秒 32 帧／4 MiB 的保守预算延迟、合并最新快照。注册／首帧五秒、状态确认五秒、心跳八秒超时后 Main 停用控制并请求终止，不自动重启。

## Main 与桌面接线

- `SystemMedia` 按操作 token、队列 entry／修订、曲目、已观察时钟 generation 与系统睡眠建立控制 context；旧组件／旧快照的按钮事件不能套用到新曲目。预备播放、休眠、没有当前队列项等状态拒绝相应操作，并重新同步系统显示。停止立即调用现有 stop，取消尚未执行的系统操作；其他操作采用单在途和 350ms 重复抑制。
- 实体资料与封面各用一个读取通道，待处理项只保留最新 ID／曲库修订；迟到结果不替换新曲信息。资料先独立更新，封面失败不阻断按钮或文字。封面从既有优先级的库缓存读取，再核对资源地址和 JPEG 内容 SHA-256；资源已回收、读取失败或超预算时本次保留空封面。完整统一取消、服务恢复与数据管理仍属后续 FR13。
- 初始连接不启动播放。系统睡眠状态使按钮失效，唤醒仅刷新，不自动恢复音频。组件失败后给出明确状态与侧栏／托盘“系统媒体面板”重新连接入口；手动刷新会重新读取资料和封面，重连不起播。
- SMTC 注册完成时，`MediaKeys` 解绑自己的全局媒体键并保留用户原有设置；SMTC 不可用时，仅为已明确启用的用户恢复备用注册。设置处理中延迟恢复，保存结果未知时不推测启用；解绑未确认会报告，回调仍停用。不调用 unregisterAll，不改其他组件或应用的键盘注册。
- 新增只读状态、设置 IPC 和 `systemMediaChanged` 事件；状态中的 `verified:false` 保留运行验收边界。正常产品文字不显示研发验证术语，实际证据记在本 ADR 和实施表。

## 静态验证与未验收范围

类型检查、Main 编译、Renderer 编译（77 模块）、全部原生组件编译（含 SMTC 和版本资源）、发行／分发清单及 40 个维护脚本语法检查通过；源码归档校验另记实施记录。没有执行组件、应用、音乐文件、WinRT 会话、图片、SQL、音频、快捷键或安装包测试。

隐藏窗口在具体 Windows 版本上的媒体面板可见性、应用名／图标／AUMID 归属、其他播放器选择与媒体键路由、系统是否展示模式控件、后台／休眠、图片和 timeline 行为、故障／父退出／资源回收均需要 MVP 实机验证。注册回执不证明系统界面已显示，媒体面板状态也不证明 DAC 播放位置精确。macOS／Linux 平台适配、文件关联／拖放、主题／缩放／DPI，以及完整 FR/WP/G/AC 仍未全部实现或验收；ASIO 实机验证继续搁置，最新已验证安装包仍为 0.29.0。
