# ADR-046：数据源注册与 Windows 凭据保管

状态：0.41.0 源码实现，2026-10-01；类型检查、主进程／界面（49 模块）／原生宿主及凭据组件构建、发行／分发清单和相关脚本语法检查通过。schema v21，音频协议 v1.6 不变。继续 WP01/WP03/WP08/WP11，不代表完整 Provider 或 MVP 验收。

## 注册与启停

MusicBrainz、Cover Art Archive、AcoustID 使用固定内置 manifest，区分元数据、封面和指纹能力，以及已接入／待接入状态。当前仅 MusicBrainz 的既有录音候选和主署名能力注册到 HTTP broker；不能通过界面或 IPC 启用待接入能力。条款入口只从注册表解析固定 HTTPS 地址，不接受界面传入任意 URL。

新增“数据源设置”入口，显示当前启停、能力、保留说明和凭据状态。新建曲库默认关闭在线查询；既有曲库迁移时继承原 metadata_network_enabled 设置，包括旧版未显式写入时的 true 默认值。旧“元数据”面板的开关继续有效；两处使用 provider_setting 的同一状态，旧 app_setting 值只供迁移使用，不再是当前状态的来源。

启停带基础 revision 和命令 UUID，在事务内保存设置、审计及持久回执。已提交的重复命令不重新修改后来的设置；不同请求体复用命令被拒绝。暂停／重新启用 MusicBrainz 使查询、缓存及未确认预览失效，已确认曲库数据保留。设置审计不可改写／删除。当前不提供启停撤销、第三方插件注册或完整保留条款撤销管理。

