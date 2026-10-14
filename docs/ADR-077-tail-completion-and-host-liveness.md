# ADR-077：尾部完成回执、取消和播放宿主活性

日期：2026-10-02。源码版本 0.72.0；schema 36、媒体协议 5 不变，音频 IPC 1.13。状态：源码实现、类型／编译／静态核对；尾部／设备／音质与故障恢复运行验收待 MVP。关联 FR07/FR08/FR10/FR11/FR13、WP02/WP06/WP07/WP10。完整输出计划／gapless／误差界与硬件门禁尚未通过。

## 从输入结束到输出完成

0.71 的 finished 只表示 callback 消费完有效源数据，转换器可能仍持有输入或历史，最后音频包也可能尚未完整提交。旧控制循环在时钟无法映射时可直接发 ended，然后才停止设备。本批移除这个提前正常结束路径，增加 playback-tail.hpp 的独立尾部状态机：feeding → flushing → draining → completed，另有 cancelled／failed 内部状态。

输入 callback 在已有 PCM／补零时间线发布后，用实际请求数、有效数与消费完标志记录一次 inputEndFrame 和 sourceFrame。inputEndFrame 是本次 Start／Reset 周期的输入请求流位置，包含前面的补零；sourceFrame 是既有可播放 span 内的 PCM 源帧，含恢复偏移。它们与文件绝对帧、实际输出帧分开。

没有 resampler 时只消费到最后有效输入帧，截掉该 callback 未使用的 EOF 补零。固定 linear SRC 则消费到有效末尾 + converter 报告 input latency + ceil(sourceRate/10)，即明确的 100 ms 额外零输入预算；还尝试零输入输出已有缓存，直到不再产出才提交最后包。缓存容量、零输入行为、无输出循环预算及停止检查沿用 0.71。

这个有限预算是当前明确的尾部策略，不是 IIR 滤波响应已收敛到某个阈值的证明，也不宣称 DSD 转 PCM／解码器 delay/padding／系统引擎及模拟尾部已覆盖。需要通过脉冲／金样和实际负载建立后续输出计划中的尾部阈值及误差界。既有 WAV／FLAC 原始整数路径没有新增 SRC 尾部。

## 最后音频包和完成依据

最后部分包仍按 WASAPI 整包契约补全静音、ReleaseBuffer，检查 S_OK 并记录成功提交。新增独立 packet padding 计数；clock 的 conversion.outputPaddingFrames 与实际 converter.outputProduced 分开，不把补包帧当作转换器产生的帧。总 committed 必须等于 targetOutputFrames + packetPaddingFrames，Main 同样检查这个关系。

停止产生新音频后，在 worker 上等待尾部依据：

- 共享输出用 [GetCurrentPadding](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-getcurrentpadding) S_OK 且 padding=0，记录 shared-padding。它只证明报告的端点缓冲没有尚未读出的数据，不是 DAC／模拟声音结束认证。
- 独占输出优先用 worker 自己持有的 [IAudioClock GetPosition](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclock-getposition) 精确 S_OK、有效频率和换算位置到达 committed 范围，记录 device-clock。原始位置与频率保留，Main 使用整数换算复核。
- 独占事件输出不拿 shared padding 语义替代。时钟不精确／不可读时，按最后成功提交起算，保守等待 ceil(3×实际 bufferFrames×1000/deviceRate)+100 ms，记录 exclusive-period-estimate 和实际等待时间。这是已声明估计方法，不是精确设备完成证明。精确但一直停滞的时钟走超时错误，不将其静默转成成功。

设备失效／资源失效／音频服务关闭的时钟错误直接失败；共享 padding 查询失败／越界也失败。缓冲／时钟报告仍依赖驱动的正确性，Windows 引擎插入欠载静音与流不连续、频率变化、系统转换延迟和 DAC 延迟仍待正式时钟计划／数字捕获验证。hardwareVerified 始终 false。

## Stop／Reset 之后才允许 ended

等待取得依据后，Pump 返回给 miniaudio worker 的停止流程，沿用 Stop-before-Reset 的丢弃清理路径；这时最后包已提交且已取得尾部依据，不再次调用旧的隐式 drain。worker 检查真实 onDeviceStop 结果，只有 Stop／Reset 成功才发布内部 completed；控制线程随后发送带 completed 尾部对象的 ended。

自然完成的 stopped notification 不再被误认为设备失联；其他 interruption／reroute／非预期停止仍走错误。普通设备／提交失败、尾部失败、停止失败都不会发送正常结束。播放队列只收到经过 Main 验证的 ended 才前进，不凭输入 finished 标志推进。

