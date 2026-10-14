# ADR-012：Windows 音频宿主 IPC v1

状态：0.14 原型已实施，WP01 的本机 IPC、超时对账与故障恢复冒烟通过；完整 WP01 与 G1–G5 尚未验收。

## 决策与实现

Main 与 C++ Audio Host 使用本机 Windows 命名管道，传输为 4 字节 little-endian 长度加 UTF-8 JSON，单帧上限 1 MiB。管道拒绝远程客户端、仅允许当前用户和 SYSTEM 访问，并要求第一个管道实例；每次启动使用随机管道名、session ID 和握手 nonce。主进程验证协议 major、会话和 nonce，Host 验证握手与后续命令的 session ID。

命令使用架构文档第 18.2 节的 `protocol`、`kind`、`requestId`、`commandId`、`sessionId`、`method`、`expectedGeneration`、`timeoutMs` 和 `params`。回执只代表接受或拒绝，播放状态由单调递增的字符串 `sequence`、Host generation、`causedBy` 及 payload 事件决定。当前支持 `playback.play`、`pause`、`resume`、`stop`、`snapshot`、1.2 新增的 `seek` 和 1.5 新增的 `cancelNext`；seek 完成事件见 [ADR-015](ADR-015-runtime-seek.md)。同一会话内最多记录 1024 个命令 ID 的原始接受/拒绝结果、错误和 generation；重复 ID 返回原始回执，不再次执行命令。Host 拥有 generation；Main 丢弃旧会话，拒绝回退的 sequence/generation，协议异常、播放错误或断线时进入错误状态并终止宿主。

Host 对命名管道使用 overlapped I/O，避免同步写入与 Node 读取相互等待。Host 初始化与解码仍在独立进程。切歌前 Main 等待旧进程退出，使独占设备先释放；若无法确认旧进程退出，就拒绝启动新宿主并报告错误。停止命令抢占待处理的暂停/继续命令。命令回执超时后 Main 请求 snapshot，同时要求快照回执和 `causedBy` 对应的快照事件；缺失事件、状态不符或迟到拒绝均终止该会话，迟到快照不覆盖较新状态。主进程退出时要求 Host 释放设备，仍保留终止超时兜底。`playing` 和 `snapshot` 事件分别包含 requestedOutput 与 actualOutput，后者明确标注 `hardwareVerified: false`，不作为位完美或硬件模式认证。

协议 1.3 的 `playback.play` 增加 `allowConversion`。独占原始格式档位传 `false`，独占允许转换及共享档位传 `true`；Host 握手报告 `output-conversion-policy` 能力。Host 在原始格式不被设备接受时发送明确错误事件，不隐式启动 float32 回退。

协议 1.4 的原生原型允许 `playback.play` 附带同文件相邻段的 `nextCueStartFrame` 和 `nextCueEndFrame`，并新增 `playback.cueBoundary` 事件。协议 1.5 增加 `playback.cancelNext`、边界事件的总时间线位置和双段 seek 所属段报告；Main 在符合条件的桌面队列中预排、撤销和对账相邻 CUE 两轨。约束与验证见 [ADR-017](ADR-017-cue-continuous-prototype.md)。

协议 1.6 增加 `buffer-telemetry` 能力和 `playback.position` 事件中的回调/缓冲补零累积计数。Main 验证计数格式、范围与单调性后暴露诊断；计数不代表硬件输出认证。详见 [ADR-018](ADR-018-buffer-telemetry.md)。

## 与最终架构的差距

协议 1.7 的分析旁路实现及待 MVP 验证边界见 [ADR-048](ADR-048-live-audio-analysis-v17.md)：新增 analysis-tap-v1、analysis.configure 和 playback.analysis 压缩摘要；可选分析失败不停止正常播放，封包／会话／序号错误仍拒绝。

- 桌面播放一般仍是一曲一宿主进程；同文件相邻 CUE 两轨可共用宿主。尚无长驻宿主、断线重连、状态事件重放或完整无缝切歌。Host 断线时停止而不是自动恢复发声。
- `play` 参数仍含媒体路径；CUE 现在传整数 75 fps 帧，普通文件仍用秒边界。后续由 Library Resolver 生成受控媒体引用和更完整的整数样本/有理时间模型。运行时 seek 已有基本代次与完成事件；设备能力查询尚未实现，当前只报告 WASAPI 适配器内部协商值，未做数字输出测量。详见 [ADR-014](ADR-014-cue-frame-bounds.md)和[ADR-015](ADR-015-runtime-seek.md)。
- 命令缓存只覆盖当前进程会话，`timeoutMs` 尚未由 Host 独立执行；跨进程重启不保证幂等。需要在引入可重连长驻宿主前补齐。缓存满后新命令被拒绝，当前不做淘汰以免旧 ID 被再次执行。
- 当前 Host 仍是 miniaudio PCM 原型，0.10.0 增加有条件的应用内整数路径，0.11.0 增加拒绝隐式转换的原始格式档位，见 [ADR-016](ADR-016-pcm-output-plan.md)。G1 的数字输出捕获、无旧样本端到端验证和 G2–G5 的 ASIO/DSD/授权/分发证据均未完成。

## 验证

2026-09-28：TypeScript 类型检查、10 项单元测试、2 项原生 IPC 冒烟和 VS 2017 x64 原生编译通过。Electron 桌面回归验证 CUE 曲目、共享/独占输出、暂停/继续、独占模式连续切歌、队列恢复；短 WAV 回归验证自动前进、单曲循环和末尾停止。帧单元测试验证分片、粘连、无效长度、无效 UTF-8 与截断；原生冒烟验证握手成功、协议 major 不兼容及过长帧拒绝。硬件验证范围仅限当前 Windows 测试机，不代表 ASIO、DSD 或位完美验收。

2026-09-29：`npm run test:audio-hardware` 的两项本机 WASAPI 测试验证重复被接受/被拒绝命令均返回原始回执，重复 ID 不触发另一种动作；播放时终止宿主后状态转为错误，重试可启动新宿主。另有 Electron 故障注入和安装目录 shared/exclusive 回归通过；跨设备、跨版本和长期运行仍待验证。

0.7.0 追加命令超时对账的确定性测试：回执丢失后等待关联快照事件，快照事件先到也能完成，缺失快照事件与迟到拒绝会进入错误状态，过期快照不能覆盖新状态。跨版本安装验证单独记录在实施状态中。
