# ADR-084：同一播放文件句柄与整数格式选择

日期：2026-10-02；源码 0.79.0；音频 IPC 1.19；schema v38／媒体协议 6 不变。

## 问题与决策

此前整数候选先按路径探测文件头，再重新打开实际解码器；文件替换或设备不支持时的再次打开可能使候选、解码证据与最终播放来源不同。按架构 §13、§14，本批让实际播放解码器持有一个只读 Windows 文件句柄，读取头部、选择整数格式、重置解码器、浮点回退、跳转和播放均复用它。删除单独的路径整数探针。

句柄使用 GENERIC_READ／FILE_SHARE_READ，仅接受非空磁盘文件；普通本地写入／删除共享冲突会阻止打开，而不是静默共享写入。解码器关闭前不关闭所有者句柄，VFS onClose 只结束借用。波形分析继续借用其已有授权／哈希校验句柄、使用 f32，不改变波形缓存算法。

这不是统一 MediaSource 授权与内容认证的全部实现，也不是跨 NAS 的稳定内容身份。卷号／文件索引／大小／修改时间只描述本次 Windows 文件对象；远端文件系统、特殊写入方式和保持属性不变的内容修改不能靠这些属性完全证明。完整媒体定位、内容哈希／能力清单、跨平台、数字与硬件认证继续开发。

## 整数选择与回退

- WAV 实际 decoder header 声明 PCM、有效位 1–32 且容器为 8／16／24／32 位时，容器不超过 16 位选择 s16，24／32 位选择 s32。extensible 的有效位与容器位独立保存；有 padding 的 32 位容器保留 s32，不按较小有效位截成 s16。没有有效位证据不提供整数候选。
- FLAC 使用本次实际 STREAMINFO 有效位 1–32，按不超过 16 位选择 s16，否则 s32；仍受固定 decoder 实际支持范围约束，不宣称所有位深文件已运行通过。
- ALAC 仅在实际 FFmpeg codec context 有效位 1–32、packed S16／S32 容量足够时提供整数候选。其他编码继续浮点或已有明确 DSD 转 PCM 路径。
- 内建 decoder 的最终 converter 必须 isPassthrough 才能提供整数候选；存在内部额外声道／格式转换时，同句柄重配到声明的浮点路径，原始独占模式在启动前计划核对时拒绝它。设备转换器的原始模式直通约束保留。
- 格式重置对比实际 codec、采样率、声道和源证据。设备不支持整数但允许转换时，以同一句柄重新配置 f32，对比文件绑定、codec／backend／源证据后恢复位置；decoderConversion 允许随显式格式回退改变，其他证据不能改变。

整数扩展／对齐、FLAC／ALAC 数值与声道金样尚未执行；decoder-format-transform-unverified、bitPerfectVerified=false 和 hardwareVerified=false 保留。配置符合候选条件不表示源样本或 DAC 已逐位认证。

## 文件观察与协议

新增 playback-file-binding-v1 能力和 PlaybackFileBinding v1 八字段：version、kind、volumeSerial、fileIndex、byteLength、lastWriteTicks、shareMode、certification。64 位值传规范十进制字符串，避免 JSON number 精度损失；kind 固定 windows-readonly-handle，shareMode 为 read-only，certification 为 pending。当前 decodedSource 增至十字段；管线仍 AudioPipelinePlan v2。

初始定位及播放前强制核对属性，producer 读取每秒至少尝试一次属性观察、seek 强制观察；变化或查询失败停止，不采用变化后的属性。Main 验证字段／范围并将绑定纳入不可变 source。启用缓存 ReplayGain 标签且有扫描 stamp 时，用实际句柄的大小与 FILETIME 换算毫秒核对，旧 JS 扫描 stamp 仅容许 1 毫秒边界取整差；输入长度有界。已有路径 stat 仍保留，此处补上实际打开来源的属性核对。CUE sidecar 与完整标签内容身份绑定仍待后续实现。

文件读取使用同步 I/O，每次解码／定位的 20 秒预算及取消检查是协作式的，不能中断阻塞中的操作系统读／stat。Main 宿主期限、停止与父退出守护保留；不能将编译成功解释成所有设备按期退出。VFS 记录非 EOF I/O 错误，防止解析器吞掉错误后误报自然结束；这些控制／producer 操作不进入音频 callback。

## 界面、范围与验收

播放详情的技术折叠区展示本次文件大小／卷号／索引及同句柄说明，明确这些不是内容哈希。用户提出的内嵌封面优先、点击播放栏封面进入详情、歌手／专辑／风格检索、滚动歌词、顺序／循环／随机和可编辑队列保留。封面优先级为内嵌正面、其他内嵌图片、同名／目录图片；显示失败有限恢复和独立刷新仍在。

本批仅做类型、Main／界面／原生编译、发行／分发清单、现有维护脚本语法和源码归档 CRC 核对；运行结果以实施状态中的最终记录为准。未运行音乐、数值、进程、UI、SQL／迁移、网络、硬件或安装测试，集中到 MVP。最新已验证安装包仍 0.29.0；ASIO 实机验证搁置，完整 FR01–FR14／WP01–WP11／G1–G5／AC01–AC19 保留。

MVP 应覆盖 WAV 8／16／24／32 与 extensible padding／非法有效位、实际支持的 FLAC 位深／ALAC packed 格式、浮点／有损源、decoder／device 转换拒绝、同句柄浮点回退与恢复定位、文件共享冲突／属性变化／路径替换／NAS 错误、I/O 失败不误报 EOF、取消／阻塞期限、FILETIME 精度与 ReplayGain stamp 不匹配、source 回执冲突、资源释放，以及真实歌曲封面／资料检索／歌词同步／模式和队列界面。
