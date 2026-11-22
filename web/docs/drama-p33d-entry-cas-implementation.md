# P3.3d：资产、剧集及场次标题的局部 CAS 写入

**阶段**：2026-11-22，P3.3d 本轮已实施并完成隔离验证。不是 P3.3 全链路「仅指针写入」或 P3.4 的完成声明。

## 核心设计与范围

原 P3.3b 在 SQLite Schema v42 建立 `creative_scope_entry_index` 派生索引，P3.3c 已对分镜 `shot-draft` 完成逐镜 CAS。本轮新增 `server/backend/drama-entry-cas.mjs`，使**资产、资产变体、剧集和场次标题**可通过紧凑画布指针、索引 ordinal 和 SQLite JSON1 原子修改当前权威草案。

**只允许稳定身份下的内容更新**：

| 对象 | 支持修改 | 继续由专门事务处理 |
| --- | --- | --- |
| 资产 | `name`、`description` | 资产 ID、类型、素材引用、拆并、复用和变体结构变更 |
| 资产变体 | `name`、`description` | 变体 ID、增删、归属、素材绑定 |
| 剧集 | `title`、`synopsis`、`ending` | 事件 `events/eventItems`、来源段落、事件迁移 |
| 场次 | 现有场次 `title` | 场次 ID、事件引用、拆分／合并、重排、镜头迁移 |

为维护事件身份和上下游依赖完整性，**本轮不将 Agent `patch_drama_asset` / `patch_drama_episode` 多动作图事务整体替换为本地 CAS**。它们仍按已验收的冻结计划和完整图执行。事件身份、场次拆合和资产采用由已有 `drama-sequence-migration` / `drama-asset-adoption` 等专门事务处理。

## 后端写入路径

新增：

`PATCH /api/v1/projects/:id/drama-pipeline/entry-draft`

请求体：

```json
{
  "nodeId": "assets",
  "kind": "assets",
  "entryId": "hero",
  "variantId": "hero-day",
  "operationId": "one-unique-command-id",
  "expectedDigest": "64-character-lowercase-sha256",
  "changes": {
    "name": "日常造型"
  }
}
```

`kind` 仅允许 `assets`、`episodes`；`variantId` 仅适用于资产，`sequenceId` 仅适用于剧集；两者不能同时使用。请求须来源于已经通过 `revision-scope?draft=true` 取得的**整个资产/剧集条目摘要**，嵌套变体或场次标题的修改仍按父条目 CAS，避免同一资产/剧集不同字段冲突时丢更新。

所有服务端修改都在 `BEGIN IMMEDIATE` 中进行，顺序为：

1. 使用 `project_id + node_id` 与 `kind` 验证紧凑画布节点的独立存储指针；不接受同节点上相互冲突的内联正文与指针。
2. 查验 `canvas_text_version_operations` 幂等回执。同操作重复请求返回现有项目快照；相同 `operationId` 不同指令拒绝。
3. 根据 `creative_scope_entry_index` 查找到父条目 `entryId` 的准确 ordinal，比较 `expectedDigest`，拒绝 stale CAS；不同条目即使项目 revision 已变化也允许各自单独提交。
4. 通过 SQLite JSON1 校验全部草案条目的核心结构及重复 ID。对资产同时检查跨资产／变体的 ID 唯一性和内容结构，对剧集检查所有 `eventItems` 与 `events` 一一对应及同一剧集下场次／事件 ID 不重复；避免在编辑一个正常页面时掩盖另一个页面的损坏。
5. 验证仅允许修改显示文字内容，不允许修改 ID、事件、来源引用或场次拓扑。为目标条目完成 `readAssetDraft` / `readEpisodeDraft` 验证及凭据检查，校验 SQLite 当前正文在指定 ordinal 上与索引快照相同。
6. 使用 `json_set` 只替换 `$.assets[n]` 或 `$.episodes[n]`，同时保持 `payload_json.dramaDraft` **JSON 字符串** 的旧格式。Schema v42 的触发器在同一事务中重建派生索引。
7. 同事务提交 `creative_node_payloads.project_revision`、`projects.revision`、幂等操作回执和 `project_events`。全部操作成功才返回 `getProject(...,{compact:true})`；任意错误触发整体回滚。

