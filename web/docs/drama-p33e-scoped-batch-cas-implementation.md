# P3.3e：多条创作内容 Scoped CAS 批量事务与指针化编辑

状态：2026-11-22。本轮已实施**显式多条目批量 CAS**、按需编辑器批次暂存及现有 Agent/Task 冻结事务保护回归。**尚未改写 Agent/Task 冻结计划为 scoped-only 计划；P3.3 的最终仅指针化与性能收尾仍未完成。**

## 1. 范围与决策

已有 P3.3a–d 提供了 SQLite JSON1 范围分页、Schema v42 派生条目索引及资产／剧集／分镜单条目 CAS。现有 Assistant Task 多动作流程会在 `planAssistantCanvasStep` 中读取全图、冻结 `projectGraphDigest` 与 `actionDigest`，需要用户审批后由 `commitAssistantCanvasAttempt` 在**同一个 SQLite 事务**提交项目图、Step 回执、Attempt 与 Task 状态。直接把其中单步操作替换为独立 HTTP CAS 调用，反而会破坏它的审批及原子性。

本轮优先完成独立**显式批量编辑**入口作为新事务原语，并让分页编辑器支持同节点内先暂存再提交。原 Agent/Task 的图动作、场次拆合、资产采用、Run Sequence、冻结快照及审批事务**完全保持原路径**；增加专门回归证明批量三节点 Task 仍然一次提交、失败全部回滚。

## 2. Schema v43：独立的批次幂等回执

新增可随项目级联删除的 `drama_scope_batch_operations`：

```sql
CREATE TABLE drama_scope_batch_operations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  project_revision INTEGER NOT NULL,
  committed_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, operation_id)
);
```

v42→v43 在原 Schema 事务内增建空表，不修改 `projects.document_json`、原正文、确认版本或既有项目 revision；不进行破坏性迁移。只读历史索引依旧使用 v42。

## 3. 按范围批量 API

`POST /api/v1/projects/:id/drama-pipeline/batch-draft`，请求示意：

```json
{
  "operationId": "explicit-batch-001",
  "expectedRevision": 12,
  "edits": [
    {
      "nodeId": "assets",
      "kind": "assets",
      "entryId": "hero",
      "expectedDigest": "<64 位 SHA256>",
      "changes": {"description": "更新角色设定"}
    },
    {
      "nodeId": "episodes",
      "kind": "episodes",
      "entryId": "ep-1",
      "expectedDigest": "<64 位 SHA256>",
      "changes": {"synopsis": "新剧情概要"}
    },
    {
      "nodeId": "board",
      "kind": "shots",
      "entryId": "shot-1",
      "expectedDigest": "<64 位 SHA256>",
      "changes": {"description": "新的镜头描述"}
    }
  ]
}
```

允许一次 1～16 项，不允许同一 `nodeId + kind + entryId` 重复出现，即使嵌套目标不同也拒绝（以父资产／父剧集为 CAS 单元），以免单批次中前一操作使后续摘要失效。已存在的批次回执且内容完全一致时，返回原提交修订号并不再次执行；操作 ID 相同但内容不同报冲突。

**单个 BEGIN IMMEDIATE 事务内**：

1. 比对整个项目 `expectedRevision`，同时用每个 `expectedDigest` 核对原草案条目。
2. 对 assets/episodes 调用现有单条校验与 SQLite JSON1 操作的内部无提交版本；对 shots 调用既有 `tryPatchIndexedShotDraft` 的 deferred commit 模式，保留角色／场景／道具引用校验。
3. 每条单独更新权威 `creative_node_payloads` 草案字符串，v42 触发器同步派生索引，不在 JavaScript 中重建整个图或全部镜头列表。
4. 全部条目验证成功后，**仅执行一次** `projects.revision` 提升、一次项目变更事件及一条批次回执；中途任何冲突、引用异常、事务异常都同步回滚已修改条目、派生索引、版本与回执。
5. 不自动批准、提交或开始任何 Agent Task、GPU、ComfyUI 或在线模型工作。

这个 API 不是 Agent 冻结 Task 的替代。冻结动作继续在原 Task Step 路径一次审批一次事务，因此不存在「先调用若干 CAS，再追加任务回执」的安全空窗。

