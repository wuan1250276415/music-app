# ADR-016：PCM 整数输出计划与显式回退

状态：0.11.0 Windows WASAPI 原型已实施应用内整数路径及显式转换策略；G1 的数字输出捕获和跨设备验收仍未通过。

## 决策

Host 在独占模式下直接检查媒体头。16-bit PCM WAV、16-bit FLAC 选择 `s16`；24-bit FLAC 选择左对齐到 32-bit 容器的 `s32`。其他格式及共享模式继续选择 float32。解码线程与 WASAPI 回调之间的环形缓冲按实际 PCM 帧字节数存放原始数据，回调仅复制字节或填充静音；预读同时受两秒和 32 MiB 上限约束。

打开独占设备后，只有当回调格式、WASAPI 内部格式、声道数和采样率与整数解码计划完全一致，才保留整数路径。0.11.0 起独占模式分为“原始格式”和“允许转换”：前者遇不匹配或设备拒绝源整数格式时停止并提示用户；后者才重新打开 float32 解码与输出，明确报告回退原因。对其他源格式，原始格式档位同样要求回调与设备的格式、声道、采样率一致。共享模式始终是兼容播放路径。`actualOutput` 分别给出回调格式、设备格式、两侧采样率/声道数、`allowConversion`、`applicationIntegerPath`、`adapterConversion` 和 `hardwareVerified:false`。界面以可见状态提示转换，悬停显示完整输出报告。

这是应用内处理链选择，不是硬件位完美认证。miniaudio 和 WASAPI 之后仍可能存在设备缓冲、驱动或端点处理；只有数字输出捕获及设备组合验收完成后，才能把 `hardwareVerified` 改为 true。

## 验证与限制

固定金样对 16-bit WAV、16-bit FLAC 的 `s16` 与 24-bit FLAC 的 `s32` 解码结果逐样本比较，覆盖前后 seek；后者的低 8 bit 为容器填充位。本机 WASAPI exclusive 的 48 kHz 双声道 16-bit WAV 报告 `s16`→`s16`、相同采样率/声道数、`applicationIntegerPath:true`、`adapterConversion:false`。同一设备播放 44.1 kHz WAV 时，设备内部为 48 kHz；Host 回退为 float32，并报告采样率转换。两种情况都标记 `hardwareVerified:false`。

0.11.0 的本机串行测试覆盖 44.1/48 kHz 双声道 16-bit WAV 的两种策略：44.1 kHz 严格档位拒绝不匹配，允许转换档位报告回退；48 kHz 在设备协商为 `s16` 的运行中保留整数路径。设备内部格式在不同测试运行间出现过 `s16` 与 `s32`，因此这些实测结果不能推广到所有启动条件或设备。桌面回归验证拒绝提示和转换后继续播放。尚未完成 24-bit 整数路径的真实 DAC 验证、ASIO 格式协商、不同设备/驱动组合、数字输出逐样本捕获和连续曲目无缝播放。G1 因此仍未通过。
