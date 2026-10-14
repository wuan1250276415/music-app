# ADR-083：PCM 播放前计划核对与解码源证据

日期：2026-10-02；源码 0.78.0；音频 IPC 1.18；schema v38／媒体协议 6 不变。

## 问题与范围

ADR-082 的当前会话计划在设备 start 后发送，Main 发现来源／增益／转换冲突时可能已经提交样本。本批将 WASAPI PCM 的计划构造和 Main 核对放到启动前，承接架构 §13.1、§13.3 和 §14.1。新增解码器实际文件头／上下文证据，原始模式同时约束解码器格式变化和设备 converter。

静态核对还发现历史 Native formatName 为 float32，Main 的处理／来源／输出契约为 f32，转换报告同样使用 f32；这种不一致会使真实浮点播放被拒绝。本批统一 u8／s16／s24／s32／f32 的规范标识，不将界面字符串用作协议。现有直接宿主验收脚本相应改为 f32，并适配 prepared/start；仅语法核对，未执行。

这是当前 PCM 路径的启动前核对，不是完整 MediaProbe／MediaCapabilityManifest／PlaybackPlanner 交付。尚无统一授权定位符、全部格式与损坏诊断、设备驱动／固件身份缓存、完整解码延迟／不连续证据、数字捕获认证、完整 gapless、Native／DoP／ASIO 后端或跨平台实现。完整 FR01–FR14／WP01–WP11／G1–G5／AC01–AC19 保留；ASIO 实机验证继续搁置。

## 启动顺序

Native 完成文件解码器、范围／初始定位、端点选择、设备 init、原始格式约束、ring 大小和转换器配置，初始化呈现书签；此时尚未启动分析线程、producer 或 ma_device_start。打开并初始化设备可能占用端点，但不提交应用播放样本；未宣称打开设备无任何驱动副作用。

新增能力 pcm-preflight-v1／decoder-source-v1，当前计划为 pcm-pipeline-plan-v2。Native 发 playback.prepared，十三字段包含 token、初始暂停意图、preparing 状态、初始相对位置／时钟、请求／实际输出、解码来源、增益与管线计划、源起止及 CUE 边界。token 由会话 ID、握手 nonce 和固定本会话计划阶段组成；只标识已认证会话的一次计划，不是硬件认证或内容哈希。

Main 保持 preparing，独立校验规范格式、实际 source 九字段及 source evidence、保存的处理偏好／标签、实际 converter、源／CUE 范围、缓冲公式、时钟／报告延迟、微秒恢复位置与初始暂停意图。通过后才发送 playback.start（params 仅 planToken），展示 validated；playing／paused 回执再校验同一固定 source／output／conversion／buffers 与初始意图后显示 ready，才兑现 play 的 started 等待。后续增益／CUE 段仍按已有命令和固定参数约束更新。

Native 仅在相同会话、generation 1、合法 command/request ID、正确 start 方法和唯一匹配 token 后启动。prepared 的结果不会自动降级、恢复播放或改变暂停意图。收到合法 stop 则确认并释放尚未启动的设备。无效或缺失 start 结束准备，资源释放；绝对十秒期限覆盖整个输入帧，部分头部／正文不会无限延长等待。新增期限只作用于准备阶段读取，现有运行控制线程行为不变；父退出守护和 Main 退出确认继续存在。

start 命令超时直接失败并停止会话，不用 snapshot 推测启动成功；准备阶段丢 play 回执也不做启动状态对账。Main 的原有二十秒音源／输出准备期限、五秒命令期限、fail 全等待项拒绝、stop 优先和旧宿主退出确认保留。预读和设备 start 的后续错误仍走失败路径。计时与进程取消必须在 MVP 真实运行验收，编译不证明驱动一定按期退出。

## 解码源证据

DecoderSourceEvidence v1 六字段：version、encoding、validBits、containerBits、evidence、decoderConversion。证据来自本次实际 decoder backend，不用扩展名、扫描位深或首个路径探针作为最终证明。