## 4. 编辑器与缓存

`drama-creative-scope-browser.tsx` 资产及剧集的按需分页草案浏览新增「加入批量修改」及「提交全部暂存修改」。可以在不同条目间（包括翻页后）暂存最多 16 项，仍保留单条立即保存按钮。重复暂存同一个父条目明确拒绝；清空暂存不修改数据库。

批量提交走 `commitAssistantCanvasGraphWithSaveBarrier` 获取刚完成自动保存的 `expectedRevision`，向上述 API 发一次请求；成功后**只使已修改节点的内联本地缓存失效**，保留 compact pointer，原分页浏览器直接刷新并清空暂存。不会为了显示新内容立刻 `ensureCreativeNodesLoaded` 恢复整份 JSON。保存屏障新增 `invalidateCreativeNodeIds` 数组；对显式批量操作，发生同期本地未保存修改时不会用原仅适合单节点确认的 `mergeTextVersionCommit` 硬合并。

前端本轮提供的是**单节点页面内多条暂存编辑**，跨资产节点／剧集节点／分镜节点的混合批次先由同一个后端 API 支持并通过隔离测试；尚未提供跨节点多选批量 UI，也尚未让 Agent 自动调用该 API。

## 5. 验收

在 `web/`：

```bash
npm run test:drama-p33
node --test server/backend/assistant-task-canvas-executor.test.mjs
npm run test:drama-p1
npm run test:drama-p2
npm run test:drama-p3
npm run test:drama-p1-browser
npm run typecheck
npm run build
```

新增 `drama-scoped-batch-cas.test.mjs` **10 项**覆盖：200 图节点／50 资产／4 剧集／100 镜头的三节点原子批次、单 revision／event／receipt；最后一项旧摘要或非法引用导致全部回滚；重复父条目拒绝；相同／冲突 operationId 的持久幂等；项目版本冻结；旧 inline 格式保守拒绝；回执提交前人工异常注入；SQLite 重启、ZIP 往返、旧确认版本和手工 Config 保留；v42→v43 非破坏性迁移；认证 HTTP 与零媒体 Job。

扩充 `assistant-task-canvas-executor.test.mjs`：经审批的三节点 Task 依旧全图原子更新、单个可信回执并对重放幂等；故障注入在 Task 收据写入前，全部创作更新回滚。原测试有一处 `normalizeEpisodeEvents` 补入 `eventItems:[]` 的既有行为，已同步测试预期，没有更改该业务逻辑。

真实 Chrome `drama-p1-chrome-e2e.py` 增加从紧凑画布分页打开草案、修改两项资产、分别暂存、一次提交、只提升一个修订号、提交后分页仍可使用且暂存归零，ZIP 还原和浏览器刷新后两项仍存在、旧 Config 不变；原故事、候选采用、确认、视频选镜及 Shot Group 不受影响，所有请求均为隔离模拟模型，在线调用次数为零。

## 6. 剩余风险／下一轮

- **P3.3f**：Agent/Task 的按范围读取和冻结指针快照。首先明确「只读 scoped 上下文」与「有副作用 Task 冻结」边界；避免替换现有 `projectGraphDigest` 校验、任务审批、依赖绑定和 Task 完成栅栏，在真实多动作恢复中完成新旧一致性验收后逐步缩小全图恢复。
- 批量本地编辑目前仅对资产／剧集提供多条前端暂存；分镜多选与跨节点批次 UI 仍是后续功能。
- 目前每个条目的 JSON1 更新仍触发同节点索引整批重建，批次总写入成本近似与条目数和每个节点正文大小成正比；**未声称 200 节点 60 FPS 或性能基准已经完成**。
- ZIP 只迁移权威创作正文和冻结历史，不导出本机项目级批次回执。导入的新项目拥有新项目 ID，不能错误重放旧项目的批次批准凭据。
- 真实本地 ComfyUI 跨重启生成链仍须在有实例和模型的环境下完成独立验收。

本轮保留用户原有 13 项未提交文件，不纳入提交、不使用真实在线模型或生产数据。
