# P3.3c：逐镜局部 CAS 权威正文写入

状态：2026-11-22，P3.3c **分镜镜头草案写入链路**已完成实施与隔离回归。尚不代表 P3.3 的所有对象或 P3.4 已完成。

## 目标与原有瓶颈

原接口 `PATCH /api/v1/projects/:id/drama-pipeline/shot-draft` 在一次镜头更新时调用 `readNode`，该过程会 `hydrateCreativeDocument` 画布全部创作节点，并在 JavaScript 中解析整个分镜、重建全部镜头数组、序列化整个画布图，然后让触发器重新把正文拆回 `creative_node_payloads`。

P3.3a/b 已支持按集、场次和 ID 的索引查询，且 Schema v42 为每镜头提供可重建的只读索引。P3.3c 目标是在不绕过原先引用和数据冲突验证的前提下，**只针对一个镜头修改权威正文**；其他 Agent、Run、历史版本和 ZIP 流程继续采用原有正式数据源。

## 实施

新增 `web/server/backend/drama-shot-cas.mjs`，由 `canvas-text-versions.mjs` 的原 `patchDramaShotDraft` 在现有 `BEGIN IMMEDIATE` 事务内优先调用。

1. **仅使用符合条件的快速路径**：必须有有效 `creativePayloadRef`、v42 草案条目索引、无重复镜头 ID、没有内联正文与指针冲突，且当前正文是 SQLite JSON1 可定位的有效结构。索引的 ordinal 与权威存储的对应镜头正文摘要再次比对；条目总数与真实 JSON 数组长度保持一致。对旧项目的内联数据、Markdown JSON 代码块、索引缺失、非规范草案，自动回退原有完整解析/验证路径，不静默迁移或丢失字段。
2. **单镜头 CAS**：在 SQLite 内按 `$.shots[ordinal]` 定位一条，将 `expectedDigest` 和当前索引快照比较后，使用 `json_set` 原子替换权威 `creative_node_payloads.payload_json` 的 `dramaDraft` 字符串；其余 99 个镜头及草案 JSON 的非镜头字段均保留。注意 SQLite JSON1 的 JSON subtype：显式解除内层 JSON 标记，保证 `dramaDraft` 仍是旧编辑器期待的 **JSON 文本字符串**，不能变成嵌套对象。
3. **验证不降级**：目标镜头继续使用 `readStoryboardDraft`、可编辑字段白名单、`assertNoRawCredentials`、`validStoryboardDraftReferences`。只按画布连线读取必要的上游剧集和资产正文，验证角色造型、场景/变体、可见道具和关键道具；未被选择的全部镜头通过 SQL 检查必要字段、数组类型、可选字段以及重复 ID，避免分镜其他页非法内容被局部操作掩盖。画布本身继续调用 `validateProjectDocument` 检查 compact graph、凭据与 dangling connection。
4. **严格事务与幂等**：在同一 SQLite 事务内更新权威正文、其 `project_revision`、项目 `revision`、`canvas_text_version_operations` 回执及 `project_events`。原有 v42 `creative_scope_entry_index` 触发器自动同步索引；任何一环失败，整体回滚。重复 `operationId` + 完全一致操作返回原结果，不再提升版本；同 `operationId` 但不同内容报冲突；同镜头旧摘要报 `drama_candidate_conflict`，不同镜头旧的项目修订号不会阻挡未冲突的局部修改。
5. **历史/媒体来源保护**：确认内容 `dramaConfirmed`、不可变 `canvas_text_versions`、已有媒体 Config／选中成片、各类 Job 快照和用户手工节点均不修改。只有草案切换为新的正文。提交不执行任何媒体请求，也不自动生成镜头。
6. **旧项目兼容和恢复**：无索引、旧版 inline、围栏 JSON 等情况继续原有可回退编辑路径；应用层 `commitAssistantCanvasGraphWithSaveBarrier`、`getProject({compact:true})`、既有节点面板和 ZIP 不需要改动。

## 验收

在 `web/` 执行：

```bash
npm run test:drama-p33
npm run test:drama-p1
npm run test:drama-p2
npm run test:drama-p3
npm run test:drama-p1-browser
npm run typecheck
npm run build
```

新增 `server/backend/drama-shot-cas.test.mjs` 11 项独立测试，现由 `test:drama-p33` 一并运行：

- 200 节点／100 镜头：仅验证紧凑图和单镜头，并确认 `projects.document_json` 在局部操作期间保持字节不变（只提高 revision）；其余 99 镜、历史确认镜头、媒体 Config 不变，`dramaDraft` 仍是字符串。
- 不同镜头顺序操作均可采用；旧目标摘要失效，重复请求严格幂等；操作 ID 复用冲突。
- 拒绝不存在的角色造型、场景/变体、道具引用和身份字段，合法连接资产引用可保存；不读取或改写无关媒体。
- 故意在事件发送中抛异常，验证正文、索引、项目修订号、回执与事件回滚一致，之后能够正确重试。
- 紧凑图自动保存不丢失刚更新的草案；围栏 JSON 的遗留节点继续由旧路径编辑。
- 其他页镜头非法时不能借本镜的合法索引绕过全局结构检查。
- 旧已确认 JSON 在没有草案时可以按需形成编辑草案，但原确认与冻结版本不变。
- 真实文件 SQLite 关闭／重启后的幂等重试、索引恢复与旧摘要冲突。
- 局部编辑后导出并导入 ZIP，恢复草案、确认版本、原 Config 及索引行数量。
- 指针与内联正文同时存在、镜头被删除后的旧回执必须 fail-closed。
- Fastify HTTP 权限、只返回紧凑图、请求幂等、过期摘要、零媒体 Job。

**本轮实际验收**：P3.3 专项共 38 项通过；P1 共 46 项通过；P2 共 74 项通过；P3 媒体/Shot Group 21 项通过，真实本地 ComfyUI 视频跨重启案例 1 项跳过；隔离真实 Chrome 38 项通过。TypeScript typecheck、Vite 生产构建通过。没有真实在线模型请求或 GPU 生成。

## 未完成及下一轮建议

- **P3.3d**：资产、剧集、场次的局部原子编辑与 CAS，沿用事件身份、变体 ID、序列拆合和 Agent Run 源修订验证；逐步缩小全正文反序列化与自动保存范围。必要时增加显式版本化的局部写入 API。
- **仅指针写入仍未完全切换**：Agent、Task 冻结输入、复制/恢复及 ZIP 继续从权威完整 JSON 读写；当前镜头的 SQLite JSON1 修改虽然避免应用层全量反序列化，但由于 v42 触发器会为被更新的节点重建派生索引，写入开销仍随该节点镜头数量增长。
- **P3.4**：200 节点／100 镜头／50 资产在真实浏览器中的拖动、缩放、包体上限与响应耗时定量验收，以及真实 ComfyUI 首帧、首尾帧、连续尾帧与跨重启验证，尚未在本轮实施。

用户原有 13 项工作区未提交文件保持原样；本轮只处理本阶段明确修改文件。
