# ADR-079：PCM 增益与 ReplayGain 处理计划

日期：2026-10-02；源码 0.74.0；schema v37、音频 IPC 1.14、媒体协议 6。

## 架构要求与实现

架构 §13.1、§14.1 要求首版数字音量与可选 ReplayGain、处理节点／增益／转换的明确计划，以及原始整数与 DSD 直通路径的隔离。本次实现 WASAPI PCM 和已有 DSD 转 PCM 路径的静态会话增益；没有完成全部 PlaybackPlanner、DSD 原生／DoP 或跨文件 gapless。

输出设置增加 `processing={volumeDb,muted,replayGain,preampDb,preventClipping}`。音量范围 −60 至 0 dB，ReplayGain 关闭／曲目／专辑，预增益 −12 至 +12 dB。默认 0 dB、非静音、ReplayGain 关闭、防削波开启；预增益只在实际选到 ReplayGain 标签时生效。保存沿用同一修订 CAS、不可变操作回执、旧宿主退出确认和串行重新打开；修改音量目前也需要“保存并切换”，会中断设备，保留位置／暂停状态，尚非平滑实时音量。

启用音量、静音或 ReplayGain 时强制 f32 解码，在 Decoder producer 每块最多 2048 帧内、ring 发布前处理。回调没有新增 DSP／分配／锁。原始格式 exclusive 在 Main 与 Native 均拒绝增益；需要明确选择 shared 或允许转换的 exclusive。不会把经过增益的播放标为应用整数路径。已有 DSD 转 PCM 的转换档位增益 0 dB 保留，增益节点在其后单独记录；Native／DoP 仍未接入。

## 标签、范围与单位

媒体协议 6 在已有监督标签读取中返回五字段 `ReplayGainTags`：source、trackGainDb、albumGainDb、trackPeak、albumPeak。读取 music-metadata 的 gain.dB 与 peak.ratio；不把其 power ratio 转换函数当作音频幅度。接受有限 gain −60 至 +60 dB、peak 大于 0 且不超过 64，非法／缺失字段置 null，不自动计算响度。

schema v37 增加可空 `media_file.replay_gain_json`；旧库 null 在下一次扫描进入标签补读，新解析即使无标签也保存完整空值对象。列表／单曲／队列读取均投影。CUE 使用已保存 REM：文档专辑值、音轨值；文档缺少专辑值时可沿用文件专辑标签，拒绝把整张镜像的 TRACK 值作为每个 CUE 音轨增益。重复有效键作缺失处理，峰值不接受 dB 单位。专辑模式缺少 album gain 时使用 track gain 并明确说明，二者均缺失时只保留音量、不加预增益。

Main 在使用已保存 ReplayGain 观察前，做五秒有限等待的源文件 size／mtime 属性复核；变更时要求重新扫描。该属性检查不是内容摘要，也不封闭检查与原生解码打开之间的路径竞争，OS I/O 不能在此强取消；完整 MediaSource 同句柄／授权生命周期与标签内容绑定继续开发。CUE REM 原文与相应 sourceHash 已保存，但本次没有逐次重新核对 CUE 文档。

Opus 原生解码器可能已处理 OpusHead gain，R128 与传统 ReplayGain 的参考电平不同；本次对实际探测为 Opus 的音源不叠加 ReplayGain，返回 `opus-gain-policy-pending`，数字音量仍可用。R128／头部／传统标签完整合并与 provenance 属后续原范围，不宣称 ReplayGain 全格式完成。[Xiph Opus 格式说明](https://wiki.xiph.org/OggOpus)

## 数值计划与处理

requestedGainDb = volumeDb + 实际选择的 gainDb + 已选择标签时的 preampDb；幅度 scale = 10^(gainDb/20)。开启防削波时，用 −20·log10(peak) 限制增益；缺少 peak 时以 1（数字满幅）为基准。静音最终 scale = 0。音频幅度与峰值定义依据 [ReplayGain 播放缩放](https://replaygain.hydrogenaudio.org/player_scale.html)和 [峰值存储](https://replaygain.hydrogenaudio.org/peak_data_format.html)。标签峰值只提供调整依据，不保证真实峰值或采样间峰值。

处理将非有限源／结果置零；防削波开启时将超出 ±1 的源处理结果硬限幅，关闭时保留可表示的浮点超满幅值（后续格式转换／设备仍可能削波）。未提供动态 limiter；dither 策略明确为 none，后续降位深抖动和 SRC／声道混合后的峰值策略仍需完善与音质验证。不能将源样本防削波等同最终设备、SRC 采样间峰值保证。

两段相邻 CUE 预排分别携带标签。Producer 按 sourcePosition 与 boundaryRelativeFrame 拆分同一块，使用各段静态计划；暂停／seek 重建 producer 后按 positionBaseFrames 选择。Main 的歌曲身份变化和计划回执通过同一 CUE 边界事件发布；Native reportedGainSegment 与快照在 Channel 写锁下切换，避免新计划先于曲目身份发送。

IPC 1.14／gain-processing-v1 返回版本化十六字段 ProcessingPlan：设置、标签、启用、选择／回退原因、峰值／依据、请求与有效 dB、scale、保护限额、样本／无效值／dither 策略及 hardwareVerified=false。Main 根据会话设置／实际 codec／当前 CUE 标签独立重算并逐字段核对，拒绝未按 f32 或应用整数路径执行的启用处理。暂停／恢复／seek／快照均带计划；250ms 位置回执带 uint64 源处理限幅／无效值累计计数，Main 检查结构／范围／单调性。计数包含解码预读，不等于 DAC 已呈现样本。

## 持久化与兼容

schema v37 先做迁移备份，再事务增加列与版本；旧应用拒绝新版库。输出设置沿用 JSON 表，无修改历史回执：历史省略 processing 的请求／值规范为默认关闭状态，再做语义匹配；显式 null／无效设置不接受。新保存完整处理设置并将其纳入回执匹配。未知提交仍阻止播放并核对原操作，不自动重启或改设备。

## 验证边界

只做类型、Main／Renderer／Native 构建、发行／分发清单和维护脚本语法静态核对；具体结果见实施状态。未执行 unit／SQL／迁移／音乐文件／UI／播放／网络／硬件／安装包测试，按用户要求集中到 MVP。最新已验证安装包仍为 0.29.0，ASIO 实机验证继续搁置。

MVP 验收需覆盖：标签有效／非法／缺失、专辑回退、CUE REM／同块跨界／seek、Opus 禁叠加、静音／音量／负正增益／非有限样本／限幅计数、整数路径隔离、DSD PCM 后处理、文件变化／取消、旧回执／CAS／未知结果、schema 0–37 迁移、实际音质／点击噪声／SRC 后峰值与界面。动态平滑音量、抖动／limiter、R128 合并、完整处理计划／输出帧误差、跨文件 gapless 与其余 FR/WP/AC 不缩减。
