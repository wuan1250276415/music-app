# ADR-115 ASIO DSD 私有会话与精确位数书签

日期：2026-10-03  
状态：源码、类型与编译检查通过；运行、数值和硬件验证集中到 MVP。

## 范围和应用边界

按架构的 WP02／WP07 和 FR03／FR09，将 0.107 原始 Reader、独立 DSD render 和 ASIO 后端接到私有进程会话。新增音频 IPC1.21 的 `asio-dsd-session-v1` 能力声明，Native／DoP 请求及事件与 PCM 分离。

这只是原生会话及共享契约实现。AudioController 还没有发送 DSD 私有请求，设备档案的数据库／修订保存和确认 UI 也尚未接入。当前应用对 DSD 仍执行既有显式转 PCM 或停止策略，不宣称应用可原生 DSD／DoP，不推断 MOONRIVER 3 或 ASIO4ALL 的能力。

## 源和批准

请求严格限制为 backend、transport、path、asio、source、initialPaused、dopAuthorization、expectedFile。ASIO 参数含配置修订、驱动键、显式唯一声道映射和缓冲；来源含 bit-rate（0 表示由原始头部确认）、声道、绝对起止位数和相对初始位数。拒绝未经声明的处理／增益参数。

打开单一只读绑定文件，核对重建时传入的文件绑定。读取原始 DSF 或未压缩 DFF 头部，拒绝未知速率、DST、通道不符、空范围和越界。Reader 再次打开同句柄后复核存储布局、有效位数、载荷范围与 channel tags。文件属性在准备、启动、继续、运行及结束时核对。

Native 必须携带 null DoP 档案，设备模式和 MSB1／LSB1 在后端准备时确认。DoP 要求完整 userConfigured 档案对象，包含 profile UUID／修订、驱动注册身份、当前初始化版本、DAC 名称、资料证据、确认的原始 DSD 速率列表、确切输出映射、文档与设备音量确认及 hardwareVerified:false。在 createBuffers 之前核对版本／速率／映射，不能用 PCM 高采样率或单一 bool 代替设备档案。

完整来源、输出、阶段、范围、缓冲、时钟／曲尾政策通过 prepared 事件发布。nonce／session 绑定计划 token；十秒内批准计划后才启动生产者和设备。两秒预读等待期间仍接收停止和快照，其他操作明确拒绝；不足预读、源失败、断连或过期批准不开始输出。初始暂停可预读但不 start，继续时再次核对源。

## 时间和结束

Native 的 ASIO 缓冲、samplePosition 和延迟按 DSD bit-sample 计数；DoP 按 PCM carrier frame 计数，每帧 16 个有效来源位，末帧不足 16 位只按真实位数计入源进度。原始 Reader／ring 消费和成功发布有效位数分别计数，协议静音、marker、填充位不作为歌曲内容。

成功发布平面后向有界 Timeline 发布来源 driver-frame 位置；拥有线程按驱动时钟和输出延迟映射，并将末帧进度裁切到有效位范围。没有稳定驱动观察时显式 callback-estimate，不称为硬件呈现证明。位数以 uint64 十进制字符串传递，显示秒数只是近似值；书签微秒用整数除法生成。

只有正常源 EOF、已消费计划全部位数、快照有效、实际已发布位数和 Timeline 音乐帧计数一致才进入曲尾。使用有效驱动目标位置，或显式已报告输出延迟加三个缓冲周期和 100ms 的保守估计。曲尾上限 30 秒；先停止并释放驱动、生产者和文件，再报告 ended。Main 下一批仍须等待实际 OS 子进程退出，不能仅凭释放字段启动后续会话。

## 控制与退休

16 项拥有线程命令队列和 1024 项不可变 command UUID 回执保持请求、内容和 generation 核对。接受回执不代表操作已完成，重建／停止事件只在释放后发布。

暂停和跳转退出旧会话，返回原始 positionTick、整数 positionUs、原始 bit-rate／冻结范围／文件绑定／配置修订和期望状态。resume 只适用于尚未 start 的初始暂停会话；其他暂停恢复必须由 Main 创建新进程并重新批准。驱动 reset／resync／buffer／rate／clock／latency 变化返回 paused 书签，避免变化后直接重新输出位流。

回调只消费预分配 ring 和发布 Timeline，不做文件 I/O、分配、锁、IPC、增益或分析。软件音量／DSP 请求需后续 Main 重规划；分析开启拒绝，后续只能使用独立 PCM 副本。

回调停止、生产者无 EOF 停滞、长时间无法获得一致计数、输入队列失败、源异常和打包异常都终止会话。读取计数快照短暂不一致时不发布伪零进度；两秒仍不一致终止。三秒没有 callback 或缺料且没有生产进展终止。驱动关闭确认后才取消并等待源线程，再关闭借用句柄；输入线程反复取消未决管道读取，最多两秒。任意关闭状态不能确认则进程退休，保留回调目标避免提前释放。

## 契约和后续验证

`src/shared/asio-dsd.ts` 校验请求、完整档案对象、原始存储几何／绑定、实际输出样本类型、固定 ring／scratch 容量、计划阶段、准备身份、状态／进度／单调计数、bit-tick 时钟、曲尾证据及精确重建书签。Native 不接受 NER8；DoP 只接受 24 位整数、32 位高位 24 或 SDK 右对齐 24 位的明确布局，大小端信息保持。

Main／Renderer 类型检查和构建通过（114模块，主块383.16 kB／gzip120.38 kB）；audio-host／waveform-worker／credential-vault／media-worker／system-media及既有金样程序编译、41个 CommonJS 语法检查通过。音频宿主在最终计数快照／头部复核／启动前驱动检查后重新编译；发行生成文件与分发清单（18个 npm运行依赖／5个 vendored组件）重新核对，源码另做 ZIP CRC核对。编译证据不代表播放、数值或架构门禁通过；未运行金样、真实文件、驱动、音频、SQL、应用或 UI，ASIO 实机继续按用户要求暂停。

MVP 检查必须覆盖 DSF／DFF 声道和位序、非字节末尾／非 16 位末尾、任意源位数跳转、DoP marker／静音／初始半区、文件范围变更、档案版本／速率／映射不符、计划未批准、预读取消／停滞、初始暂停／继续、旧回执／旧 generation、采样位置单位、曲尾／驱动失效及实际进程退出。Native、DoP、DSD→PCM 金样和真实设备分别记录证据。

下一步接入持久设备档案、确认流程、AudioController DSD 路由与 OS 退出监督、模式变更／音量重规划、独立分析副本和完整架构门禁。封面和播放详情实现继续保留。