界面在启用动作前说明现有查询发送的曲名、歌手、已选录音／发行 ID，不发送路径或完整音频；公开联系信息继续在既有元数据面板填写。AcoustID 应用查询密钥与贡献用户密钥属于不同用途；当前只预留应用密钥保存，不生成指纹、不访问 AcoustID、不提供贡献提交。保存凭据不代表服务授权或适配完成。[AcoustID 官方说明](https://acoustid.org/webservice)列出应用 client key、贡献 user key、服务使用条件及限流；GPLv3 开源选择不自动替代这些条件。

## 系统凭据边界

CredentialStore 接口隔离平台实现；Windows 使用第一方 credential-vault.exe 调用 [CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)、CredReadW、CredDeleteW。以 CRED_TYPE_GENERIC 保存，CRED_PERSIST_LOCAL_MACHINE 对应同一 Windows 用户和本机的跨登录保存方式，见 [CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)。本次应用限额 2048 字节，不使用系统允许的更大上限。

目标名为 Aural/provider/{profile UUID}/{provider}/{slot}。schema v21 迁移事务生成并保存 profile UUID，当前库备份保留命名范围；缺失／非法范围拒绝使用，不静默建立另一套凭据关联。另一个新曲库获得另一个范围。复制同一数据库仍共享该范围；换机器或换 Windows 用户不迁移凭据值。回滚到未包含范围的旧数据库后，重新升级产生新范围，需要重新配置凭据，不假定旧秘密能自动恢复。

系统用户凭据库不是应用专属安全隔离区，同用户的其他授权进程可能访问；本实现不声称抵御已控制当前用户的进程。macOS Keychain、Linux Secret Service 后端仍待实现，当前非 Windows 状态显示不可用。

原生组件使用隐藏进程、私有标准输入／输出管道，命令行不包含秘密。请求头为 AUR1 + 操作号 + 三个 UInt16LE 长度 + UInt32LE 秘密长度；返回头为 AUR1 + Win32 状态 + UInt32LE 内容长度。范围严格为小写 UUID，数据源／槽名限制为固定 ASCII 标识，秘密不超过 2048 字节，要求请求后 EOF。读取秘密只在 Service 内用于核对；界面接口只允许保存、移除、读取是否存在，不提供读取秘密或显示已有秘密的 API。

TypeScript 适配器限制输出大小与错误输出，单次 8 秒超时，拒绝异常响应；原生端对当前用户 SID、范围和槽名使用 Global 命名互斥量，最长等待 5 秒。跨会话命名与访问控制边界依据 [Windows kernel object namespaces](https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces)，跨用户、跨登录与权限失败仍须实测。互斥量仅串行化本组件的操作，不约束其他程序直接修改系统凭据。

输入、读回结果和校验密钥的 Buffer／原生字节会尽力清零；界面成功后清空输入，关闭后释放草稿，Preload/Main/Service 清除请求对象的秘密字段。JavaScript 字符串及 IPC 内部副本不能保证原位清零；这不是内存无残留证明。没有把秘密写到数据库、日志、进程参数或源码配置中。

## 保存、核对与回执

SQLite 事务与 Windows 凭据写入不能组成同一个原子事务。凭据操作先持久保存无秘密的 pending 意图，再写入／移除系统凭据并读回核对，最后保存 succeeded 或 unknown 结果。操作身份、目标、指纹及创建时间不可改写；记录不可删除，结果状态可以更新。

请求指纹使用 HMAC-SHA256，校验密钥为独立系统凭据中的随机 32 字节，通过原生“存在则读取、不存在则创建”操作初始化；不在 SQLite 保存秘密或无密钥的秘密哈希。初始化失败时也清理已创建的秘密 Buffer。

同 UUID 重试已成功的操作只返回原回执，标明历史回放；界面另刷新当前凭据状态，不把历史“已保存”当作当前仍然存在。pending／unknown 重试只比较当前值与请求目标，不重放写入；匹配即确认当前目标已满足，不重建不可知的历史写入过程。不匹配仍为 unknown，需要用户明确发起新保存／移除。校验密钥丢失／改变后，旧请求可能无法核对，不能借旧回执盲目写入。

Service 最多接收 4 个串行操作，排队 30 秒后尚未开始则拒绝；主进程调用期限 60 秒。界面同一时刻只操作一次，未知结果可以核对原操作，也可以明确重新提交。关闭／进程退出不会把 pending 宣称成功。重启后显示当前是否存在及未确认历史数量；秘密不落盘，因此不在重启后自动恢复输入或自动重放未知操作。

## schema 与发行

schema v21 增加 provider_setting、provider_setting_change、provider_credential_command 及索引／身份保护触发器。已有库升级前保存 pre-v21 一致备份，安装表和命名范围在事务中提交。schema v20 安装受版本条件保护，升级 v20 时不会重新安装其表。旧版测试夹具的逆迁移更新到 v21；仅调整夹具，没有运行迁移测试。

构建加入 build:credential-vault，build:native／dev／package:win 包含该组件；安装包 extraResources 和安装目录哈希核验包含 credential-vault.exe。这里只新增第一方组件和 Windows 系统 API，无新增 npm 或第三方原生依赖；不代表安装包已生成或分发门槛已通过。

## 验证与剩余范围

按用户节奏仅类型、主进程／界面／原生构建和静态清单检查；没有执行系统凭据读写、真实密钥、单元／桌面／网络／迁移／安装包或 ASIO 验证。没有创建任何实际凭据。最新已验证安装包仍为 0.29.0，ASIO 实机验证继续暂停。

MVP 验证：新库默认关闭及旧设置迁移、设置修订冲突／回执重试、暂停取消预览、秘密不出现在文件／参数／日志、保存／移除／空值／超限／组件丢失、IPC 断连／原生超时／写入后崩溃／未知核对、历史回执与当前状态区别、校验密钥丢失、同库备份恢复／新库范围隔离、同用户跨会话及不同用户权限、打包路径与最小窗口键盘布局。

继续完成 Provider 的持久保留与条款撤销策略、指纹／整专辑匹配、在线封面和歌词的逐源授权、完整署名批量、其他实体／集合部分撤销，以及完整 FR01–FR14／WP01–WP11；此批次不将待接入能力标为完成。
