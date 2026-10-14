# ADR 009 原型阶段的数据库和音频适配器

状态：原型决策，V1 前复审。日期：2026-09-28。

为尽快验证 Electron UI、曲库和原生音频进程的纵向流程，P0 使用 Electron 44 内置 Node 24 的 `node:sqlite`，避免当前阶段维护第三方原生 Node addon；音频宿主使用固定 miniaudio 0.11.25 读取 FLAC/WAV/MP3 并输出 WASAPI shared/exclusive。两个适配器都藏在 LibraryDatabase 与 AudioController/Audio Host 的边界后。

这不是对长期生产依赖的最终选择。Node 官方对所用 `node:sqlite` 版本标为 release candidate，需在 V1 前检查 API 稳定性、十万库性能、备份能力和运行时升级。miniaudio 的 float32 解码路径不能满足整数样本直通、ASIO、Native DSD 或 DoP 的完整需求；P0 只验证独立进程与 WASAPI 设备通路，后续输出接口按架构文档替换或扩展。

复审触发条件：G1–G5 原型结果、打包/许可证审查、数据库绑定升级、十万库测试或新增平台。切换适配器时必须保留公开领域契约，新增可重复的回归测试和数据库迁移，不直接编辑用户的旧 schema。

参考：[Electron 44 的 Node 版本](https://www.electronjs.org/blog/electron-44-0)、[Node SQLite 稳定性](https://nodejs.org/download/release/v24.18.1/docs/api/sqlite.html)、[miniaudio 官方源码与许可](https://github.com/mackron/miniaudio)。
