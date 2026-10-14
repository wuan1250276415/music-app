# ADR-082：当前 PCM 会话的处理链与转换计划

日期：2026-10-02；源码 0.77.0；音频 IPC 1.17，schema v38／媒体协议 6 不变。

## 范围

承接 ADR-076–081，落实架构 §13／§14 的显式处理链。本批建立当前 WASAPI PCM 会话的实际配置报告与独立校验，展示解码来源、Opus／DSD 内部处理、应用增益目标、输出转换顺序、声道映射、缓冲、CUE 范围、时钟和尾部策略。它不是完整 MediaProbe／PlaybackPlanner：源有效位深、解码器内部格式转换、设备认证、播放前完整规划、跨文件 gapless、Native／DoP／ASIO 后端及跨平台仍继续实现。完整 FR01–FR14／WP01–WP11／G1–G5／AC01–AC19 保留；ASIO 实机验证搁置。

封面仍按内嵌正面、其他内嵌、旁置文件的顺序读取；播放栏封面进入详情，资料点击检索、滚动歌词、模式和队列保持。处理链作为详情的附加信息，技术参数默认折叠。

## 实际配置与原始模式

新增 Native `pipeline-plan.hpp`，从已初始化的 miniaudio 设备 converter 读取输入／输出格式、采样率、声道、实际 executionPath、pre／post format 节点、抖动模式、线性 resampler 标识和报告延迟。声道转换复制实际 map、shuffle 或 weights；shuffle 的 255 表示静音，不能假定是等长双射。混音矩阵行是输入、列是输出；f32 保存浮点系数，s16 保存原始 int32 定点系数并明确表示，不误当浮点系数。

依据仓库固定 miniaudio 初始化和 process 实现核对顺序：pre-format → channel／SRC（扩声道时先 SRC，其余按实际 executionPath）→ post-format；channels-only／resample-only 也可含格式转换。当前禁用动态采样率，所以 SRC 与实际率差一致；声明其他 resampler、非法格式／映射／系数失败，不猜测算法。latency 是转换器报告，尚未证明滤波误差界、真实延迟或音质。

此前 adapterConversion 只比较格式／采样率／声道数，会遗漏数量相同的声道重排；现在使用 converter.isPassthrough。原始格式独占在开始播放前拒绝任何非直通 converter，整数路径候选也要求直通；不能在“原始”模式暗中重排／混音。整数候选仍不表示位深或设备逐位一致已认证。

miniaudio 内置解码器通过实际受控 backend vtable 区分 wav／flac／mp3，FFmpeg 路径沿用实际 codec identity，不以扩展名或扫描标签推断。FLAC／ALAC 显示无损编码，MP3／AAC／Vorbis／Opus 显示有损；WAV 可包含压缩编码，本轮标记未知，不将容器名当作 PCM 证明。DSD 转 PCM 明确显示处理。整曲波形仍是独立解码副本，算法未改变，旧缓存不会自动重算。

## 契约、回执与隔离

新增能力 `pcm-pipeline-plan-v1`。AudioConverterPlan v1 为 24 字段；AudioPipelinePlan v1 为 17 字段，包含固定 source／output／conversion／buffers 和动态 gain／span，以及阶段、编码质量、样本状态、时钟／尾部策略与未验证项。hardwareVerified／bitPerfectVerified 固定 false。decodedSource 的可选信息在真实宿主报告为 null，canonicalOutput 保留 14 个规范字段。

原生控制线程在既有 Channel 写锁下生成与当前增益／CUE 段一致的报告；callback 不构造 JSON、不加锁、不分配。报告在初始 playing／paused、resume／pause、seek、snapshot、CUE boundary 与 volumeChanged 携带。volumeChanged 从七字段升级为八字段。本批报告仍在设备 start 后发送，不能声称已实现完整的播放前计划审批；原始模式的转换拒绝仍在 start 前。

Main 根据实际解码来源、规范输出与独立重算的 ProcessingPlan 再构建完整计划，并校验严格结构、顺序、格式、算法、声道参数、32 MiB／两秒有界预读公式和设备缓冲范围。源范围从当次命令重算：CUE 按整数 frame × rate / 75，普通范围按秒向下取 PCM 帧，相邻 CUE 覆盖两段并确认边界／当前段。合法整数／uint64 范围溢出、无效边界或回执不一致停止会话。

会话 source／output／conversion／buffers 在后续回执保持不变；gain 和段状态可按已授权命令更新。时钟事件的 SRC 标志、输入／输出报告延迟、latencyEvidence 与已接收计划交叉核对，初次接收计划也核对已有时钟。既有尾部预算继续与时钟转换参数核对。上述是报告之间的一致性约束，不是独立测量硬件真实性。

成功回执只在计划校验后释放对应等待项。快照和 seek 的定时器／等待项也在校验成功后才移除；失败时统一 fail 路径仍能拒绝全部等待项，避免失去结果或误报成功。迟到快照继续忽略，stop 优先、代次隔离与不自动恢复的行为保持。

## 展示与验证

播放详情展示按顺序排列的处理链、编码质量／样本处理状态、解码与设备 PCM 参数、共享／独占、端点、转换与抖动；折叠区显示源范围、CUE 段、预读／设备缓冲、报告延迟／尾部预算和声道映射／矩阵。增益仍是控制目标，时钟和尾部仍单独呈现。无损文件、应用整数直通候选、设备逐位一致分别说明，不显示未经认证的 bit-perfect 标志。

本批仅做 Main／Renderer 类型与编译、原生编译、发行／分发清单、40 个维护脚本语法检查与源码归档 CRC。未执行音乐、设备、UI、SQL／迁移、网络、安装、单元或端到端测试，按用户要求集中到 MVP；最新已验证安装包仍 0.29.0。

MVP 验收应覆盖各格式与解码 backend、源范围／未知末端／CUE 两段、原始格式下同数量声道重排拒绝、扩声道／缩声道与 SRC 两种顺序、格式转换／抖动／mix matrix、参数回执故障与固定参数漂移、volume／snapshot／seek／CUE／tail／stop 交错、超限与宿主退出、实际缓冲／时钟／延迟／音质、详情与小窗口可访问性。完整 PlaybackPlanner、源位深／decoder transform、滤波误差／true peak limiter／dither、gapless 和其余架构工作继续。
