# ADR-076：显式 PCM 转换泵、转换时间线和延迟依据

日期：2026-10-02。源码版本 0.71.0；schema 36、媒体协议 5 不变，音频 IPC 1.12。状态：源码实现、类型／编译／静态检查；实际转换、时钟、尾部及音质待 MVP。关联 FR07/FR08/FR10/FR11、WP02/WP06/WP07/WP10。完整 AudioClock／PlaybackPlan／无缝与数字输出门禁仍未通过。

## 显式转换代替隐式输入缓存

0.70 只对 miniaudio passthrough 同率路径报告设备位置，转换路径仍用回调估计。检查固定 miniaudio 0.11.25 源码发现：默认 read_frames_from_client 在内部取输入、转换、保存输入缓存，转换成功／实际消耗量并未返回调用方；ma_device_stop 清缓存但不会调用 ma_data_converter_reset，SRC 相位、上一样本与低通缓存可能跨 seek 留存。

新增项目 output-conversion.hpp，通过 WASAPI context 的 onDeviceDataLoop 接入 blocking worker；原 onDeviceWrite／onDeviceStop 与 0.70 的成功提交／冻结读数沿用。没有修改固定 vendor 源码。转换器仍是设备初始化时选择的 miniaudio converter，明确使用固定采样率的 linear resampler，保留格式／声道转换和数据 callback 的既有处理。未启用动态 SRC 或外部转换后端。

