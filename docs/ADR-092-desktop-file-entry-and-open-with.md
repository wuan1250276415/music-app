# ADR-092：桌面文件入口与显式导入范围

日期：2026-10-02；源码 0.87.0；schema v38、音频 IPC 1.19、媒体协议 6、系统媒体协议 1 不变。

## 范围与用户流程

落实架构 §19 的拖放导入／文件关联入口，并复用 FR01、WP02、WP06、WP10 的曲库扫描和统一播放接口。音乐仍保留原位置，不复制、移动或修改标签。

1. 从侧栏选择音乐文件，或从文件管理器拖入音乐／CUE／文件夹。Windows 已安装版通过“打开方式 → Aural”传入文件；新进程命令行和已有进程的 second-instance 都进入同一待处理窗口。macOS open-file 事件预留早期接收，尚无 macOS 发行配置。
2. Main 检查真实本地路径，只读匹配已有曲库。已存在 CUE 时，音频文件可对应多个可见分轨；CUE 文件按文档及 source ordinal 匹配，隐藏前导音轨不展示。
3. 用户可以明确播放一首已匹配曲目，替换当前播放列表；或勾选目录后点击“扫描所选完整文件夹”。扫描范围包含该目录全部音乐、CUE 和子目录，界面展示完整路径。若文件属于已有根目录，展示并扫描该完整根目录，不误称只导入已选文件。
4. 提交创建或复用持久化扫描任务。进度、异常和取消继续由任务中心负责；关闭文件请求不取消扫描、不移除音乐目录。扫描结束后用户刷新匹配并选择播放，没有后台完成自动播放。

点击播放栏封面进入详情、内嵌封面优先、实体资料检索、滚动歌词、模式和播放列表保留既有实现（ADR-090）。本批次未修改其封面优先级。

## 路径、匹配与有界工作

- 单次最多 100 个路径、单路径 4096 字符、合计 256 KiB；同时最多八个待处理请求、32 个拟扫描目录／请求、500 首匹配曲目／请求。超过限制明确提示；匹配曲目截断单独提示，不静默截断输入。Inbox 事件只发送请求摘要，详情由 ID 读取，避免每条通知携带全部轨目。
- 拖放 File 只交给预加载中的 `webUtils.getPathForFile`，Main 再检查；不使用已移除的 `File.path`，不让 renderer 根据普通字符串授予路径。拒绝空路径、控制字符、相对路径、设备命名空间输入、链接和特殊文件，接受普通 UNC/NAS 本地文件系统路径。收到非文件拖放仍阻止页面导航。文件类型来自统一 `release/media-formats.json`，生成扫描器／选择器／外部参数和 Windows 注册清单。
- Main 记录真实路径、dev／ino、类型和文件 size／mtime／ctime。已有根目录按真实包含关系优先最具体根，最多查 256 个；离线根不据此授权新路径。捕获请求的检查串行，IPC／事件不承担同步磁盘扫描。
- Library Service 只按 root ID／相对路径做参数化查询并返回轻量曲目信息。音频查找复用现有数据库 `NFKC／小写／trim` path key；Windows CUE 文档查找支持 SQLite NOCASE 的 ASCII 大小写折叠。最终播放仍核对实际文件路径，不把 path-key 命中当作物理文件身份。
- 初次提交前重新检查全部勾选目录，发送真实目标到 Library Service。Service 重新核对目标，并在同一扫描回执事务内把 real path 写入扫描任务；任务开始与后续扫描复用已有根边界检查。已存在扫描的目标不同则拒绝该提交，不扩大原任务的范围。
- 播放入口读取当前 LibraryItem／根目录，核对选中文件绑定、可用状态、音频记录的 size／整毫秒 mtime。CUE 与绑定文档吻合，读取至多 2 MiB 原始字节并核对已有 source hash；变化、旧版无 hash 或不符时要求重新扫描。播放前再检查文件 stat、操作 token、另一请求的播放 epoch 及休眠；只把已核对的所选 ID 交给同一 PlaybackCoordinator 和队列修订命令，其他匹配结果不会自动入队。

上述 stat／real-path 检查不是完整内容哈希或安全文件句柄授权的替代。Main 与音频宿主之间仍存在路径重新打开时的竞争窗口，目录同路径替换的持久化身份也未扩展为完整 MediaSource；NAS 访问没有新增加可取消的操作系统 I/O 超时。完整架构的 MediaProbe／MediaSource／root 身份和恢复范围继续保留。

## 回执、重放与窗口恢复

