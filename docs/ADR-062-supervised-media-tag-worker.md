# ADR-062：扫描标签独立进程与 Windows 资源监督

状态：0.57.0 源码实现；2026-10-01。schema v29、音频 IPC 1.8 不变；媒体任务内部协议新增 version 1。完整 FR01–FR14／WP01–WP11 继续保留，ASIO 实机验证仍搁置。

## 边界与启动

扫描器不再在 Library Service 中执行 music-metadata。标签任务经 `MediaParser` 启动 `native/media-worker/media-worker.exe`，由 C++ 监督组件启动应用自己的 Node 运行时及固定 `media-worker-entry.js`。只有一个扫描解析槽，符合架构最多两个媒体并行槽的上限；现有原生波形 worker 仍独立，统一媒体资源调度尚待实现。

TagAdapter 保留固定版本 music-metadata 和 strtok3。它是可替换的 JS 适配器，C++ 负责生命周期和资源边界；这没有完成架构中所有 C++ 探测／CUE／封面转换／写标签能力。选择先复用已锁定标签映射，避免在隔离改造时同时更换领域映射。将来适配器替换仍使用请求身份、只读观察、结果契约和外部监督。

监督组件校验绝对运行时路径与 Library Service 父进程映像一致、入口名称固定；不使用 shell。请求中的媒体路径不作为执行参数。只有 Main 构造组件路径，Renderer 没有执行或路径设置接口。子进程环境只传运行所需的 SystemRoot/WINDIR/TEMP/TMP/PATH 与 ELECTRON_RUN_AS_NODE，不传 NODE_OPTIONS、调试配置、Provider 秘密或任意 Electron override。worker 无数据库／Electron／Provider 导入，不直接提交领域数据。进程仍具有当前用户文件权限，没有实现低权限令牌、网络阻断或完整安全沙箱。

