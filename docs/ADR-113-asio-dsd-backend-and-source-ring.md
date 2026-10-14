# ADR-113：ASIO DSD 原生后端准备、位流预读与驱动观察

- 状态：源码、类型与编译检查通过；运行与数值验证集中到 MVP
- 版本：0.107.0
- 日期：2026-10-03
- 关联：FR03／FR09、架构 §13–14、WP02／WP07、AC07／08；延续 ADR-054／108–112

## 实施范围与应用边界

已有 DSF／未压缩 DFF 的有界 Reader、原始位流描述及 Native／DoP packer，但 ASIO Engine 之前只准备和输出 PCM。本批增加真实 IASIO 后端的 DSD 准备、精确载荷写入、协议静音和原始源预读模块，不把原来脱离设备的 packer 当作设备输出接入。

`Configuration` 和 `DsdConfiguration` 为内部带判别的变体，PCM `RenderTarget` 与位流 `DsdRenderTarget` 独立；不是把原始 DSD 填入浮点 PCM 缓冲。一次 Engine 只接受一次准备尝试，准备失败之后也不能在原进程改换路径或打开控制面板；调用方必须释放／退休旧进程。处理失败及未知清理沿用 ADR-108 的回调退休和进程退出边界。

本批没有 DSD 私有播放 IPC、应用设备档案和授权管理、Main 路由／批准、bit-tick 呈现时钟／尾部／新进程书签、DSD 独立分析副本或 DoP WASAPI 路线。模块已经进入生产宿主编译，但没有从现有应用播放入口调用 `prepareDsd()`，当前界面仍只提供显式 DSD→PCM 或停止策略。内部 `dopUserConfigured` 标记要求后续由匹配准确设备／驱动／格式的档案批准；它本身不构成完整档案或硬件证据。不能声明应用已经可 Native／DoP 播放。

## Native DSD 与 DoP 准备

Native 在 owning STA 查询 `kAsioCanDoIoFormat`，要求 `ASE_SUCCESS` 和未改写的 DSD 请求，再选定并回读 DSD I/O 模式；切换发生在 createBuffers 之前。DSD64／128／256 目标使用每声道 bit-sample rate 2822400／5644800／11289600，先查支持，再明确选率并回读，不容许隐式 SRC。切换后当前率可以明确返回 `ASE_NoClock`，此时选定目标率后仍必须精确回读；其他错误和不有限数字不忽略。

输出声道逐项检查，只接受一位 MSB1／LSB1；NER8 是八位 DSD，不能把一位原始数据展开成0／1字节冒充它。Native 缓冲 B 必须是8的倍数，每声道缓冲占 B/8 字节，ASIO samplePosition、采样率和延迟仍按 bit-sample 表示。位序按每个实际声道分别重排，保留源声道顺序与用户的明确输出映射。

DoP 必须显式 `dopUserConfigured`，按 DSD bit-rate/16 选择承载 PCM 率。只接受整数24位容器、32位整型容器中的高24位、以及 SDK 右对齐24有效位的32位容器，正确处理大小端、右对齐负数符号扩展；浮点、较低精度、DSP、数字音量与 SRC 都不进入位流分支。模式和采样率、声道、缓冲几何、有效内存、实际样本格式在 createBuffers 后重新核对。

DoP 每帧传16个 DSD 位，marker 在全部声道保持同相，按05／FA交替；旧位位于16位载荷高端。B 限定偶数，因此每个回调半区和预填静音都以同一 marker 相位开始，不依赖块被丢弃之后继续推进一个全局 marker 计数。奇数驱动缓冲明确拒绝，未来若扩展，需要端到端相位证明，不能悄悄补成另一个缓冲值。

