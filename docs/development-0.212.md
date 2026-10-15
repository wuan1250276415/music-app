# 0.212.0 开发与验证记录

本版本后台识别源码已完成集中MVP验证，详见 [ADR-219](ADR-219-background-audio-recognition-and-durable-stages-mvp.md)。核心23项、实际Electron11项通过，迁移和既有元数据回归通过；仍不代表完整V1或正式安装发布验收。

此前同步代码时，桌面验证在10项通过后等待超时，原记录 [v0.212-recognition-ui-incomplete.json](validation/v0.212-recognition-ui-incomplete.json) 保留。后续从截图和请求记录确认：识别本身已完成，取消操作使用了界面滞后的修订号。修复后续办和取消通过，当前成功记录见 [v0.212-recognition-ui-final.json](validation/v0.212-recognition-ui-final.json)。

最新可试用安装包仍0.201.0。整库无人值守跨页、长时间续审及其余架构功能继续推进；仅ASIO实机验证暂停。
