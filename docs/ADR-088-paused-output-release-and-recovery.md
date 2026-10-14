# ADR-088：暂停超时释放与统一恢复书签

日期：2026-10-02；源码 0.83.0；音频 IPC 1.19／schema v38／媒体协议 6 不变。

## 决策

架构 §16 要求 Pause 默认保留输出 60 秒后可释放，Resume 重新协商且区分实际状态。本批按 Main 实际 paused 回执建立一次 60 秒租期，到期通过 coordinator 串行操作释放旧音频宿主；用户明确继续时重新走输出协商与 prepared／start。

PauseRelease 以 AudioController operation token、item ID 和呈现 generation 组成 key。周期 paused 状态不重置租期；切歌、播放、停止、失败、中断和 generation 改变清除或重新建立租期。用户发出继续／跳转意图时同步取消租期，附带的 valid predicate 使已经排队的旧释放动作失效，而不只清除已触发的 timer。退出关闭定时器，定时器不会独自保持进程运行。

到期操作核对租期、token、实际 paused、item 与 generation；取消／对账 CUE 预排后再次核对。记录队列 entry 和曲目位置，发起 release，发布 pause-timeout／releasing，确认旧宿主退出后才发布 ready；等待失败发布 failed。输出摘要在仍有退休宿主时显示“等待旧宿主退出”，不将停止请求当作退出证明。真实驱动释放／退出期限仍需 MVP 实机验收。

## 书签与恢复

暂停超时与系统休眠使用同一内存恢复书签，包含 kind、entry ID、item ID、位置、token 和 positionEvidence。只有当前同一 entry／item 可使用书签；重复歌曲的另一个队列 entry 不继承旧位置。Native 明确 paused-bookmark 的位置标为 paused-bookmark，其余保留 recent-position；均不宣称硬件逐帧认证。旧 source／output／pipeline／clock 不作为释放后的当前状态展示。

暂停释放后再次系统休眠仍保留书签，并转为 system-suspend 流程。输出设置可以改变后续模式／设备并保留新的书签 token；音量只保存后续偏好。手动继续重新读取曲目，按当前保存设置打开来源和设备、核对范围与播放计划。恢复失败保留可重试书签，更新失败后 token 并显示明确错误；停止、新曲选择／自动切曲清除书签。保存、计时到期、设备重连或系统唤醒不自动播放。

当前设备已释放的状态使用 idle＋interruption，而非伪造仍持有设备的 paused。interruption 新增 kind=pause-timeout、status=releasing 和 positionEvidence=paused-bookmark。播放栏／详情已有中断提示，托盘／pause API 与播放栏当前队列播放都能明确继续；在当前会话仍 paused 时保留原来的暂停／恢复命令。此状态字段是 Main／Renderer 契约，Native IPC 不变。

租期可能因事件循环或正在执行的串行工作延后，60 秒是最早释放请求时间，不是硬件严格期限。既有 pause 的冻结位置可能有驱动报告／估计误差，重开有中断；不是跨文件 gapless。书签仅在本次进程内保存，不等同持久恢复／服务重启。

## 验证与范围

本批只做类型、Main／Renderer／Native 编译、发行／分发清单、维护脚本语法和源码归档 CRC；最终结果见实施状态。未执行定时器／音频／进程／UI／SQL／迁移／网络／硬件或安装测试，按用户要求集中到 MVP。最新已验证安装包仍 0.29.0，ASIO 实机验证搁置。

MVP 覆盖首次 paused 到期、周期状态不延期、60 秒前 resume／seek、到期动作已排队时用户意图取消、generation／切曲变化、CUE 对账跨界、同曲不同 entry、旧宿主释放成功／超时、暂停释放后休眠、设置改变、重复继续失败后重试、stop／退出优先、后台托盘、真实位置误差与重开音质。完整播放规划／DSP／gapless、持久恢复／服务恢复、媒体快捷键／诊断更新、Native／DoP／ASIO／跨平台及全部 FR／WP／G／AC 继续。
