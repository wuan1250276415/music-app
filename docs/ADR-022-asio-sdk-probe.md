# ADR-022：ASIO SDK 固定与隔离探针

状态：0.17.0 P0 探针完成；G2 尚未通过。

## 接入边界

从 [Steinberg ASIO 开源页面](https://www.steinberg.net/developers/asiosdk-open/)提供的[官方 SDK 入口](https://www.steinberg.net/asiosdk)下载 ASIO 2.3 ZIP；本次归档 SHA-256 为 `D5EBF0C20DD2C5F43771FD0C1418F4B361BF52434EE670097CFA6B3A335E2ECA`。只逐字节提取 `asio.h`、`asiosys.h`、`iasiodrv.h` 和根许可文件，具体文件哈希见 `native/asio-probe/vendor/SOURCE.txt`。三个接口文件均指向根许可证，项目选择 GPLv3 路线；SDK 中另有独立许可的 host helper/sample 代码，本次未复制。SBOM、notices 和安装包同时纳入所选接口及许可。

探针是独立进程，不在 Electron 或 WASAPI 宿主内加载未知驱动。`--list` 仅读取 64 位 ASIO 注册表；`--inspect NAME` 精确匹配注册名并在隐藏自有窗口下初始化、查询通道、格式、缓冲和采样率；`--silence NAME` 仅在已验证为双通道 PCM 格式时创建双缓冲，以零样本执行 500 毫秒 start/stop/dispose。回调只清零固定缓冲并增加计数，不分配内存或调用 IPC。驱动提出 reset 请求时记录并返回未接受，不能伪称已完成 reset/reopen。测试运行时使用外部超时，避免故障驱动长期阻塞研发流程。

## 本机结果与下一门槛

`ASIO4ALL v2` 初始化成功，报告 2 路输出、44.1 kHz 当前采样率、首选 512 帧和 `ASIOSTInt32LSB` 双通道；静音流完成 8 次回调，start/stop/dispose 均返回成功，同时收到 reset 请求。输出通道名为 `Virtual Speakers 1/2`，尚未核实映射到 MOONRIVER 3，不能认定为该 DAC 的 ASIO 播放或数字输出验证。

`MOONDROP USB AUDIO ASIO4` 可通过 COM 实例化并返回驱动名/版本，但 `init` 拒绝且错误文字为空；改用自有隐藏窗口后仍相同。不能由此推断设备、驱动或应用中的哪一方有故障。下一步检查厂商驱动与 USB 端点的匹配、占用和驱动设置，再补 reset/stop/reopen、真实 PCM 流及位数负例；第二类厂商设备仍未具备。

0.17.0 本机回归为 24 项单元、4 项原生 IPC/金样、2 项 ASIO 探针 CLI 及 16 项串行音频测试通过。NSIS 安装目录中的 `resources/asio-probe.exe` 与构建产物 SHA-256 一致；安装版 `--list` 与 ASIO4ALL 静音流复现上述结果。桌面版 3 秒 Renderer 压力测试为 289 次回调、0 个补零帧；静默卸载退出码 0 且主程序已移除。发行目录产生 10 个 EXE/DLL 的哈希报告。以上不包含厂商 DAC 数字捕获或真实 ASIO 音乐播放。
