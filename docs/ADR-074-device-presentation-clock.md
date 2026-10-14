# ADR-074：设备报告位置、PCM 时间线与暂停重建

日期：2026-10-02。源码版本 0.69.0；schema 36、媒体协议 5 不变，音频 IPC 1.10。状态：源码与编译完成，运行／同步／尾部及音频质量验收待 MVP。关联 FR07/FR08/FR11、WP02/WP06/WP07/WP10；完整 AudioClock 契约和硬件门禁仍未通过。

## 位置依据

宿主在控制线程获取 IAudioClock 服务，使用 [GetPosition](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclock-getposition) 和 [GetFrequency](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclock-getfrequency) 成对解释设备计数，保留关联的 100 ns QPC 值；不能把设备计数直接当成 PCM 帧。GetService、读取和 Release 均在同一控制线程，回调与 IPC 输入线程不调用设备时钟。释放服务先于 miniaudio 设备／context 释放。

新 presentation-clock-v1 能力及 clock 事件对象区分：device-reported、callback-estimate、paused-bookmark。sourceFrame 是宿主当前完整可播放 span 内的 PCM 相对帧，包含恢复／seek 偏移，不是文件绝对帧；文件起点沿用初始 sourceStartPcmFrame。相邻 CUE 共用完整 span，Main 再按当前 CUE 边界换算曲目内位置。generation 与 Main 接收时间附加在经过验证的公开状态中；原始计数用 uint64 十进制字符串传递。

同采样率路径将设备位置换为回调帧坐标，通过时间线映射到真实源帧；只在精确 S_OK、未回退且映射有效时使用 device-reported。S_FALSE、失败、频率异常、回退、停止推进、时间线不可用或 SRC 未建模时使用 callback-estimate 并说明原因。没有把 S_FALSE 当成精确读数，也不据此停止正常音频。原始回调计数继续作为诊断存在。

数学映射的向下取整误差以 1 帧表示；不代表端点／DAC／模拟链路或 Windows 内部 SRC 的延迟误差已测定。hardwareVerified 始终为 false。Renderer 直接使用已验证位置，不跨进程外推 QPC；250 ms 状态发布仍带显示延迟。输出时钟精度、漂移、硬件定位与声画同步必须另行验收。

## 有界播放时间线

WASAPI 使用变长 callback，关闭 miniaudio 固定长度中间缓存。每次 callback 将请求帧数、有效音频数及源起点写入预分配的 8192 个 span（256 KiB）SPSC 队列；补零占播放时间而不推进源帧。回调不做 COM、锁、分配或 JSON。控制线程最多扫描 8192 项，消费已呈现区间；满队列不覆盖未读内容，退回估计并在下一次重建重置。

本批完成输入／内部输出同采样率路径，不把比率相除当作完整 SRC 时间线。miniaudio 输出 SRC／滤波延迟、Windows 引擎转换延迟、编码 delay/padding、DSD 低通延迟及后端实际提交失败／流不连续仍需纳入完整输出计划与提交记录。时钟停滞的 3 秒观察只触发估计状态，不是设备故障认证。

## 暂停、跳转、CUE 与尾部

miniaudio 的 WASAPI stop 会 Reset 并丢弃设备缓冲。本批暂停先取得最近选定的源位置，停止设备后重定位解码器、清空环形缓冲和时间线、预读并保持暂停，恢复从书签重建输出，避免直接跳过已消费但未呈现的整段队列。书签可能早于停止瞬间，可能重播至多一次控制采样间隔加停止耗时的音频；未声称暂停逐样本准确。时钟缺失／转换路径仍依据回调估计，精确暂停恢复继续完善。

暂停／seek 重建期间拒绝 snapshot／cancelNext／新 seek 的混合状态，完成时递增 generation，发布经过验证的书签。pause 不清除其他已接受 seek 的 pending 标记。只有 stop 成功后才重置 SPSC；停止失败导致会话错误。

在 device-reported 有效期间，CUE 身份事件和自然结束等待映射位置到达边界／尾部。回调边界仍控制预排撤销，Main 等待正式事件完成队列对账；暂停重建会重新设置边界状态。估计路径保留既有边界／结束策略，不能声称转换路径已经无缝或尾部完整。跨文件 gapless、正式输出计划、准确尾部 drain 及 CUE 呈现时钟历史继续实施。

## 宿主退出保护

播放模式启动新增真实父 PID 参数，沿用 parent guardian。Main 退出可终止阻塞于驱动读取的宿主；Main 仍有命令期限及旧宿主退出确认策略。维护既有 native IPC／播放 smoke 的启动参数，但没有执行它们。父退出保护不等于 OS 沙箱或 Job 的 CPU／内存配额。

## 检查与验收

原生音频／凭据／媒体组件、Main、Renderer（68 模块）编译，类型、发行／分发清单及维护脚本静态核对通过。没有执行应用、设备时钟、SQL／迁移、单元／金样／CUE／尾部／播放／界面／父退出测试或新安装包制作。ASIO 实机验证继续暂停。

MVP 覆盖：频率单位／QPC、S_FALSE／失败／回退／停滞、同采样率与转换路径、补零／时间线满、初始暂停／恢复位置、暂停和 seek 交错／重建快照拒绝、CUE 接近边界时暂停／撤销／跳转、短文件与尾部、旧宿主阻塞／父退出、进度与歌词同步、异常状态恢复及长时间播放。完整 SRC／实际提交映射、精确暂停、漂移／误差界、跨平台和硬件数字证据仍属后续研发与验收范围。

## 后续修正

0.70 的 [ADR-075](ADR-075-wasapi-submission-and-frozen-pause.md) 补充固定后端的真实行为：stop 会先 drain，0.69 最近采样书签可能重播该耗时对应的音频。0.70 新增成功提交水位、仅 passthrough 同率映射、停止后冻结读数和丢弃缓冲路径；完整转换／流不连续／精确暂停及尾部确认仍未验收。
