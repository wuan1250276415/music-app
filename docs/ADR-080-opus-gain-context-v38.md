# ADR-080：Opus 头部与响度标签的实际处理上下文

日期：2026-10-02；源码 0.75.0；schema v38、音频 IPC 1.15、媒体协议 6。

## 要求与来源

承接架构 §13.1、§14.1 和 ADR-079 的 PCM 增益节点，补 Opus 的参考电平与头部增益。完整 PlaybackPlanner、平滑实时音量、Native／DoP、跨文件 gapless 与所有 FR/WP/AC 保持原范围，尚未完成。ASIO 实机验证继续搁置。

依据 [RFC 7845 §5.1/§5.2.1](https://datatracker.ietf.org/doc/html/rfc7845#section-5.2.1)：OpusHead output gain 和 R128_TRACK_GAIN／R128_ALBUM_GAIN 均为有符号 Q7.8 dB；R128 相对于头部增益后的信号，标签参考 −23 LUFS。R128 必须另加在已应用的头部增益上；每种最多一个、值为最多六个 ASCII 字符的整数且不允许空白。传统 ReplayGain 的测量基准含糊，RFC 不建议与 R128 混用。

本项目固定的官方 FFmpeg 8.1.3 源码 commit `1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7`：`libavcodec/opus/parse.c` 读取 output gain，`parse.h` 存为 int16；`libavcodec/opus/dec.c` 初始化幅度倍率，并在原生 decoder `opus` 输出 float 时应用。该编译组件没有额外 apply_gain 开关。此次只接受该原生解码器，不能把头部增益再乘一次。FFmpeg 原始发行／DLL 锁定和随包许可证保留，未改 vendor 源码。

## 同句柄标签和流绑定

FFmpeg Ogg 注释转换会将重复值合并成分号串，且 C 字符串不能证明原始字节长度。因此新增 `opus-gain.hpp` 在解码器已经打开的同一只读 HANDLE 读取 Ogg 原始前缀；不另开路径，也不信任 AVDictionary 的 R128 文本。暂存并恢复实际文件偏移，避免干扰 AVIO 内部缓冲。播放句柄只允许其他读取；分析沿用其已经授权／摘要绑定的句柄。

读取预算：前缀 32 MiB、4096 页、16 条逻辑流、单个标签包 16 MiB、最多 65536 个注释；遵守既有 20 秒合作期限／取消标记，不能宣称 Windows 阻塞 I/O 可强取消。每页验证 Ogg capture／版本／flags／CRC、BOS／sequence／continuation／EOS 状态。按与固定 Ogg demuxer 相同的 BOS 发现顺序选择逻辑流，重组第一／第二包，要求完整 OpusHead 与实际 codecpar extradata 逐字节一致，然后解析 OpusTags。损坏结构、超预算或恢复偏移失败停止打开；合法但非法的增益字段排除并保留状态。

R128 key 大小写不敏感，原始值严格校验 −32768..32767；重复、空白、额外字符、嵌入 NUL、越界均为 invalid，不选用。传统四个 gain／peak key 原始解析有限十进制，可有空白及 gain 的 dB 后缀；不接受指数／十六进制／重复／分号／NUL，范围沿用 gain ±60 dB、peak (0,64]。每类独立处理，不让一个坏字段覆盖其他有效值。

每个不同音频包起始页通过固定 demuxer 的 AVPacket.pos 再读取同句柄页面，校验 CRC 和原逻辑流 serial；同时核对 codecpar OpusHead，并拒绝新的 extradata、参数／元数据 side data 和运行时元数据更新。即使串接下一段的头部／标签相同，新的 serial 也不能沿用初始增益。普通 seek 清空页面验证缓存，继续绑定原 serial。真正支持串接、不同页包容错或原生格式变更属于后续，不把错误回退当作已支持。解析器不是完整 Ogg 验证器，也不是整个文件的内容认证。

## 选择与计算

输出设置增加 `opusPolicy` 和 `opusTargetLUFS`。默认 `r128`、−23 LUFS，默认 ReplayGain 仍关闭。只保存／切换设置后重开设备，保留位置／暂停；尚非实时音量。

| 策略 | 追加增益 | 峰值含义 |
|---|---|---|
| r128 | 所选 Q7.8 / 256 ＋ target − (−23) | 不使用含糊的传统峰值，缺少峰值按解码后满幅 |
| header-only | 不追加响度标签 | 解码器照常应用头部增益 |
| legacy-before-header | 传统 gain − header dB | 传统 peak × 10^(header dB/20)，转换为解码后基准 |
| legacy-after-header | 传统 gain | peak 已是解码后测量 |

只有选到有效曲目／专辑标签才加预增益和 R128 目标补偿。R128 可选 −18 LUFS，明确额外 +5 dB；它是播放目标，不证明实际测得响度。专辑值缺失／非法时回退有效曲目并返回原因；二者不可用时只保留头部／数字音量，不自动改用传统标签。用户选择传统策略表示已明确测量基准，程序不会猜测。传统模式和默认模式从本次 native 同句柄原始标签读取；Opus CUE 不套用整张扫描 TRACK 或 REM 值，仍使用该 Opus 逻辑流的标签，完整 CUE 响度分析继续开发。

additional requested = volume + selected normalization + selected-only preamp；effective 仍按 ADR-079 的 peak／满幅上限调整；合计为 header + additional。最终静音倍率为零，详情的合计标注为静音前 dB。Producer f32 处理及累计计数、启用处理时原始 exclusive 拒绝、callback 无新增 DSP 均保留。

头部增益无论 ReplayGain 开关都会由 decoder 应用。仅改变 Opus 策略不会启用应用 DSP；处理关闭时不会新增硬限幅，头部后的超满幅由后续格式转换／设备处理。启用处理后缺少峰值只按解码后满幅调整，仍可能硬限幅；标签／采样峰值不是 true peak、SRC 后峰值或音质保证。未实现 limiter／抖动。

## 回执与兼容

IPC 1.15 要求 `gain-processing-v2` 和 `opus-gain-v1`；ProcessingPlan v2 增加实际 codecGain、gainBasis、头部／normalization／目标补偿／总请求及有效增益共 23 字段。OpusGainInfo 17 字段记录原始 Q7.8、有效／缺失／非法状态、传统标签、decoder／headerApplied、参考 LUFS、读取验证策略和流／页／标签大小。所有 hardwareVerified=false。

Main 根据实际 decodedSource 验证 Opus 来源、48 kHz f32／固定 FFmpeg，保存会话上下文，独立重算处理计划并逐字段核对；后续 source／快照／暂停／seek／CUE 身份切换不得改变上下文。扫描 ReplayGain 属性核对仍保守保留，但 Opus 实际选择只来自原生本次观察，不把扫描值当作实际头部来源。播放详情显示头部已处理、追加／总增益、R128 有效状态和忽略传统标签；输出设置提供策略与目标响度。

schema v38 只做备份／兼容版本 fence，无新增数据列、不改不可变历史回执。历史五字段 processing 在读取时补默认策略／目标；七字段严格校验，缺一／显式 null／未知值拒绝。v37 及更早应用拒绝新版库，避免旧 validator 损坏新设置。v37 列迁移加 guard；波形分析也带实际 Opus 上下文，并在两次 decode 打开时核对；数值解码本身未变，不宣称波形已经应用用户的响度处理。

## 验证与剩余工作

本批次只做类型／Main／Renderer／Native 编译、发行／分发清单、维护脚本语法与源码归档 CRC 静态核对。真实音乐文件、解析／数值、SQL／迁移、seek／串接／故障／交错、设备／音质／界面验证集中到 MVP；没有新安装包，最新已验证开发安装包仍 0.29.0。编译不是格式／音质认证。

MVP 需要真实／构造 Ogg 文件覆盖：正负极限头部和 R128、默认目标及 +5 dB、无标签／缺值／重复／空白／非法字节、分包／多页／多流／超预算／损坏 CRC、相同头部的不同 serial 串接、seek 与取消、传统测量基准与 peak 换算、防削波／静音／累计计数、回执篡改／旧回执／CAS／未知结果、schema 0–38 备份迁移、分析再打开及界面。当前实现仍不是完整 ReplayGain 全格式认证、MediaSource 授权与内容绑定、完整 PlaybackPlan／gapless 或 G1–G5、AC01–AC19 完成。