- 固定 miniaudio WAV backend 的 dr_wav 结构提供 translatedFormatTag、bitsPerSample、fmt.formatTag／validBitsPerSample。PCM／IEEE float 与压缩 WAV 分开；普通 PCM 的有效位取文件头位数，extensible 未声明有效位时保留 null，非法位数回到 unknown，不猜测。容器位深独立保存。
- 固定 miniaudio FLAC backend 的实际 dr_flac STREAMINFO bitsPerSample 提供整数有效位，未填造 PCM 容器位数。实际 MP3 backend 标明有损，位深保留 null。
- FFmpeg ALAC 使用已打开 codec context 的 bits_per_raw_sample，只记录有效范围，不以输出 s32 冒充源 32 位；AAC／Vorbis／Opus 标有损、DSD 标 dsd，源 PCM 位深不适用，保留 null。此证据是 decoder 报告，仍需数值／文件金样核对。

Main 对六字段、范围、证据来源、实际 codec 与输出样本格式交叉检查。WAV 只有头部表明 PCM／float 时才显示无损编码；压缩 WAV 显示有损，unknown 继续明确展示。编码质量不表示解码数值、输出或硬件逐位一致。

decoderConversion 分别记录 integer-to-float、integer-output、float-output、lossy-decode、dsd-to-pcm 和 unknown。样本状态现在也反映已知解码格式变化，不再仅用设备 converter 判定。整数到 float32、浮点降为 float32 和整数容器容量不足分别列出证据／警告；浮点转换不能直接视作源整数逐位保持。

原始模式在 Main 接收计划时拒绝 integer-to-float、已知浮点精度降低和整数容量降低。applicationIntegerPath 必须有当前整数源有效位，且不超过 s16／s32 容器容量；这同时避免路径探针与实际打开文件不同而错误保留整数候选。原先支持的 16-bit WAV／16、24-bit FLAC 和条件 ALAC 路径保留；其他位深／布局需继续完善实际整数协商，不暗中用浮点满足原始模式。

当前 source evidence 不读取源真实峰值、所有声道布局／时间基、位序或每包变化，也没有完整 decoder 转换数值认证。decoder-format-transform-unverified／hardwareVerified=false／bitPerfectVerified=false 保留。整曲波形仍是独立 f32 副本，未改变算法或自动重算旧缓存。

## 界面、分发与验收

详情增加配置已核对／准备启动与播放前核对通过状态，以及有效位／容器位和证据来源。共享引擎、输出重采样、抖动和硬件边界保持可见。内嵌封面优先、点击封面进入详情、资料检索、滚动歌词、模式与队列保持。

当前 AudioPipelinePlan v2 为十七字段，AudioConverterPlan v1 仍为二十四字段；source 新增 media，后续固定参数核对包含该证据。schema v38 和历史持久回执不变，发行／分发清单增加 Main／Native 启动流程与解码源校验来源摘要。最新已验证安装包仍 0.29.0，没有新安装包。

本批只做类型、Main／界面（75 模块）／原生编译、发行／分发清单、40 个维护脚本语法和源码归档 CRC。未执行单元、音频、进程运行、UI、SQL／迁移、网络、硬件或安装测试；按用户要求集中到 MVP。现有直接宿主硬件脚本的自动 start 只是协议适配，不代替 Main 的独立计划故障验收。

MVP 覆盖准备前 stop、正确／错误／缺失 token、过期代次／重复 start、部分帧期限／管道断开／父退出、start 超时不对账、initialPaused／恢复微秒／CUE 两段范围、准备时输出通知、编译时无法证明的首个 callback 顺序、端点资源释放、不同 WAV 编码／extensible 有效位、FLAC／ALAC 位深、原始模式下解码变化和容量不匹配、Plan v2 source／转换／时钟冲突、详情与历史脚本适配。其他架构功能与门禁继续。