依据：固定官方 SDK 2.3 的 `native/asio-probe/vendor/asio.h` 中 DSD 说明、`ASIOIoFormat` 及 `ASIOCanSampleRate`；已从官方锁定归档读取 SDK PDF 第35和49页核对位序／单位／模式切换。档案中 SDK 来源和 SHA-256 保持不变。DoP 载荷、marker 和承载率参照 [DoP 1.1 原始规范](https://dsd-guide.com/sites/default/files/white-papers/DoP_openStandard_1v1.pdf) 第2页；32位容器扩展遵守对应 ASIO 整数布局。

## 回调和协议静音

回调只从预分配 ring 读取规范化 MSB-first、按源声道交错的原始字节；没有文件读取、解码、分配、锁、网络或数据库访问。Native 最大读取 B/8 byte-frames，DoP 最大读取2B byte-frames。返回值区分字节帧数、每声道有效源位数和声明源终点，非终点的 DoP 短读必须为完整双字节组，末尾不满8位或16位用协议静音填充。

初始两个半区、half B 首次静音预填、欠载、停止期间回调和致命错误路径都使用与源 tick 相位一致的平衡 DSD 静音位型（69，LSB1对应反序），DoP 保持有效 marker；位流分支不发送 PCM 全零。准备期间写入缓冲是源自由静音，不提前消费歌曲。实际提交继续先在私有暂存平面完成，再拷贝至驱动半区，沿用并发／晚回调闸门。

`RenderObservation.sourceBits` 和一致快照 `publishedDsdBits` 只计实际发布的有效源位，不计 marker、填充和静音。Native `musicFrames` 以有效 bit-samples 计；DoP 为含源位的 carrier frames，最后一帧可能含协议补位。两者不能直接用同一种单位与文件位置做运算。已经读出但未成功发布的源数据需要后续 DSD 会话的退休／书签规则处理，不能凭 ring 的读指针声称已经听到。

## 原始源预读

`DsdStream` 接收调用方已绑定、在其生命周期内有效的音乐文件句柄，重新核对原始 DSD 率、声道与冻结的半开源 tick 范围，拒绝 DST 和无效容器。生产线程通过既有 Reader 处理 DSF 分块平面、DFF 交错、位序和任意源 tick 起点；固定32 MiB SPSC ring 与音频消费分离。两个索引用 acquire／release 发布；每块核对源起点／字节数／有效位／格式，冻结范围以外的最后补位在进入 ring 前移除。

DoP 消费在未到源终点时保留不完整的单字节尾组，避免一次欠载改变后续源双字节分组。消费不清零剩余输出，Engine 单独产生协议静音。正常 EOF、生产错误和取消分别记录，生产错误不能当作正常歌曲结束；后续会话必须监督错误标记与正常源范围完成。

调用方先退休驱动回调，再关闭源 ring。关闭在 owning thread 设置取消，反复取消可能阻塞的同步文件读取并最多观察生产线程2秒；没有确认退出则返回 false，析构会终止隔离原生进程，不能释放仍被使用的 ring／Reader。源句柄来源、前后文件观察、主进程退出监督和操作批准需由后续私有会话组装，不把本模块的格式核对当作完整播放授权。

## 当前模式能力观察

显式停止后读取驱动能力现在增加 PCM／DSD 的 `canDoIoFormat` 原始返回值和当前模式采样率列表，不调用 SetIoFormat、SetSampleRate、createBuffers 或 start。DSD 模式查三个源 bit-rate；其他模式查询有界18个 PCM 率。返回值在共享边界严格核对字段、顺序与范围，分别显示报告支持、不支持、未报告和查询失败；`ASE_NoClock=-995` 用于不支持率，内存错误不会被误判为不支持。

能力读取后重新核对模式／已知采样率／缓冲几何／声道数／样本类型，驱动发生变化则抛弃整次观察。观察仍只表示当前模式下的驱动回答，不证明另一模式的格式、DAC 识别 DoP 或实际输出。UI 以可展开的信息展示这些结果；不会自动切换模式或试送 DoP。最终播放前仍要在新的 Engine 对实际选择重读全部事实。

## 验证和后续

Main／Renderer 类型检查及构建（114模块，主块381.76 kB／gzip119.97 kB；输出设置块35.42 kB／gzip11.26 kB）、audio-host／waveform-worker／credential-vault／media-worker／system-media及既有金样程序编译、41个 CommonJS 源文件语法检查通过。最终音频宿主在准备失败的一次性闸门与未知当前率修订后重新编译。发行生成文件及分发清单（18个 npm运行依赖／5个 vendored组件）重新核对；源码另做 ZIP CRC核对。编译成功不作为数值／播放／硬件或架构门禁通过的证据。未执行应用、能力查询、模式切换、音频／位流、真实文件、数值金样、测试、SQL／迁移、Provider 或安装包。schema45／音频 IPC1.20／媒体协议9保持；新增能力回执由固定 Main／host buildId 约束。最新已验证安装包仍0.29.0；ASIO实机仍按用户要求搁置。

MVP：逐 bit 对比 MSB1／LSB1、DoP 全整数布局／大小端／有效位、DSD64／128／256；任意起点／末尾1–15位、缓冲量子／marker、初始预填／欠载／尾部／停止／重入；DSF／DFF／DST负例、ring边界／容量／取消／同步 I/O 阻塞；模式／rate／channel在准备中改变、当前率未知、驱动异常回执、生产失败与进程未知退出；真实 Native／已确认 DoP DAC 及驱动矩阵。硬件和 G3／G4 没有通过证据，完整 FR／WP／AC目标继续。
