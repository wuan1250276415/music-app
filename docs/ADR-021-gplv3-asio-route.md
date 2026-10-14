# ADR-021：Aural 的 GPLv3 与 ASIO SDK 路线

状态：发行方式与官方 ASIO 2.3 SDK 接口已选定；完整宿主和 G2 尚未验收。

2026-09-29 产品方选择 Aural 以 GPLv3 开源。工程将应用自身许可固定为 `GPL-3.0-only`，根目录 `LICENSE` 保留 [GNU GPL 第 3 版原文](https://www.gnu.org/licenses/gpl-3.0.txt)，安装包放入 `resources/AURAL_LICENSE.txt`，源码归档同时提供应用源码和许可证。第三方组件继续按各自许可保留 notices，不能因应用采用 GPLv3 就覆盖它们原有的声明。

[Steinberg 官方公告](https://ocl-steinberg-live.steinberg.net/_storage/asset/808575/storage/master/Press%20Release%20-%202025-10-15%20-%20OBS%20Partnership-%20EN.pdf)确认 ASIO 技术增加 GPLv3 与专有双路线。Aural 已从[官方开源页面](https://www.steinberg.net/developers/asiosdk-open/)固定 ASIO 2.3 接口文件，逐文件核对嵌入许可与哈希并纳入 SBOM/notices；详见 [ADR-022](ADR-022-asio-sdk-probe.md)。当前没有把第三方镜像或系统已安装的 ASIO 驱动 DLL 复制进项目或安装包；驱动仍由用户设备厂商/ASIO4ALL 自行安装。SDK 的标志/商标没有用于产品界面。

开源决策和接口锁定不等于 G5 或 G2 自动通过。下一步在隔离 ASIO 宿主中实现真实 PCM 播放、reset/stop/reopen 和负例，再在 MOONRIVER 3 厂商驱动、ASIO4ALL 兼容路径及第二类厂商设备上保留实测证据。DSD Native/DoP 另行验证。
