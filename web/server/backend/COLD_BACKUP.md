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

## 安全与范围边界

- 数据库包括 Canvas 项目、聊天、任务状态、Comfy 模板/预设、渠道记录和凭据的 DPAPI **加密密文**。恢复不触发模型 API，不会重发 `submission_unknown` 请求。
- **备份本身未二次加密**：SQLite 中的 Prompt 和用户内容可见，必须使用 BitLocker/OS 权限保护，不要提交到 Git 或公开云盘。
- Windows DPAPI 密文绑定原用户/系统保护上下文；跨账号或跨设备恢复后可能需要重新输入模型 Key。
- 派生预览缓存、临时文件、浏览器 LocalForage 非 Canvas 资产与偏好、数据库未登记的孤儿文件，均不属于本轮全量权威数据备份。
- SHA 和 SQLite 完整性检查只能检测不一致/损坏，不能提供签名认证；请勿导入来源不明的备份。
- 本轮避免跨文件系统原地替换；目标必须是新目录。异常断电可能留下 `.partial-*` 目录，需要人工确认清理；已有数据目录不会被覆盖。
- **P5.2 双副本防重复执行**：备份 manifest v2 包含随机数据谱系 ID，恢复副本生成独立副本 ID，默认为 standby。后端在 JobCoordinator 恢复/启动前持有跨目录的谱系锁，并核对当前活动副本登记；不允许原库与克隆库同时运行。`activate` 必须在原实例退出并释放谱系锁后明确执行，成功切换后旧库不能直接重启。如果活动登记消失或损坏，启动直接拒绝，不能静默重新声明旧库为活动副本。
- 保护范围是**同一操作系统账户和本机共享的谱系登记目录**（Windows 默认 `%LOCALAPPDATA%\\InfiniteAtelier\\activation`）。跨设备/跨用户的独立注册表不能构成分布式锁；不要在不同电脑同时运行同一份可自动提交生成任务的数据副本。
- P5.1 旧版 manifest v1 仍可 `verify`，但因为缺少谱系身份，本轮为防重入会拒绝直接 `restore`；请使用已升级后的原库重新创建 v2 备份。手工复制旧版 SQLite/BlobStore 而跳过本备份恢复工具不受此机制的克隆检测保护。

下一步：完整断电/进程终止故障注入演练、媒体自动修复的人工确认流程、非 Canvas 浏览器数据收口，以及备份签名/加密。
