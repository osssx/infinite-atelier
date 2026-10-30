# Skill 文件系统注册表

生产后端 Skill 唯一权威来源是 `ATELIER_SKILLS_DIR`。在 `web/.env` 中指定绝对路径，例如 `ATELIER_SKILLS_DIR=H:\\InfiniteAtelier\\skills`。Windows 默认值为 `%LOCALAPPDATA%\\InfiniteAtelier\\skills`；修改 `.env` 后必须重启后端。环境变量的值优先于 `.env`。

每个一级子目录是一个 Skill，目录名（如 `drama-01-outline`）是稳定的英文 slug ID，`SKILL.md` YAML `name` 是可使用中文的显示名称，无需与目录名相同；目录内可附带 `references/`、`assets/`、`scripts/`。支持 Windows 目录符号链接 / junction 作为一级 Skill 目录，附属文件及子目录链接也可指向配置根目录之外（典型用法是 `.agents/skills` 指向 `.skills-manager/skills`）。单机使用场景不限制链接目标根路径，扫描时追踪这些链接；循环目录链接会被跳过并报告错误。脚本和素材不会自动执行；Skill 自动模式仅按需读取 `SKILL.md`、references 中的文本。

后端启动时扫描一次；设置 > Skills 页面提供“扫描目录”，也可 `POST /api/v1/skills/scan`（参数 `expectedRevision`），扫描后可使用已发现的 Skill。普通 GET 不扫描磁盘。每次手动扫描：合法新增目录自动启用；更新内容创建 SHA-256 新版本；目录被文件系统删除后，下一次扫描会从可见 Skill 列表移除它（历史快照仍保留）；无效 Skill 不可用于新任务。现有启用、项目作用域和历史版本保留。磁盘文件发生未扫描的变动时，提交前 fail-closed 并提示重新扫描。历史版本可作为活跃版本，但不覆盖工作区当前文件。

`.atelier/registry.json` 记录启用状态、项目 scope、活跃版本、已扫描文件 hash、revision；`.atelier/versions/<id>/<version>.json` 保存独立的不可变文件快照（各成员 Base64，适用 5 MiB 的包上限）。所有持久 Skill 数据均在该目录。SQLite v13 中原有 `skill_entries`、`skill_versions` 和 `skill_registry_state` 保留为历史旧数据，不作为生产注册表，也不会自动迁移或回退。应用不提供导入或删除操作：如需使用旧 Skill，请在文件管理器中把原始 Skill 文件夹复制或链接到配置目录，再执行扫描。

**备份重要：** `npm run backup:data` 只备份 SQLite 及数据库内关联 CAS，**不会**将外部 Skills 目录打入冷备份。使用链接时，备份也应包含链接**实际目标**的 Skill 源目录（仅复制链接自身并不能备份其内容）。需要在停用后端及停止编辑 Skill 后，另外复制或压缩**整个** `ATELIER_SKILLS_DIR`（包括隐藏的 `.atelier`）到安全位置。恢复时先恢复该目录及其 `.atelier`，再启动后端；如果只恢复 SQLite，历史 Job 已冻结的 CAS Skill 快照仍可用于允许的历史任务重放，但新任务 Skills 列表不会随之恢复。旧 `COLD_BACKUP.md` 的 v13 Skill 数据库备份章节仅解释旧版本，不代表当前生产存储范围。

API: `GET /api/v1/skills/config` 获取目录，`GET /api/v1/skills` 读取注册表，`POST /api/v1/skills/scan` 扫描，`PATCH /api/v1/skills/:id` 修改启停、范围和版本，冻结接口保持不变。已移除导入 `POST /api/v1/skills` 和删除 `DELETE /api/v1/skills/:id`；Skill 文件夹只由本地文件系统维护。Job 与 CAS、一用授权表仍保存在 SQLite，不受 Skill Registry 存储迁移影响。