[官方 Data Conversion 文档](https://miniaud.io/docs/manual/index.html#DataConversion) 给出 actual consumed／produced 计数和输入／输出延迟接口；具体语义同时以仓库固定版本源码为准。不是把请求帧数直接当成转换结果。

Pump 拥有预分配输入／输出各 64 KiB，输入请求最多 2048 帧，输出最多 512 帧且不超过内部 period；实际字节容量也限制帧数。已有 PCM 环形缓冲继续独立使用原 32 MiB 限额。Player 改为控制线程上稳定地址的堆对象，避免新增时间线与转换缓存占用 Windows 默认线程栈。只在停止状态清理缓存和重置转换器。

Worker 每次调用 process_pcm_frames 核对实际 consumed／produced、输入剩余容量、输出容量及 uint64 累加。未消耗输入留在本地缓存；零输入时用非空指针与明确 0 帧尝试输出转换器已有缓存，不使用 NULL 输入的无限静音语义。转换既不消耗也不产生且仍有输入时判为错误；连续无输出尝试最多 4096 次，成功输出经后端写入后重置这个预算。已有停止唤醒与有界等待保留，停止请求后不继续主动取新输入。

实时路径不做 JSON／动态分配／应用锁／文件读取。miniaudio 转换内部使用有界栈缓冲；最坏执行耗时和高倍率 SRC 的 CPU 预算尚需 MVP 验证，编译不证明实时门禁。

## 两级时间线与成功提交范围

输入 callback 的旧 8192-span SPSC 保留，记录源帧和补零片段。新增另一个 8192-span SPSC，每次实际产生输出时记录 outputBegin／outputEnd 与 inputConsumedBegin／inputConsumedEnd；仅消耗输入的步骤累加计数，下一输出 span 使用更新后的输入起点。输出 span 先发布，随后发布累计 outputProduced，最后执行 WASAPI writer。设备成功提交范围继续以 ReleaseBuffer S_OK 水位为准，不以 produced 或 copied 计数代替。

设备位置 → 已转换输出 span → 转换输入坐标 → 已消费源 span。查找均有容量预算，队列满不覆盖未读内容，而回退 callback-estimate；重建时重置。对没有 resampler 的格式／声道转换，强制每次实际 used==produced，映射保持帧数，零延迟。这个路径扩展了 0.70 的 passthrough 限制，允许同率格式或声道转换的位置映射；它不证明音频样本未被转换。

固定率 SRC 保留实际输入／输出 span，依据固定率相位和转换器报告的 inputLatencyFrames 计算输入坐标，饱和到起点 0 并检查不超过该输出 span 的实际输入 consumed 范围；再由输入时间线扣除补零对应的源推进。outputLatencyFrames 单独保存用于诊断，不再重复扣一次输出延迟。换算避免大 uint64 乘积溢出。

这个 SRC 源坐标仍是估计。低通滤波的群延迟随频率变化，库的 reported latency 不是已测整体延迟；Windows 引擎转换／欠载插入／流不连续、解码器或 DSD 转 PCM 延迟不在本批误差界中。不能将比率和报告延迟视为完整精准模型。因此 SRC 使用 converter-estimate，mappingUncertaintyFrames=null；只有保持帧数的映射使用 device-reported 和数学取整 1 帧。hardwareVerified 恒 false。

## 暂停、跳转、CUE 与尾部

冻结 Stop-before-Reset 读数沿用 0.70，在旧转换时间线仍存在时映射。保持帧数路径标记 device-frozen；SRC 标记 converted-frozen；异常时仍是 recent-position。成功停止后，先重定位解码器，调用 ma_data_converter_reset 清 SRC 相位／历史样本／滤波缓存，清 Pump 输入缓存及两级时间线／计数，再预读与发布新 generation。reset 失败直接终止，不报告重建完成，也不开始设备。

冻结时跨过预排 CUE 边界的身份排序保留；转换估计边界也使用同一源坐标，仍需 CUE／SRC 同步验收。有效 converter-estimate 下，自然结束和 CUE 边界等待映射的源位置，而不直接依据提前消费的输入。已暂停的会话不因 finished 标记自动发 ended。

这不是尾部完整确认协议。时钟不可用时的回调回退结束策略、未播放静音与滤波尾部长度、IIR 完整尾部预算、成功 drain 后再发 ended、跨文件预打开与编码 delay/padding 仍继续开发。不能把 0.71 的 converted timeline 视作 AC04–08／AC16 通过。

## IPC、跨线程诊断与详情

presentation-clock-v3／音频 IPC 1.12 配对使用，原始 clock 有 17 字段，新增 conversion 六字段对象：resampled、inputConsumed、outputProduced、inputLatencyFrames、outputLatencyFrames、latencyEvidence。所有帧数为规范 uint64 字符串。Main 校验实际源／设备率、转换标记／延迟类型、成功提交不超过已产出范围、精确／估计／书签的组合和对应原因。

保持帧数转换的诊断从同一个已发布 output counter 派生匹配 input counter，以免分别读取两个 worker 原子计数观察到半次更新。SRC 诊断为输出后输入的独立原子观察，不承诺这两个公开累计计数属于同一次 API 调用；配对证据在 SPSC span 中，位置映射不使用这个诊断差值。转换延迟及配置仅在已停止状态更改。

详情区分“设备报告位置”“按设备位置换算的转换估计”“音频回调估计”“暂停／跳转书签”，说明转换滤波同步仍待验证。进度、歌词和 CUE 继续共用 Main 已验证的源位置，Renderer 没有自行用解码计数外推。封面内嵌优先、封面点击详情、元数据检索、滚动歌词、模式与列表入口保持。

## 检查与后续门禁

原生音频／凭据／媒体组件、Main、Renderer（68 模块）编译、类型、发行／分发清单、相关维护脚本语法及源码归档 CRC 静态核对通过。没有运行应用、设备、单元／金样、SQL／迁移、界面、同步、暂停或安装包测试，也没有新安装包。最新已验证安装包仍为 0.29.0；ASIO 实机验证继续搁置。

MVP 集中验收：直通／仅格式／仅声道／SRC 和混合转换的实际计数；零输入缓存输出、未消耗输入、输入无输出、溢出／无推进；同率逐样本金样；44.1→48、48→44.1、高倍率与声道变化；两级 SPSC 满队列与半次计数观察；成功提交和未满包；暂停／seek 重建后无旧滤波样本；SRC 冻结书签／CUE／EOF；初始暂停及暂停尾部；输出误差、滤波音质、CPU／欠载对照、父退出及长时播放。

保持 FR01–FR14、WP01–WP11 全目标。正式 PlaybackPlan（增益／ReplayGain／处理链和真实能力）、完整提交／不连续／延迟误差、跨文件 gapless、Native/DoP／ASIO 音乐后端以及其余曲库／元数据／写回／歌词／扩展范围仍继续实施。
