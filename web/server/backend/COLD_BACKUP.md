# P5.1–P5.3 冷备份、恢复副本保护和 CAS 断电审计

此功能只备份 Canvas 本地后端权威数据：主 SQLite + `blobs` 表中所有 `ready` 状态的 BlobStore CAS 媒体。**必须先安全停止 `npm run dev` / `dev:backend`**，确保没有正在提交的付费模型请求。切勿为了备份强制终止正在执行的任务。

本轮只提供命令行**离线**操作，不提供在线一键备份。`atelier-instance.lock` 存在时即拒绝备份，不绕过运行中实例或抢占失效锁。若进程崩溃，先由操作系统确认已完全停止，再按现有运维流程处理锁文件。

在 `web` 目录执行以下 PowerShell 命令，路径须替换成实际绝对路径；备份与恢复目标的父目录需事先创建，最终目标目录本身**必须不存在**：

```powershell
npm run backup:data -- create "$env:LOCALAPPDATA\InfiniteAtelier\data" "D:\AtelierBackups\backup-2026-10-26"
npm run backup:data -- verify "D:\AtelierBackups\backup-2026-10-26"
npm run backup:data -- restore "D:\AtelierBackups\backup-2026-10-26" "D:\AtelierRestored\data"
# 仅在彻底停止原实例、确认恢复副本无误后，显式切换活动库
npm run backup:data -- activate "D:\AtelierRestored\data" ACTIVATE_RESTORED_DATASET
```

创建时在独占实例锁下调用 `node:sqlite.backup()`，生成包括 WAL 已提交数据的一致性数据库镜像，逐项对照镜像 `blobs` 表验证原文件、复制文件的 SHA-256、长度和常规文件类型。全部写入同盘私有 staging 文件夹，复验数据库完整性、FK 约束、manifest 和所有 CAS 内容，然后才以目录重命名发布备份。

```text
backup-2026-10-26/
  manifest.json          # 版本、schema、数据库 SHA-256/大小、CAS 清单
  db/atelier.sqlite      # 单文件一致性快照，不需要单独复制 WAL
  blobs/ab/<sha256>       # BlobStore 内容地址文件
```

恢复时先验证现有备份，再复制到全新的用户数据目录旁的私有 staging 文件夹、重新核验、一次目录重命名发布。原目录不变，也不支持覆盖任何已存在的目标目录。校验失败会清理本轮 staging，历史用户目录和原始备份均不会被覆盖。**P5.2 起恢复目录会生成新的副本 ID，但继承原数据的谱系 ID，并保持 standby 待激活，不能直接启动。** 先确认原实例完全停止（未完成提交的生成任务不要强杀），检查恢复目录及密钥迁移限制，再执行上面的 `activate`；该命令在持有副本本地锁及谱系全局锁时重验 SQLite 与所有 CAS 文件，然后将活动副本登记切换到新目录。此后显式设置 `ATELIER_DATA_DIR` 指向新目录启动。旧目录仍保留但不再被允许启动。

## P5.3：断电后媒体完整性审计（不修改文件）

在安全停止本地后端后运行：

```powershell
npm run backup:data -- audit "$env:LOCALAPPDATA\InfiniteAtelier\data"
```

审计会取得该数据目录的实例锁，以只读方式检查 SQLite integrity/FK 及每条已登记 `ready` CAS 媒体的文件类型、字节数和 SHA-256；还会扫描 `blobs/` 是否有未登记的孤儿内容地址文件、`tmp/*.part` 是否存在被中断的上传临时文件及其他异常文件。返回 `missing`、`corrupt`、`orphanFiles`、`staleTemps`、`unexpectedFiles` 计数与有界条目列表。它**不会**重发任务、回滚项目、删除孤儿或清理临时文件；真正受损的已登记媒体必须从完好的冷备份人工恢复，不能仅根据存在孤儿文件就将其当成成功产物。关闭程序之前不要强行抢锁。

SQLite v10 在主库中额外维护保守的 `blob_ref_ledger` 和脏标记，所有已知引用来源的写事务通过触发器同步记录变更。启动/GC 会在事务内重建持久引用映射。GC 删除前仍扫描当前所有引用并检查台账、7 天冷却、活动上传和 SQLite 外键；引用台账只为避免误删服务，不自动执行媒体清理。
当发现缺失、损坏、孤儿或临时文件时，审计返回 `ok:false`、`needsReview:true`，CLI 以退出码 `2` 提醒人工处置；退出码 `0` 表示当前检查范围内无异常，退出码 `1` 表示审计未正常完成。

## P5.4a：非 Canvas 素材库的备份范围

浏览器素材库页现在通过 SQLite `GET|PUT /api/v1/assets` 维护元数据，并用 BlobStore 内容哈希定位图片/视频。旧 LocalForage 资料不会自动进入新库：在 SQLite 素材库为空时，用户可手动点击“导入旧浏览器素材”，原媒体先上传并核对为 CAS，再写入完整的库快照；该操作不清理原浏览器存储。冲突、后端失联或媒体缺失时会拒绝保存，不把本地缓存悄悄当作最新权威记录。素材库页面另有传统浏览器 ZIP 导入/导出入口，**不等价于 SQLite 整库冷备份**。