不符合指针、索引、条目合法性要求的旧项目**不会自动猜测或重建编辑目标**：新的按条目局部接口明确拒绝写入；仍可使用原有完整编辑器及既有兼容恢复路径。不存在自动的在线模型提交或 ComfyUI 生成。

## 前端与保存屏障

- `drama-creative-scope-browser.tsx`：资产、剧集节点在「按需浏览」中勾选「浏览当前草案」，展开单个条目后可以编辑允许字段；变体和场次标题可分别展开。每次只加载当前页（每页 10 条），不要求打开完整创作编辑器。
- `use-canvas-sqlite-store.ts`：`commitAssistantCanvasGraphWithSaveBarrier` 新增可选 `invalidateCreativeNodeId`。已编辑节点不会被 `preserveLoadedBodies` 用旧的全量正文覆盖；写入返回后仅对该节点调用 `ensureCreativeNodesLoaded` 重取权威正文。其余已加载节点继续保留。
- 旧 `shot-draft` 和既有 Task 仍使用原接口与保存屏障，未修改它们的动作命令格式。

## 验收结果

在 `web/` 路径下执行：

```bash
npm run test:drama-p33
npm run test:drama-p1
npm run test:drama-p2
npm run test:drama-p3
npm run test:drama-p1-browser
npm run typecheck
npm run build
```

专项测试新增 `server/backend/drama-entry-cas.test.mjs`（10 项），整体 `test:drama-p33` 为 **48/48**：

- 200 节点、50 资产、4 剧集、100 镜头：资产／变体、剧集／场次标题只修改目标条目，其他条目及媒体 Config 不变，紧凑项目图文档不变。
- 跨条目并行修改、同一条目旧摘要拒绝、相同 `operationId` 重放幂等、不同指令复用操作 ID 拒绝。
- 拒绝 ID、种类、事件和场次列表变更及不存在的嵌套目标。
- 不允许另外一页上的异常草案、跨资产重复变体 ID、事件项与正文不对应、同剧集重复场次 ID 绕过全局校验。
- 故意触发事务失败，验证正文、索引、项目修订号、操作回执与事件同步回滚。
- SQLite 文件重启后的回执和索引保持，ZIP 导出导入恢复草案、确认旧版与视频来源，紧凑图自动保存仍正确。
- 授权 HTTP 拦截、紧凑响应、过期摘要的 409 与零媒体 Job。

完整兼容回归：P1 **46/46**、P2 **74/74**、P3 媒体／Shot Group **21 项通过，1 项依赖真实 ComfyUI 的视频测试跳过**；真实 Chrome **51/51**，涵盖真实 UI 输入、保存、ZIP 往返、浏览器刷新后局部草案未回滚及旧 P2/P3 全部操作。TypeScript 类型检查、生产构建通过。没有真实模型或 GPU 请求。

## 后续

下一轮建议推进 **P3.3e 编辑器／Agent／Task 的 scoped 快照和仅指针写入收尾**，尤其是完整编辑器的局部字段更新、批量草案修改和历史任务恢复。在迁移多动作 Agent 事务之前，必须验证它们在同一 Run 内跨多个资产／剧集／镜头的原子性，以及任务审批／重试幂等。

P3.4 的大画布渲染和 ZIP 大包压力、100 镜头下局部事务性能计时、真实 ComfyUI 跨重启视频链仍需后续单独验收。SQLite JSON1 对权威 JSON 文本的单条目替换减少了 JS 全数组恢复，但 v42 索引触发器仍按节点重建索引，所以写入耗时仍与该节点条目数相关。

本轮无 Schema 迁移；不涉及真实用户生产数据，原有 13 项未提交工作文件保持原状。
