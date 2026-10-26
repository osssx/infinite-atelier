# P5.1 全量冷备份与新目录恢复

此功能只备份 Canvas 本地后端权威数据：主 SQLite + `blobs` 表中所有 `ready` 状态的 BlobStore CAS 媒体。**必须先安全停止 `npm run dev` / `dev:backend`**，确保没有正在提交的付费模型请求。切勿为了备份强制终止正在执行的任务。

本轮只提供命令行**离线**操作，不提供在线一键备份。`atelier-instance.lock` 存在时即拒绝备份，不绕过运行中实例或抢占失效锁。若进程崩溃，先由操作系统确认已完全停止，再按现有运维流程处理锁文件。

在 `web` 目录执行以下 PowerShell 命令，路径须替换成实际绝对路径；备份与恢复目标的父目录需事先创建，最终目标目录本身**必须不存在**：

```powershell
npm run backup:data -- create "$env:LOCALAPPDATA\InfiniteAtelier\data" "D:\AtelierBackups\backup-2026-10-26"
npm run backup:data -- verify "D:\AtelierBackups\backup-2026-10-26"
npm run backup:data -- restore "D:\AtelierBackups\backup-2026-10-26" "D:\AtelierRestored\data"
```

创建时在独占实例锁下调用 `node:sqlite.backup()`，生成包括 WAL 已提交数据的一致性数据库镜像，逐项对照镜像 `blobs` 表验证原文件、复制文件的 SHA-256、长度和常规文件类型。全部写入同盘私有 staging 文件夹，复验数据库完整性、FK 约束、manifest 和所有 CAS 内容，然后才以目录重命名发布备份。

```text
backup-2026-10-26/
  manifest.json          # 版本、schema、数据库 SHA-256/大小、CAS 清单
  db/atelier.sqlite      # 单文件一致性快照，不需要单独复制 WAL
  blobs/ab/<sha256>       # BlobStore 内容地址文件
```

恢复时先验证现有备份，再复制到全新的用户数据目录旁的私有 staging 文件夹、重新核验、一次目录重命名发布。原目录不变，也不支持覆盖任何已存在的目标目录。校验失败会清理本轮 staging，历史用户目录和原始备份均不会被覆盖。成功后先隔离核查项目，再显式设置 `ATELIER_DATA_DIR` 指向新目录启动。

## 安全与范围边界

- 数据库包括 Canvas 项目、聊天、任务状态、Comfy 模板/预设、渠道记录和凭据的 DPAPI **加密密文**。恢复不触发模型 API，不会重发 `submission_unknown` 请求。
- **备份本身未二次加密**：SQLite 中的 Prompt 和用户内容可见，必须使用 BitLocker/OS 权限保护，不要提交到 Git 或公开云盘。
- Windows DPAPI 密文绑定原用户/系统保护上下文；跨账号或跨设备恢复后可能需要重新输入模型 Key。
- 派生预览缓存、临时文件、浏览器 LocalForage 非 Canvas 资产与偏好、数据库未登记的孤儿文件，均不属于本轮全量权威数据备份。
- SHA 和 SQLite 完整性检查只能检测不一致/损坏，不能提供签名认证；请勿导入来源不明的备份。
- 本轮避免跨文件系统原地替换；目标必须是新目录。异常断电可能留下 `.partial-*` 目录，需要人工确认清理；已有数据目录不会被覆盖。
- **不要同时运行原始数据目录和恢复数据目录的后端**：两份数据库可能包含相同的排队或运行任务；如果同时启动，可能重新执行尚未进入提交屏障的任务，造成重复收费。本轮恢复不会自动启动，但尚未提供双副本激活防护；启用恢复目录前请先停用原实例、完成任务状态核查，并只选一份数据作为权威。

下一步：非 Canvas 浏览器数据收口、持久 CAS 引用台账、断电演练及备份签名/加密。
