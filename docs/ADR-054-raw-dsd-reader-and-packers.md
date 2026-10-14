# ADR-054：DSD 位流读取与 Native/DoP 软件打包

日期：2026-10-01；源码 0.49.0；schema v24、音频 IPC 1.8 不变。对应 FR03、WP02/WP07/WP11。软件组件已实现并编译；未打开设备，播放器仍仅提供显式转 PCM 或停止。此批次不宣布 Native/DoP 可播放或 G2–G4 通过。

## 原始位流类型与 Reader

增加独立 `RawBlock`，discriminant 为 rawDsdMsbFirst，保存每声道 bit rate、源 tick、有效 bit 数、存储字节帧数和通道交错的原始字节。它与 PCM 缓冲分开，不以 float32 表示 DSD。`dsd-block.hpp` 与 `dsd-packer.hpp` 只依赖标准 C++；Windows 文件边界留在 `dsd-reader.hpp`。

Reader 借用或拥有已有文件句柄，先做既有 DSF/DFF 边界检查。借用关闭责任仍属调用者；真正接入 Worker/Host 时必须由调用者提供只读、目录验证且禁止并发改写的句柄。组件没有 Renderer 路径入口，没有把头部检查当作目录授权。流式缓存 DSF 物理通道 block 组或 DFF 64 KiB 范围，单次最多返回 4096 个字节帧，不加载完整媒体。

DSF 平面通道恢复为统一字节帧交错；LSB-first 逐字节反转为 MSB-first，通道顺序不排序。容器描述保存 DSF layout code 或 DFF 原始 channel tags，留给 OutputPlanner 校验映射，未知布局不能自动认定兼容。保留源 data offset/bytes、原始速率和有效 tick，不把存储 byte rate 当原始 sample rate。

支持任意有效 bit tick 定位，使用跨字节移位组成新块，最后一个不完整字节只保留有效位，其余填入有相位的 DSD 协议静音。DSF 非整字节尾已可在 raw Reader 中处理；0.48 的 FFmpeg PCM 路径继续明确拒绝此类尾部，直到转换路径迁移与金样通过，不能把 raw 支持偷换成 PCM 已支持。其他速率族、DST 和未适配容器仍拒绝。

取消与 20 秒工作期限分开为 cancelled/timedOut，读取失败不推进源 tick；不完整块不能交给 packer。同步 ReadFile 仍可能阻塞，独立进程 watchdog 是后续接入边界，组件本身不宣称能强制取消内核 I/O。借用同句柄的 cursor 由单生产者拥有，组件不提供并发读保证。

## Native 与 DoP 数据表示

Native packer 生成按声道分离的 byte plane，显式选择 MSB-first 或 LSB-first，对应 SDK 定义的 ASIOSTDSDInt8MSB1/LSB1 位序。NER8 等其他 sample type 未实现。Native 输出描述同时保留原始 bitRate 与 storageRate=bitRate/8；固定 SDK 注释要求 ASIO 以原始 DSD 率设置，不能把字节存储率直接用于 ASIOSetSampleRate。实际 buffer-size 单位／驱动格式切换仍需输出后端与实机验收，见 `native/asio-probe/vendor/asio.h` 的 DSD operation / buffer layout。

DoP 实现依据 [DoP 1.1 §2–4](https://dsd-guide.com/sites/default/files/white-papers/DoP_openStandard_1v1.pdf)：每帧每声道 16 个 DSD 有效位，标记 0x05/0xFA 逐帧交替且所有声道一致，较早 DSD bit 在 payload bit15。统一 MSB-first 的旧字节位于 payload 高字节；24-bit 小端存储为 newer/older/marker，32-bit 左对齐 24 有效位为 0/newer/older/marker。未实现右对齐、不同端序或规范另一种扩展承载法；不能将任意 s32 转换都当作数据保持。

DoP storageRate=bitRate/16：64/128/256 的承载率分别为 176400/352800/705600 Hz。这只说明打包关系，不证明 DAC 识别 DoP 或驱动保留 marker/payload。实际输出必须独立、禁止 DSP/音量/SRC，并在可信设备能力与用户策略下协商；现有 PCM 数据转换层不会自动被用于 DoP。

Packer 保存跨块一个字节／声道的 carry、期待源 tick、carrier 帧计数和 marker 相位；丢乱序、错参数、错误载荷、非终结部分字节与重复 final。流末不足 16 bit 时补协议静音但独立记录真实源有效位数，承载填充不增加文件播放时长。溢出检查在改变 marker/carry 前执行。

Native 静音使用对应位序的 DSD 模式；DoP 静音保留 marker 交替和有效源位数为零，不消费暂存源字节，也不推进文件位置。此组件准备的是协议数据，设备暂停／欠载／结束时的真实停流序列仍需验证，不能用“有静音函数”证明 DAC 行为安全或直接接入输出回调。存储分配与打包当前在生产层，实时回调仍应只复制预备好的块。

## 软件金样、构建与剩余范围

新增开发用 `dsd-gold.exe`，不随应用资源分发，不加载 ASIO／打开音频设备；覆盖 13 个具备固定期望字节的场景：Native 位序／声道 plane、DoP payload 时间序／通道一致 marker、24/32-bit 存储、跨块 carry、插入协议静音后的相位、部分位尾和重复终结、DSF 平面／LSB／填充／非整字节尾、非对齐 tick 定位／EOF／范围负例。运行时仅创建自身临时 DSF 夹具并清理，不修改用户音乐。

`npm run build:native` 仅编译该程序；MVP 时运行 `npm run test:dsd-gold`，已加入完整 verify:contracts 的最后阶段。此次没有运行 gold，不把代码里的断言或报告文本当作测试通过证据。后续还需 DFF、MSB DSF、多声道、不同 block、截断、取消、长路径／UNC、合法边界和真实媒体矩阵。

本轮类型检查、主进程／界面 55 模块、原生组件和 DSD gold 编译、发行／分发清单及脚本语法静态核对通过；四个 FFmpeg 库复用未改的受控 recipe。没有执行 Reader/packer/gold、播放／转换／seek、界面、SQL、设备、ASIO 驱动或安装器。最新已验证安装包仍为 0.29.0。

下一步将 raw Reader 与转换／滤波头尾及时钟接合，并开发独立 Native/DoP 输出计划、环形缓冲与后端；设备能力、ASIO PCM/DSD 实现、实际 Native/DoP 停流与捕获认证仍未完成。用户搁置 ASIO 实机验证的要求继续执行。FR01–FR14/WP01–WP11 原范围不缩减，整体目标仍未完成。