- 文件请求与扫描提交状态由 Main 持有，界面重载后重新读 Inbox。每个目录的扫描 UUID 只创建一次。RPC 结果不明时保留原目录集合和 UUID，界面只允许核对原扫描提交，不允许换范围或重复新建任务。
- 核对先读取已有 `scan_command` 回执，已有回执直接恢复原 root／job ID；没有回执时重新检查目录绑定再用原 UUID 提交。已确认的拒绝按目录显示，已提交的部分任务保留。新 root 添加后扫描拒绝时，根目录可能已保留，界面不宣称事务回滚。
- 播放命令复用队列命令回执。Main 已处理的拒绝明确返回，界面恢复操作；IPC 结果不明时保留原播放命令，不新生成 UUID。现有队列持久化不明闸门和停止／休眠优先规则继续生效。
- 文件请求当前只存在 Main 内存中；整应用退出或崩溃后不会恢复尚未提交的请求，用户需重新打开文件。已提交根目录、扫描任务和回执由已有 SQLite 持久化／任务中心恢复，不等同于完整 FR13 Inbox 崩溃恢复。
- 首次启动、第二实例、窗口隐藏或重建都恢复主窗口。初始化前暂存有界外部文件请求，初始化后处理；退出后不提交新的扫描或播放。模态窗口支持焦点恢复、Tab／Escape；只读文件检查期间可“稍后处理”，不锁住其他桌面操作。已有模态窗口开启时新请求保留提示，避免自动叠加模态窗口。

## Windows 注册与接口证据

[Electron webUtils](https://www.electronjs.org/docs/latest/api/web-utils)要求隔离模式下在 preload 使用文件路径接口，并指出由 JavaScript 构造的非磁盘 File 返回空路径。[Electron app](https://www.electronjs.org/docs/latest/api/app)说明 Windows 文件打开使用命令行、macOS 需在 ready 前监听 open-file。实现遵循这两个入口，不添加第二个播放引擎。

Microsoft 的[“加入打开方式”文档](https://learn.microsoft.com/en-us/windows/win32/shell/how-to-include-an-application-on-the-open-with-dialog-box)与[应用注册文档](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration)提供 OpenWithProgids、Applications、SupportedTypes 的登记结构；[文件类型文档](https://learn.microsoft.com/en-us/windows/win32/shell/fa-file-types)描述 HKCU\Software\Classes 的当前用户可见注册。

使用自有 NSIS `customInstall／customUnInstall`：只登记 HKCU 的 `dev.aural.music.audio` ProgID、Applications\Aural.exe、支持后缀、Capabilities 和 RegisteredApplications，不写后缀默认值或 UserChoice。当前安装配置禁用提权、按当前用户安装。未使用 electron-builder 内置 fileAssociations：本机已锁定版本的 FileAssociation.nsh 会写后缀默认值，不符合此决策。

注册命令对可执行文件和 `%1` 均加引号。卸载先核对 ProgID 的 open command 是否仍指向此 `$INSTDIR`，再只移除自有后缀值和键；另一安装路径已接管时保留其登记。Applications 和 RegisteredApplications 另行核对所有权，不删除整个后缀键、第三方值或默认值。安装／卸载后通知 Shell 更新。生成清单、类型和注册宏受 `check:release` 约束，分发清单记录新增源码与 NSIS 哈希，包验证包含新增运行模块和格式 JSON。

## 验证边界

本批次仅进行源码检查与编译：Main／renderer 类型，Main 与界面构建（79 模块），全部原生编译，发行／分发清单，维护脚本语法，NSIS 自定义安装／卸载宏的独立编译。NSIS 编译输出仅在 work 中作为未运行的编译检查产物，不是 Aural 安装包。

未执行应用、真实音频或 CUE、文件拖放、数据库 SQL／迁移、扫描、网络 Provider、注册表安装／卸载或编译检查 EXE。没有新发行安装包，最新已验证安装包仍是 0.29.0；MVP 时集中覆盖以下验收：

- 13 种音频后缀与 CUE、Unicode／空格／UNC、目录拖放、错误／离线／链接／变化文件、截断提示、重复与超额输入；启动前、第二实例、窗口隐藏／重载和已有模态窗口。
- 已匹配音频／CUE 分轨、多个目录与整个已有根范围、扫描进度／取消／恢复、部分失败／回执丢失／重放、关闭请求与退出重开、无自动播放。
- 源文件／CUE 替换、扫描前后 hash、库记录变化、播放请求交错／停止／休眠、队列修订和故障恢复；真实封面与播放详情继续验收。
- 标准用户安装、“打开方式”／默认应用设置可见性、保持用户默认、带空格的安装及文件路径、升级／不同路径安装与旧卸载、清理自有项和第三方关联保留。完整 Windows x64 安装包构建和实际注册尚未执行。

完整 FR01–FR14／WP01–WP11／G1–G5／AC01–AC19 继续；ASIO 仅实机验证搁置，主题／缩放／DPI／多显示器、跨平台后端和其他架构缺口没有缩减。
