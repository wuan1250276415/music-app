# ADR-020：0.16.0 分发清单与 G5 审查边界

状态：清单生成与安装包核验通过；G5 仍未验收。

## 决策

`scripts/generate-distribution-inventory.cjs` 从锁文件筛出 17 个运行时 npm 依赖，并读取本地安装包的许可声明和原文；对缺失许可原文、版本漂移或锁文件漂移直接失败。`@tokenizer/token` 的 MIT 原文位于 README 的 Licence 节。原生宿主的 miniaudio 0.11.25 和 nlohmann/json 3.12.0 通过 `vendor/SOURCE.txt` 中的固定 SHA-256 核对，并按项目已选的 MIT-0/MIT 路径纳入 notices。生成的 `release/sbom.cdx.json` 和 `release/THIRD_PARTY_NOTICES.txt` 随安装包放在 `resources` 目录；Aural GPLv3 全文为 `resources/AURAL_LICENSE.txt`；Electron/Chromium 的许可原文沿用 Electron 发行目录的 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`。

SBOM 范围是锁定的运行时 npm 依赖闭包、Electron 发行版和两个原生头文件；npm 组件可能被打包器裁掉类型文件。它不声称所有锁文件构建工具都随应用分发，也不把网页服务数据许可混入软件组件许可。当前没有引入独立 FFmpeg、TagLib、ASIO SDK 或 DSD 解码器；Electron 自带的 `ffmpeg.dll` 已列入二进制哈希报告，但它不等同于项目自行选定的 FFmpeg 构建。

`scripts/verify-unpacked-release.cjs` 检查安装目录预制包中的清单、notices、Aural GPLv3 全文、原生宿主、Electron/Chromium 许可文件以及 ASAR 内的应用版本和发行 manifest，输出安装器和所有 EXE/DLL 的 SHA-256 报告。`verify:contracts` 的 `--check` 防止修改依赖后沿用旧清单；`package:win` 在打包后执行发行目录核验。

## 0.16.0 本机证据

24 项单元测试和 4 项原生 IPC/金样通过。Windows x64 未签名 NSIS 开发包已生成，发行目录内清单与源码哈希一致，共记录 9 个 EXE/DLL 哈希。静默安装后，`resources/sbom.cdx.json`、`resources/THIRD_PARTY_NOTICES.txt`、`resources/AURAL_LICENSE.txt`、`resources/audio-host.exe` 均与构建源文件 SHA-256 一致。最终安装版 3 秒 UI 压力测试记录 288 次音频回调、0 次/帧补零。静默卸载退出码为 0，安装目录内的 `Aural.exe` 已移除。

本清单提供可复核证据，不构成法务或商业发行批准。G5 仍缺 ASIO/DSD 路线的 SDK 选定与许可、驱动发现和实机认证；正式发行还需签名、更新和渠道条款审查。

上游 [miniaudio 0.11.25 WAV BEXT 元数据读取问题](https://github.com/mackron/miniaudio/issues/1101) 涉及 `*_with_metadata` 路径。当前宿主调用 `ma_dr_wav_init_file_w` 和 `ma_decoder_init_file_w`，未启用该元数据接口；这只是当前代码路径检查，不代表对所有恶意媒体完成安全验收。未来若启用原生元数据读取，必须先更新或修补固定版本并做畸形 WAV 回归。
