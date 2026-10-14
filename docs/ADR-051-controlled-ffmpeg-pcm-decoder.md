# ADR-051：受控 FFmpeg PCM 解码适配

日期：2026-10-01；源码 0.46.0；schema v24、音频 IPC 1.7 不变。对应 FR01、WP01/WP02/WP11。此记录只证明源码接入与编译，不宣布格式或设备认证通过。

## 决策与范围

保留已有 miniaudio FLAC/WAV/MP3 路径，扩展独立音频宿主的 `AuralPcmDecoder`。现有解码失败后尝试受控 FFmpeg；仅注册 AAC、ALAC、Vorbis、Opus 解码器与 AAC、MOV、OGG 解封装器。Main 接受 M4A/AAC/OGG/OGA/Opus 扩展名作为候选，最终以宿主探测的内容与注册解码器为准，不能仅凭扩展名声称兼容。扫描补 OGA。

FFmpeg 8.1.3 取自[官方镜像的固定提交](https://github.com/FFmpeg/FFmpeg/tree/1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7)，归档 SHA-256、tag 对象及 commit 固定于 `native/ffmpeg/lock.json`。`vendor/tag-verification.json` 是 GitHub API 的 verified/valid 断言，并非本机 GPG 验签。初次官网下载遇到证书问题后改用镜像的有效 HTTPS，没有关闭 TLS 验证。

四个共享库为 avutil-60、swresample-6、avcodec-62、avformat-62。禁用网络、自动外部依赖、程序、编码器、封装器、硬件加速、avdevice/avfilter/swscale；配置声明 LGPL 2.1 or later。完整上游压缩源码、许可证、固定替换补丁、构建脚本与编译清单随源码归档和后续安装资源提供，详见 [SOURCE.txt](../native/ffmpeg/vendor/SOURCE.txt)。第一方补丁分别检查 MOV 声道布局解析返回值、在禁用 AC3 的 AAC parser 中拒绝 AC3 分支，文件前后 SHA 与唯一替换检查由 prepare.py 执行。

## 宿主边界

FFmpeg 类型只留在原生适配层。库延迟链接，首次使用从宿主可执行文件的绝对同目录加载，依赖搜索限制到 DLL 所在目录与 System32，核对 major ABI；库在进程生命周期内固定，不搜索当前工作目录或 PATH。已有路径不应依赖 FFmpeg 初始化成功，但仍需 MVP 验证缺库负例。

适配器持有只读 Windows 文件句柄，支持扩展长度路径与 UNC；custom AVIO 读取／定位使用同一句柄，禁止容器嵌套打开外部资源。限制流数、探测量、内部分配、包和帧规模；取消标志与 20 秒工作期限进入读取和解封装回调。同步 ReadFile 本身仍可能被故障网络盘阻塞，不能把 interrupt callback 解释为强制中断，现有 Main 超时与进程终止仍是隔离边界。

默认输出浮点 PCM。ALAC 可在独占请求下选择原生 S16/S32 整数平面交织，不在适配器内改采样率／声道布局；swresample 仅负责平面与交织及显式样本表示转换，检查转换帧数和零延迟，拒绝非有限浮点样本。所有已知声道位置传给输出层，未知／ambisonic 布局拒绝而非猜测。设备拒绝原生参数时仍按已有“允许转换”设置处理，不自动把路径标为 bit-perfect。24 位 ALAC 的 S32 容器与有效位、设备接受程度须有金样和捕获证据。

libavcodec 处理编码延迟与尾部 padding，不做第二次裁剪。seek 采用向后两秒预滚、清空 codec/SWR、利用帧时间戳恢复相对首个解码帧的采样位置，丢弃到目标；缺失／不合法时间戳或越过目标拒绝。ADTS 时钟、Opus 预滚、AAC edit-list、末尾 seek、多声道和损坏文件仍需 MVP 金样。没有精确解码长度证据时不把容器 duration 转成精确 PCM 长度，库中估算时长仍用于界面。

解码错误与自然 EOF 分开，错误经控制线程报告，设备回调继续只消费有界 PCM 环。seek 先停止旧生产者，再清除停止标志执行定位和启动新生产者；错误不会伪装成正常播完。切轨范围、队列与分析旁路使用既有机制，相关无缝与分析负载尚未执行。

## 界面、构建与交付

playing 事件增加可选 decodedSource，Main 检查后向详情提供后端、实际 codec、PCM 格式、采样率与声道数，认证值保持 pending；现有 IPC major/minor 不变。该数据来自实际打开结果，不从扩展名推断。旧宿主不发此字段时不显示。

现有 VS 2017 C++ 工具不具备此版本所需 C11 编译能力；受控构建将固定 SHA 的 LLVM 20.1.8 解压到隔离 build/tools，不运行安装器。GNU Make 4.4.1 由现有 VS 编译并启用 Git Bash shell。首构建需要完整 7-Zip、Git for Windows、Python、VS C++/SDK；缓存核对 recipe、头文件／库／配置哈希后复用。MSVC link 使用绝对路径，依赖输出由单独 AWK 程序解析。开发工具不随应用或源码归档的 build 目录分发；重新获取入口与 SHA 留在脚本中。完整工具安装流程不是跨机器已验证结果。

build-manifest 保存源码、recipe、注册列表、DLL 大小／SHA 与 unverified 状态，不替代架构要求的金样 `MediaCapabilityManifest`。构建原生组件后生成 SBOM/notices，核对四库与宿主旁副本。electron-builder 配置将四库放在 audio-host 同目录，同时复制 ffmpeg-source；后续解包校验核对源码、recipe、库与清单。当前没有生成或验证 0.46 安装包。

## 本轮证据与待验收

类型检查、主进程、界面 54 模块、四个 FFmpeg 库、audio-host/CUE gold/PCM ring gold/waveform/凭据组件编译通过，发行／分发清单及脚本语法静态核对通过。PE 静态依赖检查显示宿主将四库延迟加载，四库其余导入为 KERNEL32/bcrypt；未加载库验证。没有运行单元、媒体解码、随机 seek、播放、SQL 迁移、界面、网络 Provider 或安装器。

整曲波形仍只支持 FLAC/WAV/MP3；后续需要把扩展解码接到同句柄内容核验的分析进程。AAC/ALAC/Vorbis/Opus 格式金样与能力清单、DSD PCM/Native/DoP、完整 CUE、跨文件无缝、设备捕获和 FR01–FR14 剩余项继续保留；ASIO 实机验证按用户要求搁置。最近已验证安装包仍为 0.29.0。
