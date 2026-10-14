# ADR-081：播放栏实时音量与回调增益过渡

日期：2026-10-02；源码 0.76.0；音频 IPC 1.16，schema v38／媒体协议 6 不变。

## 要求与改变

落实架构 §13.1／§14.1 的 PCM 数字音量和明确处理节点，承接 ADR-079／080。此前音量是静态会话设置，修改需停设备、保存并重开；在 producer 对预读 PCM 加增益也不能让已缓存的帧及时响应。本次新增播放栏音量／静音，持久化后向当前 f32 PCM 会话提交目标，保持设备、歌曲与暂停状态。ReplayGain／设备／格式／防削波等其他设置继续使用明确的重新规划和设备切换。

原始格式独占禁用实时软件音量，禁止暗中打开 DSP／转换；Native／DoP 暂未接入，未来继续独立限制。DSD 转 PCM 后的 f32 路径可以调整。ASIO 实机验证搁置，完整 FR01–FR14／WP01–WP11／G1–G5／AC01–AC19 范围不缩减。

## 音频节点

Decoder producer 只向 SPSC ring 发布解码 PCM，不再应用增益。实际 callback 消费的源帧在复制后、分析 tap 前执行有界 f32 增益；设备转换／SRC 仍在既有独立 pump。原始整数回调不调用该节点。补零的欠载或末包 padding 不推动音量包络。

新增 `live-gain.hpp`，在控制线程从两个 CUE 段的处理计划预计算 normalization／selected-only preamp、peak ceiling、保护与启用标志。Base 数据播放中不可变，callback 不读取 JSON／控制线程可变 Plan。完整 volumeDb double 的非负 attenuation 位型和 mute 放在一个 uint64 atomic：正 magnitude 的空闲 sign bit 表示 mute；64 位 lock-free 在编译时要求成立，不需要多字段锁或 callback 自旋。控制线程一次 release store，callback 每块一次 acquire load。

每次目标或 CUE 段变化，将当前幅度线性过渡到新的目标，长度 ceil(sampleRate/50)，即 20 毫秒向上取整的源帧数。重复相同目标不重启包络；新目标从当前幅度续接，不跳回旧起点。回调只做两个目标计算、按帧包络／按声道乘法、已有非有限值置零／可选硬限幅、一次累计计数更新；没有新增分配、锁、文件／网络／IPC 或日志。实际实时成本和音质留到 MVP，编译不能证明无欠载。

源帧位置在块内确定相邻 CUE 的段，避免将整块都套用前后任一段。段增益切换也使用该 20ms 包络；这是有限过渡策略，不是跨文件 crossfade／gapless 完成。初始化直接从保存目标开始，seek／丢弃式 pause 在设备 Stop／Reset 后重建包络到当前目标；暂停时接受目标，恢复回调再执行。新增 volume 不自动恢复播放、切歌、改模式或改默认设备。

启用处理时 sample clipping 在应用增益后执行。ReplayGain／Opus 的目标计算和原始标签来源不变；有必要时包络中间的帧仍可硬限幅。未提供 true-peak limiter、抖动或 SRC 后峰值保证。分析 tap 仍取增益后的 callback PCM，整曲波形仍是独立解码副本，没有套用用户音量。

累计 clippedSamples／invalidSamples 现在只计实际 callback 处理的源样本；不再包含未消费的解码预读，但可包含提交前被丢弃或 seek 后重播的样本，不代表 DAC 已呈现。Main 保持结构、uint64 范围和单调检查。

## 持久化、串行与停止

新增 `configureAudioVolume(AudioOutputRequest)`，请求仍包含完整设备／模式／DSD／七字段 processing 快照以及原 commandId／baseRevision，复用不可变持久回执。Main 只允许修改当前快照的 volumeDb／muted；其他字段不同或修订过期拒绝，不能通过实时入口修改处理策略。播放栏在 100ms 合并拖动值，最多一个请求在途，后续保留最后目标；没有永久高频事件监听或页面卸载后的提交。

