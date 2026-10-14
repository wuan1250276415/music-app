# ADR-125 原生独占标签提交底座

日期：2026-10-04。状态：内部源码和编译阶段；认证目录为空，尚无桌面提交入口。

## 问题与完整目标

架构12.2要求文件实际替换、实际被替换内容、权限/时间政策、逐阶段恢复日志，以及替换后探测和库提交。ADR-124的排他只读核对返回时已关闭句柄，不能拿旧快照直接替换文件。本批次实现持续持有原生句柄的提交程序及Library侧协议；完整写回仍需日志/DB联动、第四工件恢复、原生备份恢复、探测和库提交，并按格式及文件系统完成MVP认证。FR12/AC12未完成。

## 受控认证

release/tag-write-certification.json 当前 certificates=[]；生成器同时生成TS和C++许可表，至多16条、固定FLAC适配器/local-ntfs/exclusive-handle-rename-pair-v1及64位摘要身份/证据摘要。未知认证在客户端启动前、原生打开文件前均拒绝。环境、IPC、命令行和任意外部路径不能提供运行时许可表。当前无Main/服务/桌面提交入口，不修改现有待写入计划和空认证门禁。

许可目录只管理受控认证身份，不是测试证据本身；不得从语法检查或编译结果生成“认证通过”条目。实际本机文件系统、ACL/属性、容器/字段/未知块、音频金样、故障点和恢复联动均应在开放前验收。

## 身份、内容与权限边界

固定原文件/备份/同目录临时文件，按冻结角色和目录派生旧文件工件 `.aural-jobId-victimArtifactId.victim`。逐级保持本机目录祖先的无删除共享句柄，拒绝重解析和最终路径不符；GetDriveType和卷句柄文件系统信息要求固定磁盘、可写NTFS，不把NAS、云挂载或其他文件系统当作已认证语义。此检测仍须实机验证，也不取代过滤驱动和存储故障认证。[卷句柄文件系统信息](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew)及[磁盘类型API](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdrivetypew)用于原生资格检查。

同时持有三个文件share=0句柄，原文件和临时文件具有写/删除权限，备份只读；拒绝多硬链接、额外数据流、压缩/加密/稀疏/离线/只读等当前未保留属性。重新读取标准FLAC的完整、元数据和音频SHA、字节范围，核对物理卷/128位文件身份及冻结核对基准。备份必须完整等于来源，临时音频载荷必须等于来源，且标签修改造成完整摘要变化。

原文件与临时文件的owner/group需相同；以句柄读取并保留DACL、存在/保护状态，回读摘要不符就失败。临时文件创建和最后访问时间取自来源，最后写入时间保留暂存文件时间，源属性限于当前白名单；FlushFileBuffers后核对。在实际移动前再次检查物理身份、最终路径和DACL/所有者组摘要。以句柄设置DACL是[SetSecurityInfo的规定用途](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo)。

此政策尚未认证审计SACL、完整安全标签和所有扩展属性；协议明确audit=not-certified。不能把DACL证明称为完整权限保留，必须补齐/限制并实机验收这些策略后才认证提交路径。文件系统过滤、管理员特权绕过和掉电持久性同样没有本轮运行证据。

## 持久确认与实际移动

阶段为 locked、intent、victim_moved、replaced、verified。每条回执包含顺序/操作/租约/认证/旧工件身份、实际文件及目录证据和权限时间政策。每次stage等待Library在30秒内返回对应sequence和64位持久回执摘要；调用方必须先fsync不可变阶段记录，再提交匹配的DB回执，不能仅收到消息就ACK。当前提供此异步回调接口，实际阶段日志、库表、租约校验及恢复联动尚待接入。

locked在属性变化前确认；intent在属性准备和重新核对后确认，再允许来源移至旧工件；victim_moved确认证据持久化后，临时文件才允许成为目标。两次移动通过SetFileInformationByHandle/FileRenameInfo、固定父目录句柄及ReplaceIfExists=FALSE完成；同名目标存在就失败，不覆盖未知文件，也不自动回滚。[按句柄设置信息](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)和[FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)是此实现依据；运行支持性还需本机文件系统验证。

两次移动有明确可恢复缺口：来源名字可能暂时不存在，实际旧文件已在victim、临时文件和备份仍存在。不能称为路径替换原子，也不能称为整个目录/批次原子。中断后必须核对四工件与持久阶段决定下一步；当前三工件核对流程尚未承担此恢复职责。保持原文件工件而非无名删除对象，任何失败都不删除工件、不自动重试、不猜测回滚。

replaced后再次读取旧工件和目标完整证据，verified等持久确认后才发送done。持续持有句柄至本次作用域结束，TS客户端仅在完整五阶段确认、完整done和实际单进程退出且当前日志回调已退场后完成。此结果是原生提交证据，不是解析/解码认证，也不是数据库committed证据。

## 监督与协议

固定tag-file-committer.exe，校验父进程及映像；单进程Windows Job、不允许子进程、进程/Job各128MiB、8h墙钟/6h用户CPU。请求128KiB、回执64KiB、ACK4KiB、诊断16KiB、顺序最多131072、输出每秒128KiB；五分钟无进度请求EOF取消。独立输入线程只接收对应阶段ACK，EOF/损坏/意外输入触发终止；父进程退出、ACK30秒超时和墙钟预算同样终止。未知退出保持客户端uncertain，不允许把未知旧进程当作可重试。

共用tag-file-io.hpp中的路径/物理身份/有界读取/FLAC前缀/SHA工具，避免核对和提交对文件解释分叉；原生核对仍为原来只读三工件协议。新增源码和编译输出进入发行来源摘要及未来安装内容校验，当前未执行安装或安装内容验证。

## 验收记录与后续

本批次仅源码类型、Main/Renderer构建、原生组件和既有金样编译、脚本语法与发行/分发清单检查；Main／Renderer类型检查及构建通过（125模块，主块387.18kB／gzip121.76kB）；全部生产原生组件、新增文件提交程序及既有金样编译通过，未运行这些程序。41个CommonJS语法、发行生成文件和分发清单（18个npm运行依赖／5个vendored组件）核对通过。未运行应用/原生程序/测试/真实文件/SQL/迁移/驱动/音频/安装；ASIO实机继续搁置，最新已验证安装包0.29.0。

下一步接入不可变提交意图和阶段日志及DB回执、实际四工件核对和备份恢复、完整ACL/时间/属性政策及来源权限/修订核验、认证后的重探测和库提交、工件保留及批次/MP3。FR01–FR14、WP01–WP11、G1–G5、AC01–AC19整体目标继续。
