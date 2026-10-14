# ADR-110：ASIO 原生播放会话、呈现映射与新进程书签

日期：2026-10-03；源码版本：0.104.0；音频 IPC：1.20；状态：原生会话与共享校验已实现，应用路由待接入，运行验收集中到 MVP。

## 完整目标和本批边界

继续实现架构 FR09／WP06 的真实 ASIO 播放。ADR-108 的 PCM Engine 与 ADR-109 的配置／能力观察保留。本批把绑定文件解码、预读 ring、增益／可视化、CUE 范围、播放前正式计划、驱动输出、进度、歌曲尾部与重建书签连接为原生私有 IPC 会话。

`AudioController` 当前仍发送 WASAPI 请求，现有 `PlaybackState`／活动输出设置也仍为 WASAPI。ASIO 原生会话已具备接收和处理真实播放请求的源码，但 Main 的活动后端持久选择、ASIO 事件路由和新进程书签应用尚未接入。应用中的 ASIO 配置区域继续显示“播放接入开发中”；不得据此声明用户现在可点击 ASIO 播放。

ASIO 实机验证按用户要求暂停，开发没有暂停。FR01–FR14、WP01–WP11、G1–G5 和 AC01–AC19 的完整目标仍保持；不以本批或任何编译通过替代完整验收。

## 私有请求和正式准备

原有独立音频宿主、用户 DACL 私有命名管道、父进程存活监测、session／nonce／build 身份和长度前缀协议保持。握手增加 `asio-pcm-session-v1`；`playback.play.params.backend='asio'` 才进入新的 Session，未指定 backend 仍走 WASAPI，其他 backend 明确拒绝。

`asio` 快照包含配置修订、完整注册名称／规范 CLSID、源序号到唯一输出索引、缓冲帧数及精度转换授权。ASIO 使用 exclusive 模式并要求顶层转换授权与配置一致，不接受 WASAPI endpoint。注册身份在加载前由 Engine 重新核对，源采样率和实际声道／缓冲在 prepare 后重新核对；声道数须与解码结果一致，不自动混音、补选、复制或转换采样率。

共用只读句柄绑定的 AuralPcmDecoder，覆盖既有 FLAC／WAV／压缩 PCM 及明确允许的 DSD 转 PCM 路径。整数候选采用有效位和容器信息，浮点采用 f32，源编码质量与实际解码转换仍分别报告。Native DSD／DoP 不由 PCM 模块伪造，DSD CUE 双 span 仍拒绝；转换滤波延迟等既有未完成项继续。

已知解码总长度时，初始位置和有限源范围必须落在长度内；CUE 使用现有整数帧换算、相邻半开两 span 与 INDEX 00 策略的实际范围。有限范围提前 EOF 明确失败，不能把截断源当作原计划的正常完成。源路径拒绝 NUL；seek 时间／帧数转换检测溢出。解码 preRead 按两秒与 32 MiB 双上限，分配与读文件在 producer，回调只消费有界 ring。

准备回执包含完整句柄来源／位深、实际驱动／PCM 声道布局／缓冲／延迟、处理、源范围、固定节点及预算。版本 1 的 `asioPlan` 使用独立 ASIO 契约；不能伪装为 WASAPI pipelinePlan。token 绑定 session 和 nonce，Main 必须核对整个 prepared 回执后，用原 token 发 `playback.start`。十秒内没有合法批准就释放驱动；plan 前和 start 前各再次核对源身份。未经批准不启动 producer 或输出，不消费音乐。

## 音频发布、启动与时钟

共享 PCM Engine 增加可选 `RenderTarget.published`。该 hook 只在平面已成功复制、没有致命驱动／打包错误时调用，将源起点、有效音乐／总帧数、半区、回调的 samplePosition／systemTime 复制进固定 8192 项 SPSC 时间线。延后 worker 使用回调期间复制的时间戳，不在回调返回后引用 ASIOTime。hook 不分配、不等待锁、不读文件、不做 JSON／IPC。