Volume 与队列／设备切换使用相同 coordinator 串行链，不释放或重开当前设备。保存 CAS 和回执核对完成后才提交 Native；失去保存结果时设 unknown、阻止新播放并确认释放现宿主。未知结果只能核对同一完整请求，不猜测或自动重试其他目标。已保存但本会话应用失败保留持久配置，返回 saved 加具体错误，不将它描述成当前已应用。

stop 仍直接取消 operation，不排在持久化后。提交保存期间的 stop 不被后续音量保存撤销：配置只保留给以后播放，旧会话目标不发送，也不会自动起播。没有活动会话、已进入尾部或已经结束时只更新后续配置。宿主／事件目标回执超时或无效时失败并停止该会话，避免宣称目标已应用；正常结束与显式下一首仍走已有队列链。

## IPC 与回执

IPC 1.16 新增 `live-volume-v1`，处理能力为 `gain-processing-v3`。ProcessingPlan v3 共 25 字段，新增 application=callback-linear-envelope、rampMs=20；其 dB／scale 表示接收的目标，不是当前包络值或 DAC 已播放值。Main 独立重算并逐字段核对。

Native `volume.configure` 三字段 baseRevision（十进制字符串）、volumeDb、muted，检查 generation、会话音量修订、f32／允许转换／非整数路径和 seek／rebuild／tail 状态；有限回执窗口／commandId 去重沿用。控制线程在 Channel 写锁内同时更新两段目标 Plan、发布 atomic 值并发出 volumeChanged，避免快照／CUE／暂停／恢复计划先后乱序。恢复事件也在同一锁内取 Plan 并发布；callback 不取得此锁。

volumeChanged 带七字段 revision／volumeDb／muted／application=callback-target／rampMs=20／hardwareVerified=false／processingPlan。Main 按待处理命令核对，更新会话设置与 revision，再发布 PlaybackState.volumeControl。回执只证明控制目标接受；缓冲、转换和设备可延迟呈现。暂停时或尾部结束前没有消费新的源帧，不能把目标回执当作实际出声证明。事件／命令等待在 fail／stop 时完整撤销，不泄漏定时器。

## 界面与版本

播放栏提供 −60..0 dB 滑杆和独立静音，保留关闭前的音量；忙碌期间可继续合并目标，原始模式、未知保存时禁用提交。显示保存／回执问题，自己的 unknown 请求提供核对入口；其他设置 unknown 引导在输出设置核对。读取失败可重读。小窗口保留该入口，键盘沿用原生 range 可访问性。输出对话框仍有完整设置，播放详情说明包络和目标／已呈现区别。内嵌封面优先、封面进入详情、资料检索、滚动歌词、播放模式和队列保留。

没有数据格式变更，schema v38 与历史不可变回执兼容规则不变。版本更新 release／SBOM／源摘要，增加 callback envelope 和 UI 来源；最新已验证安装包仍为 0.29.0，未生成新安装包。

## 验证边界与后续

本轮只做 Main／Renderer 类型与编译、Native 编译、发行／分发清单和维护脚本语法静态核对、源码归档 CRC。未执行音频、UI、SQL／迁移、单元／端到端、网络、硬件或安装测试，按用户要求集中到 MVP。

MVP 覆盖 unity／衰减／正 normalization／静音往返、逐帧线性包络／新目标接续／重复目标、无声 padding 与 CUE 块内切段、pause／resume／seek／tail／stop 交错、已缓存帧／SRC／分析位置、非有限／限幅计数、callback 压力和音质／点击声、原始格式隔离、revision／迟到或丢回执／保存 unknown／重启配置、多窗口冲突／拖动合并／小窗口键盘操作、DSD PCM 后节点。最终 PlaybackPlanner、完整 SRC／滤波误差与提交映射、设备音频认证、抖动／limiter、跨文件 gapless、其余数据／媒体／Provider／歌词／发布功能继续开发。
