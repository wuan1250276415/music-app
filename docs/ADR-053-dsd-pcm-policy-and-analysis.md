# ADR-053：DSF/DFF 显式转 PCM 与分析

日期：2026-10-01；源码 0.48.0；schema v24；音频 IPC 1.8。对应 FR03、WP01/WP02/WP10/WP11。Native/DoP、DSD 金样及真实输出认证尚未完成，不能把此批次称为 DSD 完整交付。

## 播放策略与展示

增加独立 DSD 策略，默认“停止”，明确选择“转 PCM”后，允许在共享或独占允许转换模式下播放。独占原始格式仍拒绝转换；DSD 自动、Native、DoP 均未启用，不因装有 ASIO 或支持某个 PCM 率就试送位流。策略仅保存在当前 Main 会话，重启恢复停止，界面重新载入从 Main 读取当前值；设置请求结果不明时读回，不假定失败等于没有改变。切换必须先停止播放。

Main 仅接受曲库条目，扩展名是候选；宿主对内容探测后在转换前再检查策略，改名为 FLAC 的 DSD 也不能绕过显式选择。IPC 1.8 与 hello 的 dsd-pcm-policy-v1 能力声明要求对应组件，沿用 build ID、代次和序列校验。参数缺失默认停止。接口错误文案不返回文件路径。

播放详情显示 DSF/DFF、DSD64/128/256、每声道原始 bit-sample rate、实际 PCM 参数、转换增益与待验收状态；底部输出标记 DSD→PCM。原始率不覆盖成 176.4 kHz 的文件标签。分析独立转换副本，生成波形是明确的本地分析操作，不修改当前播放策略或文件；结果记录源率／有效位数／profile。

## 受控格式与只读容器检查

受控 FFmpeg 稳定版本与源码 SHA 不变，新增 dsd_lsbf、dsd_msbf、dsd_lsbf_planar、dsd_msbf_planar 四解码器及 DSF/IFF 解封装器；DST 解码器不注册。网络／编码器／程序等仍关闭，LGPL 2.1+ 配置声明及对应源码／补丁／构建 recipe 随后续安装资源提供，构建与 SBOM 清单包含更新后的注册列表和 DLL 哈希。

第一方 dsd-source-info.hpp 在同一只读句柄上检查容器，保存源 bit-sample rate、每声道有效 bit 数、位序／平面表示和 DSF block 大小。与 FFmpeg 的按字节率表示明确分开：本次固定源码的 DSF/DFF 解封装 sample_rate 是原始 bit rate /8，DSD decoder 输出每输入字节一个 PCM 帧，依据固定源码的 [dsfdec.c](https://github.com/FFmpeg/FFmpeg/blob/1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7/libavformat/dsfdec.c)、[iff.c](https://github.com/FFmpeg/FFmpeg/blob/1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7/libavformat/iff.c)与 [dsddec.c](https://github.com/FFmpeg/FFmpeg/blob/1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7/libavcodec/dsddec.c)。这不是对移动 trunk 或其他版本的承诺。

DSF 核对主／fmt／data 大小、实际文件长、版本、声道类型与数量、位序、block、有效 sample count、对齐后载荷与 ID3 位置，避免把填充尾部当音频。DFF 核对 FRM8/DSD、外层与属性子块边界、偶数字节对齐、FS/CHNL/CMPR 单一性、数据长度和声道整除，最多 4096 块；DST 属性／数据立即以明确文案拒绝。未知布局继续由解码层拒绝，不猜测声道。

当前接入 44.1 kHz 速率族的 DSD64/128/256；其他族、DSF 非整字节有效尾、其他块组织／异常容器尚未适配，明确拒绝并继续列为扩展 reader 的剩余范围，不静默丢位。各渠道兼容性必须在真实样本与金样中证明，不能由头部检查推导全部格式验收通过。

## 固定转换 profile 与时钟

profile=`ff-dsd96-swr128-kaiser9-c0.5-v1`。使用固定 FFmpeg DSD FIR（其源码包含 96-tap 对称低通），之后 SWR 低通／降采样至 176400 Hz float32：filter_size=128、Kaiser beta=9、cutoff=0.5、增益 0 dB。不混音、不改变声道排列，不偷偷增加增益或自动限幅。96-tap 实现及系数见固定 [dsd.c](https://github.com/FFmpeg/FFmpeg/blob/1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7/libavcodec/dsd.c)；频响、群延迟、噪声／削波和器材表现仍须参考样本验收，本文不把注释中的理论描述宣称为本机测量。

普通 PCM 仍要求相同采样率／布局且无 SWR 延迟；只有已识别且获准转换的 DSD 允许此 SRC。输出缓冲上限 65536 帧、16 声道，分块校验有限浮点；结束时核对已解码的每声道输入字节帧恰好等于 validBitSamples/8，再排空 SWR，缺失／多余源数据失败。生成波形继续用两遍实际 PCM EOF 计数，不用源率或容器时长猜测转换输出长度。

公开来源信息保存原始 bit 数字符串（避免 JS 数值失真）、中间率、PCM 率、增益、profile 与 delayCompensation=pending，Main／Service 验证字段关系。播放设备时钟和 CUE 范围使用实际 PCM 率，不能将 source DSD tick 与 PCM 帧混用。DSD FIR 的头尾／群延迟还未做独立补偿，不把歌词或 CUE 精确对齐视为已认证。

固定版本的 DSD decoder 没有 FIR flush hook。DSD seek 因此在同一已持有句柄上重新初始化 codec/SWR，再从实际开头顺序丢弃到目标 PCM 帧，避免普通 avcodec_flush_buffers 保留旧滤波历史。定位工作设 20 秒上限；Main 的命令期限／进程 watchdog 仍可能更早中断长定位。长曲随机 seek 性能与完整呈现时钟尚未验收，不能假定零等待。

同文件双轨连续 DSD CUE 当前拒绝；单范围转换／分析仍需边界与延迟金样。完整 DSD CUE、Native reader、packer 与设备连续性继续保留，不用 PCM 转换结果宣称位流边界通过。

## 分析、缓存与交付证据

整曲波形允许 DSF/DFF，同句柄核对、父进程退出处理、取消确认、内容缓存及范围指纹继续使用既有边界；摘要标明 DSD→PCM 分析副本。算法更新至 `minmax-f32-v3-ma-0.11.25-ff-8.1.3-dsdpcm-v1`，旧载荷不复用、历史任务不改写。schema v24 不变，完整应用功能覆盖表仍保留 FR01–FR14。

本轮类型检查、主进程／界面 55 模块、四个受控 FFmpeg 库与音频／波形／金样程序／凭据组件编译、发行与分发清单、脚本语法和 PE 静态依赖核对通过。未运行新解码器、媒体转换、播放／seek、DSP 金样、SQL 迁移、界面、性能、设备或安装器。最新已验证安装包仍为 0.29.0，ASIO 实机验证继续按用户要求搁置。

MVP 门槛：DSF LSB/MSB、block 填充／损坏／非整字节尾、DFF 属性／DST／错误长度／布局负例；64/128/256 参考转换、脉冲／正弦／静音／幅度／频响／延迟／排空尾／帧数金样；长 seek／取消／超时／重新初始化；策略默认、原始格式拒绝、伪装扩展名、未知设置结果回读；CUE 范围与歌词时钟；分析副本与缓存、播放欠载对照、设备 SRC 及捕获。Native DSD/DoP、可信设备能力、数字捕获认证、完整时钟、source reader 扩展及所有剩余工作继续实施。