**兼容性保护（P5.4a 收尾）**：素材库 ZIP 会在导入前验证媒体清单、条目大小与文件路径，并将旧 `image:` / `video:` 文件直接上传为 CAS、重写返回的素材记录，不再在导入时写回旧 IndexedDB 文件库；导出的 CAS 素材随素材库 ZIP 内嵌媒体文件，导入时需重新上传并验证内容哈希。旧版**整应用浏览器 ZIP**若含 SQLite/CAS 媒体会阻止导出；它不能覆盖已有 SQLite 项目或素材库，也不能包含需要原地替换的 CAS 素材。权威的迁移/恢复路径仍是 `backup:data create|verify|restore|activate`，不可用浏览器 ZIP 代替冷备份。Canvas 节点、素材页和 Prompt 库新增的素材保存确认必须等待 SQLite 提交，失败时提示错误而非假装已保存。

## P5.4b：非敏感模型设置与主题冷备份

SQLite schema v12 的 `ui_settings` 包含模型通道元数据、模型选项、非敏感生成偏好和深浅色主题，并自动随 `backup:data` 冷备份与新目录恢复。`model_config`、`theme` 分别有独立的 revision；后端会拒绝任何 JSON 内出现的 `apiKey`、令牌、凭据、密码、模型脚本字段。旧浏览器配置和主题**不会自动覆盖** SQLite：用户可以在配置与用户偏好页面确认“导入旧浏览器设置”，仅默认空库/初始主题允许迁移，失败时保留原浏览器资料。普通配置 JSON、旧版整应用 ZIP 输出会剔除 API Key 与模型脚本。

**密钥边界**：用于旧浏览器直连 API 的 Key 与脚本暂存于浏览器原配置与过渡性的 `atelier:local-credentials` 本地记录（明文、仅浏览器端、非备份内容），不会同步到 `ui_settings`。这不是 DPAPI 加密，也不是最终密钥迁移。`channels` / `credential_versions` 服务端 DPAPI Vault 是另一套已经存在的后端渠道凭据；只有该服务端凭据体系支持加密持久化，尚未将所有旧前端直连通道自动接入。请在清除浏览器存储或更换电脑前单独规划凭据重配；后续 P5.4c 才应彻底迁出旧明文 Key 并移除明文残留。

## 安全与范围边界

- 数据库包括 Canvas 项目、聊天、任务状态、Comfy 模板/预设、渠道记录和凭据的 DPAPI **加密密文**。恢复不触发模型 API，不会重发 `submission_unknown` 请求。
- **备份本身未二次加密**：SQLite 中的 Prompt 和用户内容可见，必须使用 BitLocker/OS 权限保护，不要提交到 Git 或公开云盘。
- Windows DPAPI 密文绑定原用户/系统保护上下文；跨账号或跨设备恢复后可能需要重新输入模型 Key。
- **P5.4b 后，已迁入 SQLite 的非 Canvas 素材库记录/CAS 文件、模型非敏感配置和主题偏好包含在此冷备份中**；未主动导入的旧浏览器资产/模型配置、明文渠道 API Key/自定义脚本、Skills、派生预览缓存、临时文件和数据库未登记的孤儿文件仍不在备份中。
- SHA 和 SQLite 完整性检查只能检测不一致/损坏，不能提供签名认证；请勿导入来源不明的备份。
- 本轮避免跨文件系统原地替换；目标必须是新目录。异常断电可能留下 `.partial-*` 目录，需要人工确认清理；已有数据目录不会被覆盖。
- **P5.2 双副本防重复执行**：备份 manifest v2 包含随机数据谱系 ID，恢复副本生成独立副本 ID，默认为 standby。后端在 JobCoordinator 恢复/启动前持有跨目录的谱系锁，并核对当前活动副本登记；不允许原库与克隆库同时运行。`activate` 必须在原实例退出并释放谱系锁后明确执行，成功切换后旧库不能直接重启。如果活动登记消失或损坏，启动直接拒绝，不能静默重新声明旧库为活动副本。
- 保护范围是**同一操作系统账户和本机共享的谱系登记目录**（Windows 默认 `%LOCALAPPDATA%\\InfiniteAtelier\\activation`）。跨设备/跨用户的独立注册表不能构成分布式锁；不要在不同电脑同时运行同一份可自动提交生成任务的数据副本。
- P5.1 旧版 manifest v1 仍可 `verify`，但因为缺少谱系身份，本轮为防重入会拒绝直接 `restore`；请使用已升级后的原库重新创建 v2 备份。手工复制旧版 SQLite/BlobStore 而跳过本备份恢复工具不受此机制的克隆检测保护。

下一步：完整断电/进程终止故障注入演练、媒体自动修复的人工确认流程、非 Canvas 浏览器数据收口，以及备份签名/加密。
