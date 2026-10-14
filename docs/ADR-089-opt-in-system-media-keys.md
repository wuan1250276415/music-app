# ADR-089：可选系统媒体快捷键

日期：2026-10-02；源码 0.84.0；音频 IPC 1.19／schema v38／媒体协议 6 不变。

## 决策与范围

架构 §19／WP06 要求桌面媒体键调用同一 Playback API。Windows 首发增加可选后台媒体快捷键，默认关闭；侧栏与托盘提供启用／重试、停用和取消入口。绑定 MediaPlayPause、MediaPreviousTrack、MediaNextTrack、MediaStop 四键，不绑定系统音量键，不注册普通文本快捷键。

采用 Electron Main globalShortcut，app ready 后才注册；无焦点也能响应。register 返回值判断实际申请结果，未取得整组四键就撤销本次已取得的键，显示不可用／占用提示，不识别或干预其他应用。依据 [Electron globalShortcut 官方接口](https://www.electronjs.org/docs/latest/api/global-shortcut) 与 [官方媒体 accelerator 列表](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts#available-key-codes)。本批未在系统注册或实际按键，不把 API 设计说明视作本机验收证据。

这是可选全局媒体键适配，不是 Windows SMTC／系统媒体会话完整实现；系统媒体元数据／封面、锁屏按钮、文件关联／拖放和 macOS／Linux 平台适配仍需继续开发。不会用此功能替代完整桌面媒体能力或相关验收。

## 设置与注册生命周期

MediaKeyPreference v1 三字段 version／revision／enabled，默认 false，存已有 app_setting 独立 media_key_preference 键；不改旧 desktop_preference 字段，旧关闭设置仍可读取。Library Service 单写事务核对完整旧值和递增修订，相同完整新值支持重试确认，不新增 schema。

启用先尝试获得全部键，再保存设置；保存与对话框期间 callback 闸门关闭，取得键不等于允许动作。只有回读确认偏好、整组已取得且设置处理结束才生效。保存失败回读当前值；无法确认或不符时停用并释放整组，明确提示重新打开设置核对。停用也保存偏好并逐键释放。注册失败保留明确错误与“已保存启用但未生效”的区别，用户可以显式重试；不无限循环申请。

重启只按已保存启用意图尝试绑定，注册不调用播放。退出在 before-quit 释放本类 owned 集合，不使用 unregisterAll 清理其他组件的键。设置／初始化期间退出的 closed 闸门阻止迟到注册或动作。没有凭据、远程依赖或音频 IPC 格式变更。

逐键解绑若抛错仍保持 callback 闸门关闭，保留未确认的 owned 项供后续清理并显示状态，不阻断其他退出清理；不能把注销调用当作本机成功验证。侧栏增加垂直滚动和固定导航／设置行，避免小窗口新增入口被裁掉，真实布局待 MVP。

## 播放动作

托盘与媒体键共享 Main desktopTransport。播放／暂停沿用 coordinator 与 AudioController；已释放的暂停／休眠书签通过当前同一 entry 手动重开；上一首／下一首使用同一队列修订命令，停止走原有高优先级路径。没有第二套播放队列、位置或独立状态机。

非 stop 操作单在途，350ms 同键静默间隔抑制长按密集重复。准备播放、没有当前队列项或系统 sleeping 时不发起普通动作；下一首还检查队列是否有候选。callback 到实际执行前核对本类 intent epoch、AudioController token、退出／设置／有效注册与休眠闸门，避免尚未投递的播放在 stop 或休眠之后反过来起播。stop 绕过普通在途／重复抑制，并推进 intent epoch。

媒体控制错误发送受 Main 所有的 desktopControlError，恢复窗口后可看到错误，设置对话框也展示最近状态；不弹出反复后台错误框。声音／键盘厂商发送行为、快捷键占用和实际长按节奏需 MVP 验证。

## 验证与后续

源码版本与发行摘要更新，Main 新组件／共享偏好与分发文件列入静态清单。封面优先、详情／资料检索、滚动歌词、模式／队列、托盘与暂停／休眠恢复保留。类型、Main／Renderer／Native 编译、发行／分发清单与维护脚本语法、源码归档 CRC 的最终结果见实施状态；未执行应用、注册、键盘、UI、SQL／迁移、音频、网络、硬件或安装验证，按用户要求集中到 MVP。最新已验证安装包仍 0.29.0，ASIO 实机验证搁置。

MVP 覆盖默认关闭、启用／停用持久化、每个键占用的部分注册回滚、本应用其他组件已注册、保存失败／丢回执／未知、startup 已启用但不可用、隐藏窗口控制、长按／密集不同键、stop 在微任务和队列阶段的优先性、暂停释放和系统唤醒后的手动恢复、系统休眠／准备状态、后台错误与退出清理。系统媒体会话／SMTC、全部桌面能力、音频规划／DSP／gapless、持久与服务恢复／诊断更新／跨平台及完整 FR／WP／G／AC 继续。
