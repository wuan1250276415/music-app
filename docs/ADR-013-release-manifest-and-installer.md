# ADR-013：发行 manifest 与 Windows 开发安装包

状态：0.8 原型已实施；本机安装、运行、卸载及隔离目录相邻版本升级已验证，远程 CI 尚未运行。

## 决策

`release/manifest.json` 是应用 ID、版本、音频协议 major/minor、最大帧长度及 Main/Audio Host 构建 ID 的单一来源。`scripts/generate-release.cjs` 同时生成 TypeScript 与 C++ 常量；构建前生成，契约检查以 `--check` 拒绝陈旧文件。Main 与 Host 在握手时互验构建 ID，避免安装包混入不同版本的宿主。`package.json` 版本必须与 manifest 一致。

Windows x64 开发安装包使用固定版本的 electron-builder 26.17.0 和 NSIS。`dist` 中的 Electron 应用封入 asar，原生 `audio-host.exe` 作为独立资源放在 `resources`；打包版 Main 从 `process.resourcesPath` 定位宿主。原生宿主以 `/MT` 编译，避免开发安装包要求单独部署 MSVC 运行库。NSIS 使用可选安装目录的每用户安装模式。此包未签名，也没有自动更新；不得作为正式发行版。

`.github/workflows/windows-contracts.yml` 提供 Windows x64 的依赖安装、manifest 检查、类型检查、协议/业务测试和开发安装包构建步骤。当前目录尚不是 Git 仓库，因此工作流是待接入模板，不能宣称云端 CI 通过。

## 本机验证

2026-09-28：`npm run verify:contracts` 通过（10 项单元测试、2 项原生 IPC 冒烟）；`npm run package:win` 生成 NSIS 安装器。由于下载 NSIS 工具资源的网络连接超时，构建时使用本机已缓存、与工具声明版本一致的 NSIS 3.0.4.1 与 resources 3.4.1 目录完成安装器生成。打包当次的 `resources/audio-host.exe` 与输入宿主 SHA-256 一致；后续独立重编译产生不同二进制哈希，位级可复现构建尚未建立。

安装器静默安装到工作区测试目录后，从安装目录运行 CUE 曲库、中文搜索、歌词、共享/独占播放、暂停/继续、快速切歌和队列恢复回归，随后静默卸载成功。0.5.0 安装器 SHA-256：`1EF098A1DFC915FA48D840AEEC7A47CFAD110848CDB468C76E2E2592093E304B`。

2026-09-29：在独立测试目录安装 0.6.0，建立两首 CUE 曲目及持久化队列，并完成 shared/exclusive 播放。随后将 0.7.0 原位安装到同一目录，确认安装文件内 manifest 为 0.7.0、旧曲库与队列保留、可继续播放，最后静默卸载。0.7.0 安装器 SHA-256：`71BC6D453EE6BCBAD78A3C3ED8CBC44E3F99A890A976D5312C2C0769BCB6A9D5`。测试仅覆盖当前 Windows x64 机器和这组隔离数据；代码签名、其他 Windows 版本、旧版本组合及真实用户曲库迁移仍待 WP11。

同日，独立目录再次完成 0.7.0→0.8.0 原位安装；由 0.7.0 创建的 v2 曲库在 0.8.0 启动时迁为 v3，生成 `pre-v3` 一致备份，两首 CUE 条目、持久化队列及继续播放通过，随后静默卸载。0.8.0 安装包在加入原生金样构建后重新生成，最终 SHA-256：`1734708B05FBDB5AF1A8F06E500A1504F56487CC3480720648FE37C55B4E931C`。这不能替代真实用户曲库和其他 Windows 版本的升级演练。
