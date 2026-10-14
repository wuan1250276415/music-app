# ADR-067：封面方向与有界颜色转换

状态：0.62.0 源码实现；2026-10-01。schema v33；音频 IPC 1.8、内部媒体协议 3 不变。完整架构目标继续实施，ASIO 实机验证仍暂停。

## 问题与范围

此前转换器按编码像素直接缩放，未应用 EXIF 方向或内嵌颜色配置。即使图片成功解码，带旋转／镜像标记的封面也可能显示错位，带 ICC 配置的颜色可能被直接当成普通 RGB。本次在原有 Job 内处理这些信息，Renderer 继续只读取受控 JPEG，不增加原图路径或配置文件读取能力。内嵌正面封面优先、其他内嵌／同名／目录候选回退和离线显示规则不变。

## 方向与容器

新建 artwork-metadata.hpp，仅解析有界 TIFF root IFD 中的 Orientation 及 EXIF 子目录指针，读取该单个子目录的 ColorSpace。不追踪缩略图 next-IFD、MakerNote、递归链或其他外部指针；已知字段类型／数量、目录范围、重复字段与值范围必须成立。未读取的任意标签不会被声称已完整验证。EXIF 最多 256 KiB，每目录最多 1024 项，两种字节序均支持，允许标准 TIFF 或 Exif 前缀。

JPEG 在 SOS 前最多检查 2048 个 marker，提取 APP1 Exif；PNG 最多检查 4096 个 chunk，读取 eXIf 并核对其 CRC，拒绝重复、截断及 IEND 后尾部内容；WebP 通过固定 libwebp demux 取唯一 EXIF chunk，核对声明标志与存在状态。PNG 的其他 CRC 和完整编码有效性仍由 WIC 解码负责，不把此元数据遍历称作完整 PNG 校验器。

Orientation 1–8 对应原样、水平镜像、180 度、垂直镜像、90 度后水平镜像、90 度、270 度后水平镜像、270 度。旋转和镜像使用两个独立 WICFlipRotator，避免依赖组合选项执行顺序；尺寸复核后缩放，方向 5–8 的宽高交换由实际源对象提供。静态 WebP 已有对称最大边缩放后再校正方向，仍不放大。API 与顺时针定义见 [Microsoft WIC 变换选项](https://learn.microsoft.com/en-us/windows/win32/api/wincodec/ne-wincodec-wicbitmaptransformoptions)。

## 颜色与透明度

WIC JPEG／PNG／GIF／BMP frame 最多取得四个颜色 context，优先唯一 ICC，再选支持的 EXIF 色彩空间；多个 ICC 视为歧义而拒绝该候选。配置最多 1 MiB，检查 ICC 长度、acsp 签名、RGB／GRAY／CMYK 数据空间及最多 1024 个标签的范围，再交由 Windows 颜色引擎验证语义。它不称作完整 ICC conformance verifier。

JPEG APP2 ICC_PROFILE 和 PNG iCCP 被观察到时必须由 WIC 提供 ICC context，不能在 codec 丢失配置时静默当作无配置图片。WebP 直接从唯一 ICCP chunk 初始化 context，核对 VP8X 标志，只接受其 RGB profile。JPEG 的 ICC 分片完整解释、PNG iCCP 解压及 profile 注册仍由系统 codec 负责，压缩图与 Job 内存／时间上限继续约束其内部行为。

有效 ICC 或支持的 EXIF context 通过 IWICColorTransform 转成 sRGB BGRA；ICC 优先于 EXIF 声明。RGB、灰度和 CMYK 分别准备兼容输入格式；CMYK 源必须有匹配的 CMYK profile，否则拒绝候选，避免以未标注 CMYK 作颜色准确承诺。EXIF 1／2 的上下文定义见 [Microsoft 色彩空间 API](https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwiccolorcontext-initializefromexifcolorspace)，转换格式限制见 [WICColorTransform](https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwiccolortransform-initialize)。

无 profile 的 RGB／灰度采用 sRGB 假设；未校准 EXIF 值不推断隐藏的 Adobe RGB 配置。ICC 转换的 alpha 来自原始直通 BGRA，显式恢复后才按 ADR-066 的固定 #10131a 背景合成，避免依赖颜色引擎对 alpha 的行为。缩略图阶段的两个 BGRA 工作缓冲各最多 4 MiB，完整原图内部解码仍受 Job 限制。输入方向和源 ICC 不复制到输出 JPEG；输出是已定向、按 sRGB 解释的像素，避免显示端再次旋转／套源 profile。当前没有声明写入新的完整 sRGB ICC，浏览器对未标记 JPEG 的实际解释也需要 MVP 核对。

PNG gAMA／cHRM 单独构建配置、HDR／新颜色 chunk、XMP 方向、完整 GIF／APNG 合成、其他 profile 类别、跨平台一致性与系统显示器校准仍未实现。缩放及透明合成保持现有编码值空间策略，不声称提供线性光／出版级色彩精度。当前政策是明确的缩略图显示规则，不能据此认定所有颜色工作完成。

## 回退、缓存与兼容

配置损坏、超出预算、尺寸非法或系统不支持转换时返回失败，原有 worker 尝试后续封面候选；全部失败时沿用既有缺图／旧缓存规则。未新增“颜色已认证”状态，实际像素仍未验证。

新图算法 wic-webp-srgb-jpeg-v3；v1／v2 图经长度、JPEG 头和 SHA-256 校验后仍可离线或失败回读，在线只直接命中新算法，否则重生成。旧图不批量改写或重标记；原图 token、资产字节 ID、归属及租约语义不变。因 v32 应用会拒绝未知算法并删除其资产，schema v33 用一致备份与事务版本边界阻止旧应用打开，不改变表结构。v32 迁移加条件分支，避免新版库重复执行旧升级。

历史 schema 辅助脚本回退 v33 时丢弃派生封面而保留曲库数据；它只是测试构造，不是生产降级流程。本批未运行迁移或 SQL。迁移备份含 BLOB，耗时、容量与恢复仍须按 ADR-065／066 进行真实验证。SBOM 新增元数据解析头文件摘要和算法／预算说明，源码归档包含该实现。

## 验证边界与后续

类型检查、Main／Renderer（64 模块）／原生组件编译、发行／分发清单及相关历史 schema／解包脚本语法静态核对通过。没有运行图片、颜色、界面、SQL／迁移、音频、设备、故障或安装包测试；按用户要求集中到 MVP。最新已验证安装包仍为 0.29.0，FR04／WP04 未验收。

MVP 必须用非对称标记图覆盖八方向／两种 TIFF 字节序和三种容器；检查实际像素与宽高、不重复旋转、缩放及透明边缘；覆盖 sRGB／Adobe RGB／灰度／CMYK 配置及参考转换、ICC 优先于 EXIF、无配置与未校准政策、alpha 保持、损坏／截断／重复／越界字段、PNG eXIf CRC、配置丢失与预算拒绝、候选顺序、v1／v2 离线保留与在线重生、v32 备份升级／旧应用拒绝，以及任务取消、内存／时限和真实安装环境。

后续继续本地／内嵌歌词原文和硬监督、扫描授权／身份生命周期、媒体完整格式、音频计划及其他未完成工作包；不将这一封面批次替代完整架构目标。
