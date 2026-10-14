# ADR-072：WASAPI 驱动报告能力目录

日期：2026-10-02。源码 0.67.0；schema 36／音频 IPC 1.9／媒体协议 5 不变。状态：源码和编译完成，运行验证待 MVP。关联 FR08、WP01/WP02；不代表完整 OutputCapabilities 契约冻结或硬件门禁通过。

## 查询与显示

输出设置页增加“读取所选设备格式”，按明确端点查询。系统默认选项使用该次列表解析的默认端点，提示报告来自当前所选设备；真正播放仍重新解析默认端点。查询不修改设置、不初始化音频流、不启动播放。界面独立显示共享 mix format、驱动默认／最小处理周期、被驱动接受的独占 PCM 候选组合及部分查询失败状态。

共享格式来自 [GetMixFormat](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-getmixformat)，不推导为独占支持。[IsFormatSupported](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-isformatsupported) 按 exclusive 查询，只有 S_OK 标记 reported；AUDCLNT_E_UNSUPPORTED_FORMAT 标记 unsupported；其他结果为 error，不能把查询失败当成不支持。设备占用、独占权限和最终 Initialize 结果不由候选报告证明。[GetDevicePeriod](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-getdeviceperiod) 的 100 ns 单位以十进制字符串跨进程传递，界面转为毫秒；不是实际延迟测量，也不是完整 buffer 参数范围。

## 有界候选与证据

固定 wasapi-pcm-candidates-v1 矩阵：15 个采样率（8／11.025／16／22.05／32／44.1／48／88.2／96／176.4／192／352.8／384／705.6／768 kHz），1／2／4／6／8 声道，8／16／24／32 位整数、24 有效位的 32 位容器和 32 位浮点。扩展描述保留声道 mask 和 valid bits；单／双声道另查适用的 WAVEFORMATEX，合计 600 个独立描述组合。两种描述结果不能互相推导。

Main 核对完整矩阵、每行身份／状态／HRESULT 和回执协议／构建身份／nonce／指定端点；忽略未知候选的设计未采用，缺行、重复或改写组合直接拒绝整份报告。驱动只报告部分组合，不声称列出全部设备格式。没有依据 PCM 支持推导 DSD Native／DoP、声道 remap、整数端到端保持或数字输出认证。

报告带查询时间、driver-reported、hardwareVerified=false。驱动／固件版本目前为 null，因此不缓存为跨会话能力；刷新列表或改变设备会移除旧界面报告。完整能力缓存的驱动／固件身份、设备变化失效规则及跨平台仍需实施。

## 进程与边界

音频宿主增加独立只读 --device-info 模式，在单独 C++ 翻译单元使用 Windows SDK COM 接口；不在音频回调执行驱动查询。Main 先核对当前有界设备目录，再启动固定宿主。枚举与能力查询使用独立子进程，最多一个能力查询；同端点并发请求合并，另一端点并发请求明确拒绝，完成后不持有能力缓存。

回执 256 KiB、诊断 16 KiB、查询期限 25 秒，终止后最多等待 2.5 秒退出确认。只有完整结果且 close 成功才返回；未确认退出阻止新查询。沿用真实父 PID 校验和父退出守护；不是 OS 沙箱，也没有 Job 的 CPU／内存配额。设备失联／音频服务停止导致整次报告失败；其他逐项失败保留为 incomplete。查询结束再次检查端点 active，但不保证查询后设备没有变化。

关闭详情／输出设置不会主动取消已提交的查询，结果不再写入卸载组件；Main 期限与父退出守护仍有效。统一取消、Main 权限撤销和稳定文件／设备授权生命周期尚待实现。

## 验证与后续

本轮通过 Main、Renderer（67 模块）、原生音频／凭据／媒体编译、类型检查、发行／分发清单和相关脚本静态核对。没有执行查询进程、应用、数据库迁移、单元／金样／界面／硬件测试或制作安装包；ASIO 实机验证继续暂停。

MVP 验收覆盖：共享／独占返回区别、600 行矩阵完整性与描述差异、查询 error／不支持、设备断开／服务停止、查询中改变选择／刷新／关闭界面、超时／退出未确认／Main 退出、同设备合并／不同设备冲突、多窗口以及已播放状态下只读查询。完整缓存身份、动态默认设备通知、设备呈现时钟、参数协商错误分类、输出计划与 buffer 管理继续按架构实施。
