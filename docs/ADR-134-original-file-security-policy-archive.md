# ADR-134 提交前原文件权限存档与恢复协议2

日期：2026-10-04。状态：0.128.0 源码实施，运行及认证待MVP。属于架构FR12／AC12和WP09，不代表整个写回功能验收。

## 问题

0.119提交只保存原文件owner／group／DACL摘要。0.124备份恢复使用备份自己的权限，备份目录的继承权限可能与原文件不同；摘要无法用于重建原DACL。不能在旧记录中补造权限数据，也不能把备份权限标为原文件权限。

## 原权限记录

提交进程在原文件排他句柄下、第一次文件移动之前采集owner和group的二进制SID、DACL字节、各自SHA256、DACL存在和保护标记，以及创建／修改／访问时间和允许的基本属性。SID最多68字节，DACL最多16KiB；无ADS，SACL标记not-certified。原权限记录置于提交intent的policy.origin，随不可变SHA日志及FULL-sync数据库revision2回执先于ACK持久化；后续阶段完整policy相同。

Shared读取器验证精确键、十进制时间、SID结构、ACL头部与ACE边界；Library验证实际二进制SHA；Native再验证SID、ACL和摘要。原创建／修改时间必须等于原提交来源基准，外围policy的权限、创建／访问时间和属性须等于存档。提交在移动前后通过持有的原句柄复核权限、创建／修改时间和属性。文件读取可能影响访问时间，其采样记录与属性设置不能视作文件系统永久冻结。单帧仍限64KiB，原生提交与协议2恢复的每秒输出上限提高到512KiB，容纳连续持久阶段中的有界原DACL存档；协议1恢复保持128KiB／秒。

## 新恢复路径

恢复请求／消息／ACK升级为2，origin为必填。恢复绑定及日志容器仍为1；旧恢复请求、证明和日志按协议1精确读取。新内部协调器只申请协议2，申请前从原提交不可变intent回执取origin，冻结时核对完整实际原提交日志和全部已存回执，origin必须与日志intent完全相同。旧提交缺少原权限数据时拒绝新恢复，不释放已有占用。

victim模式验证实际旧文件的权限、创建／修改时间和属性等于原存档；不重写旧文件权限。backup模式用CREATE_NEW创建独立副本，应用**原存档**DACL，而不是备份DACL；实际新文件owner／group须已等于存档，随后复制完整字节，设置原存档时间／属性，flush、完整摘要回读和权限回读。备份仅作为冻结的字节来源，其权限不要求等于原文件。原路径已有目标仍通过非覆盖移动完整保留为displaced，然后将原来源放回；原有六阶段和持久ACK边界不变。

新认证adapter为aural-flac-restore-v2，模式scheme为exclusive-handle-restore-{victim|backup}-original-policy-v2；旧adapter／scheme只用于协议1，证书ID不能跨协议或提交复用。正式恢复认证目录仍为空，无Main／服务／preload／Renderer原生恢复执行入口，现有只读核对和重新解析／曲库恢复入口继续支持历史绑定。

## 权限边界

不启用特权、不修改owner／group、不请求SACL。缺失DACL拒绝执行：不能把缺失DACL当作null DACL写入，因为后者会开放完全访问。存在但为null的DACL仍须与原证据一致。DACL继承或序列化变化使回读摘要不同则拒绝，不声称任意权限策略可恢复。API边界依据[SetSecurityInfo官方文档](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo)和[Security Descriptors官方文档](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptors)。

schema58是版本保护迁移：迁移前备份，原表与不可变JSON历史不改，仅提高user_version，阻止旧应用打开新权限载荷。新数据库同样到58。历史测试夹具退回链和四个版本断言已更新，未执行SQL或迁移。

## 验证与后续

Main／Renderer构建和类型检查、全部生产原生组件及既有金样编译通过，未运行；41个CommonJS语法通过。发行生成文件和分发清单（18个npm运行依赖／5个vendored组件）静态核对通过；源码归档为outputs/aural-prototype-v0.128-source.zip，归档工具校验CRC。应用、测试、真实文件、数据库迁移、音频和驱动集中到MVP；ASIO实机验证保持搁置。

MVP需覆盖备份继承权限不同、DACL保护／继承、空与缺失DACL、ACL预算和损坏SID／ACE／摘要、owner／group不同、设置后回读不同、LastAccess采样、旧协议读取、跨协议证书拒绝、每阶段中断及恢复重解析。完整SACL／特殊属性／额外流／更大ACL需要新适配器与独立认证，中断恢复继续执行、断裂日志、保留清理、批次、MP3、集合来源及全架构余项继续。FR12／AC12未验收，不宣称文件系统与SQLite原子提交。