Steinberg ASIO 2.3 规范第 8 页指出，驱动可能在硬件开始前立即发出前两个回调；第 18、42 页规定回调时钟与当前块的关系，以及输出延迟包括已排队块和硬件延迟。本批直接阅读已固定官方 SDK ZIP 中的规范 PDF，而不是从非官方实现推断时序。官方 SDK 来源与许可证见 [ADR-022](ADR-022-asio-sdk-probe.md)，[Steinberg 开发者入口](https://www.steinberg.net/developers/)。

因此修正 ADR-108 的源码启动预填策略：B 半区只填 PCM 静音，不能在 start 前消费歌曲。这样驱动提前再次填 B 时不会覆盖已消费音乐；首次音乐仅在真实缓冲回调中读取并记录。这是对启动时序的源码修正，真实驱动顺序与首尾样本仍须金样／实机确认。

呈现位置将成功发布的源 span 对应到 `callback.samplePosition + prepared.outputLatency`，再用后续驱动位置映射有效音乐帧；短读补零区间不推动源帧。等待三个时间和位置都推进的连续观察后才声明 driver-reported，初始重复时间、缺失时间信息使用 callback-estimate。旧估计领先真实位置时短暂保持，等真实输出追上，不能每次又推进 consumed 而永久跑在驱动前面。位置倒退、启动后停滞或时间线超预算失败并退出；系统时间回退不伪造精确映射。

这里的 driver-reported 只是 ASIO 报告加固定延迟的块边界推导，不是数字输出认证；没有用填充缓冲数、消费计数或本地墙钟冒充设备播放帧。legacy bufferSwitch 未提供 TimeInfo 时保持估计，不在实时回调中另做额外驱动时钟查询。所有报告保留 hardwareVerified=false，exactPackingCandidate 也不是整个解码／DSP／硬件路径的 bit-perfect 证据。

## 增益、可视化和 CUE

复用既有 20 ms LiveGain、ReplayGain／Opus 来源策略、削波及非法样本计数；软件处理要求有效的明确 processing 请求、允许转换和浮点源。精度转换配置本身不产生增益请求，也不自动分析响度。原始模式绕过增益，浮点原样打包不改写 NaN／Inf 位模式；非同格式精度转换仍遵循 ADR-108 的数值策略。

分析 tap 捕获复制到驱动前的实际消费 PCM，FFT 和 JSON 在后台／控制线程；帧、峰值／RMS／频谱与波形仍使用原版本 1 包。CUE 相邻两 span 共用源／驱动会话；处理增益在 callback 的实际源边界切换，对外 cueBoundary 按当前呈现证据发送。取消 next 的原子边界检查保留，停止消费边界后的预读内容并进入第一 span 尾部。

## EOF 与驱动释放

只有 producer 完成、ring 已消费且模块／时间线都确认对应音乐平面成功发布时，才进入 draining。最后音乐块有完整时间戳时保存最后音乐样本的设备目标帧；后续稳定驱动位置达到该帧，完成依据为 driver-clock。

时间信息不能完整支持证明时，使用显式 `driver-latency-period-estimate`：从最后音乐发布已被控制线程观察到之后，至少等待已报告输出延迟＋三个缓冲周期＋100 ms。这仍是估计，不能标为硬件播放完成证明。当前传输要求 getLatencies 成功、输出延迟不超过五秒、deviceFrames≤32768，尾部总观察上限三十秒；这只是当前原生实现的预算限制，超预算设备支持仍是完整目标的后续范围。

EOF 成功前必须确认旧 driver stop／dispose／自有 COM 引用释放、回调／延后线程退出；失败时 native process 必须退休，不能继续访问旧缓冲。只在 clean close 后发 completed／ended；该退出确认覆盖本会话所有权，不证明系统里其他应用或厂商外部引用都释放了设备。

## 控制命令与新进程

私有输入线程只读取、解析并把命令放入最多 16 项队列；所有 IASIO 调用、处理计划更新和事件写入在拥有者 STA。每个 session 最多保留 1024 个命令原回执，UUID、generation、method／params 内容一致性校验包括最初 play 和 start；相同 ID 换内容拒绝，重复操作不重复执行。

支持分析开关、当前 snapshot、授权浮点源实时音量、取消相邻 span、停止、初始 paused 的首次 resume。已 start 的 Engine 仍不得在同一进程第二次 start 或加载驱动。

暂停、seek、reset／resync／缓冲大小请求和延迟变化先停止、完全释放旧 driver，再发 `rebuildRequired`，包含原始源帧书签、对应微秒、源率、期望 playing／paused 和 driverReleased=true。没有对旧驱动做 stop→重新 start 的冒险复用。已知源长度、取消 next 和实际 EOF 尾部界限用于书签／seek 检查；暂停末尾书签夹到最后有效帧。

frame 是精确书签，微秒是降精度显示／兼容字段；新会话可用 `initialPositionFrame` 且微秒必须为零，避免重复换算漂移。**Main 接入仍须**串行核对原 session／generation、CUE 当前 item 的相对原点、源绑定和配置修订，确认原 native process 退出，再建立新进程并重新核对全部正式计划。自动 driver-reconfigure 重建需要 Main 的次数／退避限制，不能无限恢复。回调／打包／速率／时钟等其他致命异常只失败，不伪装成成功恢复。

## 下一接入和验证

共享 `asio-playback.ts` 已实现 configuration 转换及严格 source／output／plan／clock／tail／rebuild／prepared 校验，包括位深／容器与授权一致性、预算、源绑定、Opus／DSD 来源、token／范围／批准前零消费及尾部证据。它准备供 Main 后端路由使用，当前 AudioController 尚未调用。

下一批继续活动后端配置 CAS／持久快照、Main 原生 ASIO 路由与事件状态、预备／重建过程 watchdog 和源／队列书签转接、UI 实际输出与音量／分析。控制面板、跨文件无缝、Native／DoP、驱动矩阵及长时验证保留。

本批只进行 Main／Renderer 类型和编译、全部生产 native 编译、发行／分发清单、CommonJS 源语法检查，并归档源码。没有运行应用、驱动／注册命令、解码／播放／时钟／金样、UI、SQL 或安装包，真实首尾样本、数值转换、暂停／seek／CUE／故障／尾部与性能均集中到 MVP。无新安装包，最新已验证仍为 0.29.0。

静态交付结果：Main／Renderer 类型检查和构建、audio-host／waveform-worker／credential-vault／media-worker／system-media 生产组件及既有金样程序编译通过；Renderer 108 模块，主块 375.74 kB／gzip 118.49 kB；41 个 CommonJS 源文件语法与发行生成文件核对通过。分发清单重新生成后核对 18 个 npm 运行依赖与 5 个 vendored 组件，源码归档另做 ZIP CRC 核对；这些核对不运行应用或测试。
