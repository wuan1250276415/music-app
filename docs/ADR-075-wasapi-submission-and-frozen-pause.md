# ADR-075：WASAPI 成功提交记录与冻结暂停位置

日期：2026-10-02。源码版本 0.70.0；schema 36、媒体协议 5 不变，音频 IPC 1.11。状态：源码实现与静态编译；实际暂停／同步／尾部与故障恢复待 MVP。关联 FR07/FR08/FR10/FR11、WP02/WP06/WP07/WP10。完整输出时钟门禁仍未通过，ASIO 实机验证继续暂停。

## 纠正 0.69 的位置前提

检查固定版本 miniaudio 的 WASAPI 源码发现：onDeviceWrite 返回的帧数包括复制到 GetBuffer 包但尚未 ReleaseBuffer 的部分；原实现忽略 ReleaseBuffer HRESULT。其 stop 会先提交未满包并等待缓冲播放，再调用 Stop／Reset。因此 0.69 使用停止前最近控制采样定位的重播范围还包括后端 drain 耗时，并不是精确暂停。

本批在项目源码增加 wasapi-submission.hpp，以 context 的 blocking onDeviceWrite／onDeviceStop 接入。使用固定版本 miniaudio 的 ABI 和内部 WASAPI 调用包装；不修改 vendor/miniaudio.h，不改变其已有来源锁与哈希。这是明确受固定版本约束的适配层，升级 miniaudio 时必须复审生命周期／工作线程／缓存字段和设备调用，不能视为通用扩展 API。

## 成功提交与错误

写入保留原共享周期／独占整缓冲 GetBuffer、部分包复制、事件等待及停止检查。仅完整 ReleaseBuffer 返回 S_OK 时推进 committedDeviceFrames；已复制但未提交的包不计入成功范围。Release 失败、无效容量、计数溢出及等待失败使 submissionValid=false，宿主停止会话；不把未知提交继续当作精确时钟。写入线程不创建 JSON／分配／加应用锁，只有缓存复制、后端调用／有界事件等待和原子诊断。

提交帧数是当前 Start／Reset 周期中的设备帧数，独立于解码源帧、回调源帧和文件起点。同率且 miniaudio converter.isPassthrough 时，将设备计数按频率换算，只有位置不超过成功提交范围、时间线可映射和源位置不回退时才标注 device-reported。格式／声道转换即使同率也暂时回退 converter-mapping-pending；SRC 使用既有 src-mapping-pending。此限制避免在尚未证明转换缓存／滤波延迟时宣称直接映射正确。

单一提交水位并不建模 Windows 引擎插入的欠载静音／流不连续，也不证明设备在模拟端何时输出。仍需实际提交 span、引擎欠载／重启记录、转换输入输出与延迟、漂移及完整误差界。1 帧仅表示数学向下取整，不表示整体声音延迟；hardwareVerified 永远 false。

## Stop → 冻结读数 → 清理 → Reset

暂停、用户停止及播放中 seek 使用明确 discard 路径：在 miniaudio worker 已离开数据循环后调用 [IAudioClient::Stop](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-stop)，不先 drain。Stop 成功后读取冻结的 IAudioClock，再释放未满包并 [Reset](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-reset)。

独占事件驱动不允许零长度释放已取得的整包，依据 [ReleaseBuffer](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudiorenderclient-releasebuffer) 契约，停止后将未满包补全静音并整包释放，再 Reset 丢弃；这期间不 Start。冻结读数保留释放这个未播放包之前的提交水位，不能使用事后增大的成功计数来放宽冻结位置的检查。

冻结读数的临时 GetService／GetFrequency／GetPosition／Release 都在同一个 worker 上完成，不跨线程使用控制线程持有的时钟服务。控制线程等待 ma_device_stop 完成后，通过发布／获取标记读取冻结结构，映射源书签，随后按旧逻辑重定位解码器、重建环形缓冲／SPSC 和 generation、预读并保持暂停。

miniaudio 同步后端的 ma_device_stop 会在 worker 结束后返回成功，而不传播其 onDeviceStop 错误。本适配层另存后端结果，stopDevice 必须同时核对它；失败不允许发布暂停／seek 成功或重启。对失败后的包做 worker 上的清理尝试，仍保留失败，不把清理尝试认定为恢复。Reset 的 pending 重试最多 5 次，每次 10 ms。COM／驱动调用本身可能阻塞，继续由 Main 命令期限、确认旧宿主退出与父退出 guardian 管理。

有效冻结映射会生成 device-frozen 暂停书签；读数不精确、映射不可用或转换路径则保留最近位置并标记 recent-position，不能保证不重复或跳过音频。初始暂停和显式 seek 标记 requested-position。EOF 使用已有最后可播放帧钳制，可能重播最后 1 帧；这仍不是逐样本暂停或 DAC 延迟认证。

若停止瞬间跨过预排 CUE 边界，先发布旧 generation 的 cueBoundary，再发布新 generation 的 paused，保证 Main 曲目身份和队列对账先于书签重建。普通自然结束保留固定后端的 drain，新增未满包的成功检查；结束事件与 drain 完成确认、短文件／转换尾部的正式计划仍待完善。

## 契约与界面

新的 presentation-clock-v2 能力、16 字段原始 clock 对象及 IPC 1.11 配对使用。新增 deviceSampleRate、committedDeviceFrames、submissionValid、bookmarkBasis；保持十进制 uint64 字符串、QPC、频率、源帧与回调帧分离。Main 校验实际设备采样率、对象字段数、证据组合、成功提交范围与书签依据，再附加 generation／接收时间。冻结报告允许 same-rate-frozen 原因。

播放详情说明书签来自冻结设备、最近位置或用户选择；转换和超出提交范围时仍显示估计原因。继续保留内嵌封面优先、点击播放栏封面打开详情、歌手／专辑／风格检索、滚动歌词／点行跳转、模式和播放列表功能。进度与歌词继续复用经 Main 校验的位置，没有新增界面运行或真实文件验证。

## 检查边界与 MVP 验收清单

本批只做类型、Main、Renderer 和原生编译、发行／分发清单及维护脚本语法、源码归档 CRC 静态核对。不执行应用、音频、设备、SQL／迁移、单元／金样／UI／安装包测试，不生成新安装包；最新已验证安装包仍为 0.29.0。

MVP 集中验证：共享／独占部分包与 Release 失败；复制计数和成功提交水位；停止工作线程错误回传；冻结前后水位／S_FALSE／GetService 失败；暂停／resume／seek／stop 交错和初始暂停；EOF 及很短文件；跨 CUE 冻结位置、边界队列对账和取消预排；SRC／格式转换回退；断开设备、卡住的驱动、父退出；进度与歌词同步以及长时间欠载。完整 SRC／实际 span 提交映射、流不连续与漂移、准确尾部 drain、呈现历史及跨文件 gapless 继续研发，完整 FR01–FR14／WP01–WP11 范围不缩小。