暂停／seek／stop 保留优先处理机会。尾部等待每次短等 10 ms 并检查 device state；用户暂停／跳转可让 worker 取消等待，再执行冻结位置和旧重建流程。成功重建清尾部缓存／状态／计数和 generation 对应界面状态。若用户命令在设备自然完成后、控制线程发布 ended 前已排入控制队列，先处理用户命令，避免把暂停或跳转误作自动下一首。

同文件相邻 CUE 仍在有效源坐标到达边界时切换身份；尾部只针对当前完整可播放范围或已取消的第二 CUE span。源身份事件仍先于最终结束。跨文件 gapless／预打开下一首／统一输出计划仍未实现，不能以尾部回执宣称 AC04 已通过。

## 跨线程观察和快照

callback／转换 worker 只更新原子阶段并写属于阶段的固定字段，不创建 JSON、不取得界面／IPC mutex。各阶段的字段先写完再以 release 发布；控制线程 acquire 后只读取属于该阶段的不可变字段。等待期间可变的完成 proof 只在 completed 发布后读取，避免在 draining 中窥探半次读数。

控制线程生成 JSON 并保存可读缓存；输入线程 snapshot 只读取这个缓存，不调用设备。快照在 Channel writes 锁下重新核对 generation，取得时钟／尾部／暂停缓存后再次核对重建标记，再发送回执和快照。重建完成的 generation 发布也使用这个锁，避免把旧缓存和新 generation 混合。这个锁不进入 callback／转换路径。

## 有界等待与宿主活性

从 EOF fence 开始，worker flushing／draining 总期限 30 秒，设备读数前后检查；Main 首次收到未完成尾部时启动 35 秒期限，不按后续状态刷新它。过期停止会话并回收宿主，不自动下一首。已经阻塞的 COM 调用无法由本地 deadline 立即中断，因此沿用父退出 guardian 和 Main 进程终止／旧宿主退出确认。

另增 Main 播放状态活性期限 10 秒；真实握手之后，在 playing／paused 下，由有效普通状态、position、快照、CUE 或尾部事件刷新。可选分析帧和普通命令 receipt 不足以续期。没有状态报告则失败回收，不盲目恢复或启动新宿主。这也覆盖控制线程在首次尾部通知前卡在设备时钟读取的情况。停止、失败、回收、状态重建均清计时器；tail completed 后尾部期限清除，正常 ended 后活性期限也清除。

时钟、尾部和错误通知的真实调度、暂停／seek 交错及阻塞驱动的退出确认仍需 MVP 实测。

## 契约与详情

新增 tail-completion-v1 和 presentation-clock-v4，音频 IPC 1.13。clock 保持 17 个外层字段，conversion 改为 7 字段（新增 outputPaddingFrames）。原始 tail 有 15 字段，包含阶段／依据、源和设备率、输入 EOF fence、目标／成功提交／补包帧、滤波尾部策略和完成 proof；proof 包含时钟原始计数或共享 padding、实际等待时间及 bufferFrames。uint64 帧数使用规范十进制字符串。

Main 检查字段数、真实输出参数、策略、与实际 converter latency 一致的尾部预算、提交范围、阶段／源范围不回退、proof 和模式的对应关系。实际宿主若 ended 缺少 completed 尾部对象则失败；未握手的既有维护替身允许旧空对象路径，不用于真实宿主。generation 和接收时间由 Main 补充。

详情增加处理尾部／等待输出提示，保留暂停、停止和跳转；估计完成明确说明。进度／歌词继续复用既有时钟，封面内嵌优先、封面点击详情、歌手／专辑／风格检索、模式和列表入口保持。本批没有运行界面。

## 检查与未完成范围

原生音频／凭据／媒体组件、Main、Renderer（69 模块）编译、类型、发行／分发清单及维护脚本语法、源码包 CRC 静态核对通过。没有运行应用、音频、设备、单元／金样、SQL／迁移、端到端或安装包测试，没有新安装包。最新已验证安装包仍为 0.29.0；ASIO 实机验证继续搁置。

MVP 集中验收：极短／空／截断文件和真实 EOF；仅格式／声道转换、SRC 预算和零输入输出；末包补零、提交失败／计数和溢出；共享 padding=0／失败／越界；独占时钟、S_FALSE、不可读／回退／停滞／失效、周期估计；停止失败、30／35 秒期限、10 秒状态活性；尾部阶段快照／重建 generation；暂停／seek／stop 与 CUE 边界／取消预排交错；队列只按完成回执前进、退出确认和长时间播放。

完整 FR01–FR14／WP01–WP11 继续。下一批实施正式 PlaybackPlan／增益与 ReplayGain，继续补输出能力及处理节点；后续补跨文件 gapless、滤波尾部阈值／延迟与误差界、流不连续、呈现历史、Native/DoP／ASIO 音乐后端以及其他曲库／元数据／写回／歌词／扩展能力。编译成功不代表任何硬件门禁或完整目标完成。