Electron 打包配置显式保留 `runAsNode` fuse；这是此运行时方案的前提，后续若改为由 Main 启动 utility process 或替换独立运行时，应重做契约与打包验证。[Electron 官方说明](https://www.electronjs.org/docs/latest/tutorial/fuses)记载此开关控制 ELECTRON_RUN_AS_NODE；utilityProcess 是 Main API，不能在 Library Service 内直接调用。

## Windows 监督

C++ 使用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建进程时原子关联 Job Object，再恢复暂停线程，避免创建后再分配任务对象的孤儿窗口。继承句柄限定为 child stdin、stdout、stderr，不继承 Job 句柄。JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 使监督组件退出时关闭最后句柄并结束工作进程；监督组件同时持有父进程同步句柄，父服务结束则终止任务。限制不允许另建子进程；创建或限制设置失败直接退出，不静默退回同进程解析。

已编码的初始预算：

| 项目 | 初始限制 | 语义 |
|---|---|---|
| V8 old heap | 128 MiB | 不等于整个进程内存 |
| 单进程提交内存 | 384 MiB | Windows commit 限额，不是工作集／RSS |
| Job 提交内存 | 512 MiB | Job 内全部进程提交量总和 |
| Job 活动进程 | 1 | TagAdapter 不需要启动其他程序 |
| Job 用户 CPU 时间 | 20 秒 | 内核时间不计入此项；到限额终止 Job |
| 监督墙钟 | 22 秒 | 恢复 worker 后计时，覆盖阻塞解析／文件读取 |
| Library 备用 watchdog | 25 秒 | 发送取消请求，继续等待退出确认，不自行假定停止 |
| 标签 tokenizer 读取 | 32 MiB／20 秒 | 沿用合作预算，作为 OS 监督之外的提前拒绝 |
| 输入／输出／诊断 | 64 KiB／2 MiB／16 KiB | 原生输入帧、标签结果帧和父端诊断计数 |

这些是已编译的策略，不是实测资源峰值或恶意媒体验收证据。提交内存上限使超过限额的提交失败，不承诺每种失败都自动生成可读的 OOM 回执。[Microsoft Job 限额文档](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)说明 commit／CPU／活动进程等语义；[原子关联说明](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812)指出暂停创建后再关联的崩溃窗口。

## 取消、退出与异常

父端保持请求 stdin 打开，发送一个长度前缀 JSON 帧。原生转发线程在完整请求后等待额外字节／EOF；父端取消、协议错误或备用 watchdog 关闭输入，原生即终止 Job。worker 自身的事件循环即使卡住，也不负责最终取消决定。

原生在取消／超时后等待真实 worker 进程句柄终止，再返回固定退出码。Library 等待监督进程 close 后才能释放解析槽和落检查点；信号取消仍通过既有 ScanCancelled 与任务取消回执处理。正常标签失败、子进程异常或资源不足作为单文件异常，旧标签／状态保留，新坏文件不入库。监督组件启动／设置失败终止本次扫描，不把整个根目录的文件批量当成坏标签。

监督组件未知退出／退出确认失败时，父端锁住解析器、ScanManager 停止后续调度，任务保持 running/cancelling 并记录原因，既有 root/generation 不完成缺失对账。不会把不确定状态称为取消已确认。新启动的服务仍按 v29 恢复流程把运行中任务转为中断／已取消，之后人工继续；进程跨重启与强制退出行为仍需 MVP 验证。备用 watchdog 不强杀监督组件并立即复用槽。

同步 I/O 取消和进程终止仍依赖 Windows／底层驱动。不能保证异常内核驱动下的退出耗时；为保护真实性，确认未返回时仍占用槽。目录枚举、父扫描器的文件 stat/open/CUE 读取尚未全部搬入 Media Worker，因此不能宣称扫描所有 I/O 都已有硬超时。[Microsoft I/O 取消说明](https://learn.microsoft.com/en-us/windows/desktop/FileIO/canceling-pending-i-o-operations)也明确驱动取消没有普遍保证。

## 路径与结果核对

协议为 4-byte little-endian 长度＋严格 UTF-8 JSON，一次任务只允许一个请求／结果；version、UUID、消息形状、字节预算和字段白名单分别校验。发行／署名集合受 128 项／字符串 16384 字符和消息总预算限制。数值、时长与来源枚举在入库前检查，不因子进程属于应用就跳过校验。

请求携带扫描绑定的根路径／真实根、文件相对路径与 size/mtime/ctime/dev/ino 观察。worker 检查 lexical 路径和 realpath、拒绝符号链接／非文件，用自己持有的只读句柄解析并在结束后复核句柄与当前路径。结果必须返回同一 UUID、相对路径、大小／时间与观察。错误回执区分 boundary 与 parse；授权目标越界／类型替换中断整个扫描并禁止完成缺失对账，不降级为普通坏标签。父扫描器仍保持自己的只读句柄，退出后再复核句柄、授权路径和当前文件属性；只有通过后才在已有单写入事务检查点应用标签。

两进程各自持有句柄，不是跨进程转移同一个句柄；这是属性与身份观察，不是内容哈希、排它租约或 GetFinalPathNameByHandle/全 reparse-point 安全证明。完整授权撤销、Windows File ID、挂载改写和 OS 文件租约继续保留在 WP04／WP09。

## 构建与验证

增加独立 `build:media-worker` 并接入 `build:native`，打包 resources 包含监督 exe，既有 dist 包含固定入口与协议。分发清单记录监督源码 SHA-256、媒体协议和预算；解包验证器核对监督二进制与入口模块。这个内部 Aural 组件按 GPLv3，不新增第三方运行依赖。打包验证器尚未实际执行，不据此声称已验证安装包。

本批类型检查、Main／Renderer／原生音频／凭据／媒体监督编译及发行／分发清单静态检查通过；未运行解析、扫描、取消、故障注入、内存／CPU 压测、SQL、桌面、音频或安装包。最新已验证安装包仍为 0.29.0。MVP 验证必须覆盖正常格式标签与 CUE 协调、畸形／超大标签、CPU 卡死／网络文件读阻塞、取消竞态与实际退出、父服务／监督强退、Job 关联失败、内存提交失败、错误／截断／多帧 UTF-8、路径替换、异常保护／新 pass 对账、打包 ASAR 路径与 fuse、真实库续跑及十万曲吞吐。单文件启动进程的性能必须测量；如不达标再改有界长驻池，不回退为无监督的同进程解析。
