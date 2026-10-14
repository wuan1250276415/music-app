# ADR-010：审核式在线元数据与曲库覆盖层

状态：已在原型 0.2 实施，待 V1 扩展。

## 决策

MusicBrainz 适配器只返回录音和具体发行版候选。用户必须在界面选择候选及字段，之后才将歌名、歌手或专辑写入 SQLite。远端结果不能自行写入音频文件，也不能自动合并多个发行版。候选 token 与本地曲目绑定并限时有效；提交时检查曲目修订号。

原始 CUE/文件标签仍保存在 `playable_item`；用户确认的在线值保存在 `metadata_override`，读取和搜索使用有效值。重扫只更新原始标签，不覆盖确认值。`metadata_change` 记录一次提交的前后覆盖值、来源 ID 和修订；仅在该曲目没有后续修改时允许直接撤销。CUE 暂时消失时保留隐藏轨和覆盖层，重新出现后沿用稳定 ID。

schema v1 升级前，SQLite 使用 `VACUUM INTO` 在数据库目录生成一致备份。迁移在事务中创建新表并更新 `user_version=2`；升级失败时不打开用户库进行后续写入。

## 约束与后续

- 只在用户主动搜索时发送歌名和歌手，不发送路径、音频或指纹；联系信息作为 User-Agent 的一部分由用户填写并保存在本机设置中。
- 所有 MusicBrainz 请求在 Library Service 中串行调度，间隔至少 1.1 秒，8 秒超时，429/503 只进行一次有界退避重试。
- 当前候选缓存仅在内存保留十分钟，重启后需重新搜索。在线请求没有完成公网实测；自动匹配、封面、指纹、专辑级审核、字段锁定、授权缓存策略及源文件写回仍未实现。
- V1 应把 Recording、Release、字段级来源和用户修订提升为完整领域模型；历史变更、CUE 删除与库清理的保留策略须单独设计。

接口依据：[MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API)、[Search](https://musicbrainz.org/doc/MusicBrainz_API/Search)、[Rate Limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting)。
