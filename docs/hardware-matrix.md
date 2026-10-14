# P0 音频设备矩阵（2026-09-29）

| 设备/路径 | 本机发现 | 已验证 | 待完成 |
|---|---|---|---|
| MOONDROP MOONRIVER 3 | USB `VID_35D8&PID_43DA`，Windows 音频端点状态 OK；MEDIA 类驱动由 Microsoft 提供，版本 `10.0.26100.9278` | 设备枚举；当前默认音频路径的软件回归不等于已锁定到此端点 | 记录固件及端点 ID；指定此端点做 shared/exclusive、重开、格式负例和数字捕获 |
| MOONDROP USB AUDIO ASIO4 | 系统 ASIO 注册，64 位 `ctasio64.dll` 文件版本 `6.2.21.414` | 官方 SDK 探针可实例化并取得名称/版本，但 `init` 拒绝且错误文字为空 | 查厂商驱动与 USB 端点映射及设置，再做 PCM、reset/stop/reopen、位数负例 |
| ASIO4ALL v2 | 系统 ASIO 注册，64 位 `asio4all64.dll` 文件版本 `2.22.0000` | 官方 SDK 探针初始化成功；双通道 44.1 kHz PCM 静音流 8 次回调、start/stop/dispose 成功，同时收到 reset 请求；通道名是 Virtual Speakers | 实现 reset/reopen，核实实际输出设备并播放可测 PCM；它不能充当第二类厂商硬件 |
| DSDTranscoder | 系统 ASIO 注册 | 仅驱动发现 | 区分驱动层与 DAC 实际能力；验证 Native/DoP、DSF/DFF、DSD64/128 与数字输出 |

MOONRIVER 3 的[厂商产品页](https://moondroplab.com/en/products/moonriver3)确认它是 USB DAC/AMP；该页面没有给出足以认定 Windows ASIO、Native DSD 或 DoP 链路已可用的文字证据。[ASIO4ALL 2.22 官方页面](https://zh-cn.asio4all.org/2-22/)将其定义为通用 Windows ASIO 驱动。探针结果见 [ADR-022](ADR-022-asio-sdk-probe.md)：目前没有证据证明应用已在 MOONRIVER 3 上进行 ASIO/DSD 播放或硬件数字输出捕获。G2 仍需要第二类代表性厂商设备和完整 reset/负例，G3 仍需要 Native 与已知 DoP 链路各自实测；G1/G4 的硬件验证也未通过。


## 2026-10-12：0.184 的 WASAPI PCM MVP

MOONRIVER 3／Windows x64 已实测全零 PCM16 双声道 44.1／48 kHz 原始独占、共享及允许转换独占、暂停后定位和模式切换；设备查询与实际打开格式均记录在 [本轮报告](validation/v0.184-wasapi-pcm.json)。原始路由不发生应用适配转换，hardwareVerified 仍是 false。转换路由本次为 f32／44.1 kHz 回调到 s24／96 kHz 设备格式，转换事实明确保留。这不是外部回环、DAC bit-perfect、长期稳定性或完整设备矩阵认证。ASIO 验证保持搁置，DSD Native／DoP 本轮未运行。
