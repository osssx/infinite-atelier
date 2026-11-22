# 剧情流水线 P3.3b：逐条目索引、历史确认版本索引与兼容读取

状态：2026-11-22 已完成第二轮 P3.3 **只读索引和事务同步**。本轮不是整个 P3.3 或 P3 完成声明。

## 1. 已实施

### SQLite Schema v42

在旧 `creative_node_payloads` 和 `canvas_text_versions` **仍为权威数据源**的前提下，新增可重建只读索引：

| 表 | 内容 | 主键／检索能力 |
| --- | --- | --- |
| `creative_scope_entry_index` | 当前创作节点的 `draft`、`confirmed` 中每个资产、剧集、镜头的 JSON 条目 | `project_id,node_id,stage,kind,ordinal`；另按 `episode_id,sequence_id` 与 `entry_id` 检索 |
| `creative_scope_index_state` | 每个阶段索引的总条数、唯一 ID 条数 | 便于快速汇总及识别分页外重复 ID |
| `creative_scope_history_entries` | 由 `canvas_text_versions` 中的 `source=confirmation` 生成的不可变确认版本条目 | `project_id,node_id,version_id,kind,ordinal`，可按旧版本及镜头 ID 检索 |
| `creative_scope_history_state` | 确认版本索引条数与 ID 唯一性 | 缺索引时回退历史原文读取，不猜测或替换历史数据 |

四张表具有数据库外键／`ON DELETE CASCADE`；写入权威原文时通过 `AFTER INSERT/UPDATE` 触发器在**同一 SQLite 事务**内删除旧索引、重建新索引。失败会回滚原文和索引，删除创作节点或历史版本时索引自动清理。索引条目存本地元数据，不存或下载媒体字节，不新增媒体生成 Job。

升级 v41 → v42 会在单次 Schema 事务内回填当前创作正文及不可变确认版本的索引，不修改项目的图、项目修订号或原历史 `content`。普通 `manual`、`restore-backup` 版本不创建冗余逐镜索引，避免备份量放大数据库；用户按版本 ID 读取时仍走原 `canvas_text_versions` 兼容路径。

### 新旧读取兼容

`readDramaRevisionScope` 的 API 仍为：

`GET /api/v1/projects/:id/drama-pipeline/revision-scope`

增加可选 `entryId` 参数；与 `nodeId`、`episodeId`、`sequenceId`、`offset`、`limit`、`draft`、`versionId`、`summaryOnly` 可以组合。

- 有合法创作正文指针、对应索引有效时，直接从独立条目表定位一个资产、剧集或镜头；序号、集 ID、场次 ID 可用于 SQL 索引检索。不再先读取完整创作正文 JSON 字符串、再按集/场在内存切割。
- 概览按索引统计集/场与条目数量，`summaryOnly` 不读取正文。页大小仍受接口上限约束。
- 资产选择项可以从确认索引只投影 `id/kind/name/variants`，不重复反序列化整份资产描述。
- 对旧版 inline JSON、带 Markdown 围栏的创作内容、尚未形成合法索引的草案、手工历史版本，继续使用原先的 JSON1 分页或版本读取。缺失的历史确认 ID 仍返回 404；损坏或跨项目指针拒绝。
- **只读索引不可独立修改**：一个正文（或一个历史确认版本）对应一套派生条目，永不允许只更新索引以绕过现有人工编辑冲突、Agent 冻结任务或资产引用验证。

## 2. 自动存储一致性

- 创作草案的普通保存、单镜草案更新、角色/资产选择合入、剧集/场次确认发布、项目导入、数据库启动回填，均通过现有权威 JSON 写入自动刷新索引。
- 不合法的、编辑中的不完整 JSON 仍可保存；此时没有有效索引，读取不会把坏数据当成有效条目。不完整数组条目和重复 ID 会触发只读侧明确校验错误，而不是默默忽略分页之外的冲突。
- 不可变确认版本索引不随草案变动；删除版本时删除对应派生记录。
- 编辑器与 Agent 原有的全量上下文读写、CAS 引用、`drama_runs`、冻结 Job、保存屏障、ZIP 归档及其导入仍保持原兼容路径，不建立第二套权威数据。

## 3. 验收路径

在 `web/` 下运行：

```bash
npm run test:drama-p33
npm run test:drama-p1
npm run test:drama-p2
npm run test:drama-p3
npm run test:drama-p1-browser
npm run typecheck
npm run build
```

测试新增 `drama-scoped-storage.test.mjs`：
- **200 节点／100 镜头／50 资产**：原文数据留在 `creative_node_payloads`，画布保持指针；一集一场只取 2–5 个镜头；`EXPLAIN QUERY PLAN` 验证剧集/场次查询命中相应索引。
- 草案更新、人工修改后的 digest 检验、另一集镜头不变、旧确认版本不变、事务中间修改后回滚、节点删除级联清理。
- v41 → v42 回填，不改变原文、项目修订号、图与历史版本；重复启动不重复积累索引。
- 非法草案、数组中的非对象条目、跨页重复 ID 不妨碍保留编辑中正文，但只读浏览 fail-closed。
- 按 `entryId` 查资产、剧集、镜头与冻结旧版，错误集/场匹配返回空。
- 确认版本索引、手工备份兼容回退、删除版本级联、历史索引查询计划。
- 完整 P1/P2、P3 媒体与镜头组、隔离 Chrome 和 ZIP 兼容回归。

## 4. 未完成和下一轮

P3.3b 本轮只交付索引和范围读取，不宣称「仅指针编辑写入」或「完整按行修改」已完成。每次权威正文更新仍重建同节点阶段的派生索引，运行时写入开销随该节点条目数增长。逐镜编辑虽然有 `entryId` 直达查询，但原 `PATCH .../shot-draft` 为了全量引用检查仍走原始 JSON 的完整修改事务。

下一轮可推进 **P3.3c 局部 CAS 编辑事务与摘要指针化**：在严格的 `expectedDigest`、`operationId` 与集/场关联验证下，直接对权威 JSON 指定镜头做 SQLite JSON1 原子替换，随后通过触发器同步索引；旧 Agent、Run、版本归档和失败重试继续作为阻塞验收项，不能直接写索引替代权威原文。

P3.4 的大画布性能目标、ComfyUI 跨重启真实尾帧生成未在此轮完成；真实本地 ComfyUI 专项仍需有对应工作流、模型及实例环境。
