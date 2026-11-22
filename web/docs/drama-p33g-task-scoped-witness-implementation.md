# P3.3g：Agent/Task 可验证的范围冻结快照（Scope Witness）

实施时间：2026-11-22。分支 `custom`，承接 P3.3f 的 Agent 只读按范围读取。本轮完成安全受控的 **Scoped Witness 冻结、审批／Claim／Commit 验证、故障回滚和重启恢复**。**不把局部摘要用作替代 `projectGraphDigest` 的授权依据，也不宣称写入侧已完全指针化。**

## 一、原有保护与新证据的关系

经源码审查，现有 `planAssistantCanvasStep` 在 SQLite 事务中：

1. 对完整权威项目图进行 `hydrateCreativeDocument`；
2. 对模型给出的 `actions` 构建确定性别名，预览完整图变更、验证跨节点引用；
3. 把完整图 `projectGraphDigest`、`actionDigest`、项目修订、依赖、Agent Run 来源、媒体授权、可选交付需求等冻结到 Step；
4. 仅在用户显式审批后领取 Step，最终在 **同一个 SQLite BEGIN IMMEDIATE** 内写入图、项目事件、可信 Step 回执、Attempt 与 Task 状态；
5. 在进程重启后仅将未提交的本地 prepared Claim 释放为 ready，提交状态不明的 Attempt 继续隔离待对账。

直接改用 P3.3e 的 HTTP 批量 CAS 调用并绕过此事务，既不能保证原审批动作与项目修订、Task 回执同提交，也会破坏可恢复性。因此本轮保留整个原执行器；仅新增独立的只读 `scopeWitness` 证据作为更早的 fail-closed 栅栏。

## 二、实现方式

新增 `web/server/backend/assistant-task-canvas-scope-witness.mjs`：

- `freezeAssistantCanvasScopeWitness(db,projectId,compactDocument,actions)`：从 `projects.document_json` 的紧凑图出发，根据动作中明确引用的 `nodeId`、`from/to`、`groupId`、`nodeIds`、`members`、`fromNodeId/toNodeId` 和被删除连接的端点识别根节点；
- 通过反向邻接索引对现有连接进行 **O(V+E)** 上游闭包扫描，覆盖资产／剧集／源文本／分镜的跨节点引用链；同时收集触碰所选节点的全部连接，包含向范围外延伸的出边；
- 对所选节点调用现有 `hydrateCreativeDocument` 的**局部节点列表**，不必仅为生成范围摘要而恢复所有未触及的 Creative payload；
- 将根节点列表、所选节点的权威元数据和相关连接按 ID 的码点顺序排列，经已有 `stableJson` 再计算 SHA-256；
- 冻结的证据只保存：
  ```json
  {
    "schemaVersion": 1,
    "rootDigest": "<SHA256>",
    "rootCount": 3,
    "nodeCount": 4,
    "edgeCount": 3,
    "contentDigest": "<SHA256>"
  }
  ```
  不保存创作正文、媒体存储键、模型凭据或未经许可的文字片段。
- `assertAssistantCanvasScopeWitness` 对证据结构、版本和当前权威范围摘要进行逐项验证，任何缺失、异常指针、未识别版本、过期摘要或 SQL 读取异常统一拒绝为 `assistant_step_source_changed`（HTTP 409）。

纯新增节点且完全未引用现有节点的动作不产生有意义的范围根，不新增 witness，此时**仍然必须通过原有完整图保护**。`scopeWitness` 在旧 Step 中缺失时兼容读取，但原有 `projectGraphDigest` 和项目 revision 依然必须通过。

## 三、真实 Task 生命周期接线

### 冻结时

`assistant-task-canvas-executor.mjs` 的 `planAssistantCanvasStep` 在原完整图预览前冻结范围证据，并把证据合并进 `assistant_task_steps.preconditions_json`。`step_frozen` 服务端事件只写 `scopeWitnessDigest` 的 SHA256，不写原文。原 ActionDigest、Task Run binding、审批、模型／媒体授权不变。没有 Schema 迁移，沿用 v43。

### 审批、领取、提交时

`assistant-task-step-gate.mjs` 的 `decideAssistantTaskStep` **只在批准 Step 时**检查证据；拒绝 Step 不会因此额外赋予写权限。之后在 `claimAssistantTaskStep`、`verifyAssistantTaskClaim` 先校验冻结项目修订与 witness，再继续现有完整图摘要比较。所有流程仍按原始的项目 revision、计划版本、用户确认和可信依赖验收，不允许拿局部摘要代替全局校验。

`commitAssistantCanvasAttempt` 在同一事务内再次验证 witness，验证完整图摘要，然后应用全部批准动作、提升项目 revision 并提交 Step／Attempt／Task 回执。新的可信回执包含 `scopeWitnessDigest` 以便审计；无 witness 的历史 Step 回执格式不变。已有回执重放返回已提交结果，不会重跑图操作。

### 重启恢复时

`recoverAssistantCanvasTasksAtStartup` 在解锁 prepared 且尚未提交的本地 Claim 前，新增 witness 校验。若项目 revision、witness 或完整图摘要任一不匹配，则 Step 转为 blocked，Attempt 转为 released_pre_submit，**不重提媒体 Job、也不生成新的画布写入**。外部执行状态不明仍按原路径进入 needs_reconcile。

## 四、P3.3g 验收

新增 `assistant-task-canvas-scope-witness.test.mjs` **16 项**，并把它与原 `assistant-task-canvas-executor.test.mjs` 一同加入 `npm run test:drama-p33`：

- 200 个画布节点、100 镜头、50 资产、4 剧集，三项跨节点修改的 witness 包含三个动作根、四个节点（含传递上游）和三条连线；证据大小不到 400 字节、不包含原文；
- 未授权、无关创作节点的 `creative_node_payloads` 被故意移除时，**单独的 scoped witness 计算仍能成功**；但批准 Step 依然因原有完整图保护失败（不可用 witness 代替全局完整性）；
- 正常审批三节点一次性提交，只增加一次 revision、一次项目更新事件和一条可信回执，重复执行不产生第二次 Attempt；
- 项目 revision 不变的情况下，资产正文变化、已选连接端口变化、伪造 witness 摘要或版本会拒绝审批，且未领取 Claim；
- 审批之后、领取之前、领取之后的底层正文变化，分别在 Claim／最终 Commit 栅栏拒绝，草案编辑不会半写；
- 未选中的 Creative payload 修改时局部摘要可以保持相同，但原有 `projectGraphDigest` 仍拒绝审批；
- 回执写入前故意抛异常，验证图、项目 revision、项目事件与可信回执全部回滚；
- 真实 SQLite 文件关闭／重开后，prepared Claim 若源未变则恢复为 ready，执行一次；源变化则 blocked，不能误重跑；
- 无 witness 的旧冻结 Step 仍能审批和执行，但完整图保护仍然能拦截范围外的非法变化；
- 纯新增节点和删改连线类动作的 witness 选择规则正常。

运行：

```bash
cd web
npm run test:drama-p33
npm run test:drama-p1
npm run test:drama-p2
npm run test:drama-p3
npm run test:drama-p1-browser
npm run typecheck
npm run build
```

全部使用本地内存／临时磁盘 SQLite、模拟 Provider 与真实 Chrome 测试夹具，无真实在线模型计费或 GPU 媒体生成。真实 ComfyUI 跨重启视频用例仍按既有配置跳过。

**本轮实际结果：** `npm run test:drama-p33` 129/129；P1 35 项 Node＋11 项 Vitest 通过；P2 74/74；P3 5 项 Node＋16 项 Vitest 通过，另 1 项真实 ComfyUI 因缺少实例而按既有配置跳过；真实 Chrome 64/64；`npm run typecheck`、`npm run build` 均通过。生产构建仍有原有的大 chunk / ineffective dynamic import 警告，不影响本次构建通过。未进行 200 节点 60 FPS 性能基准，也未发出真实模型请求。

## 五、限制与下一步（P3.3h）

**尚未实现写入侧局部图提交。** 当 Task 要预览并修改整个图时，原 `planAssistantCanvasStep` 和 `commitAssistantCanvasAttempt` 仍保留一次完整权威图恢复与图 digest 校验。新增 witness 提供的是独立、可重复计算的范围指纹和更早的冲突诊断，不是性能已提升的证明。

建议下一轮选取局部编辑白名单（例如不改变节点身份和连线的 `patch_drama_asset`、`patch_drama_episode`、`patch_storyboard_shot`），先验证它们在**同一个 BEGIN IMMEDIATE** 内通过已有 v43 批量 CAS 子操作提交、原 Step 可信回执／Agent Run binding／模型授权同时落盘，并保持全图 digest、角色道具引用及依赖校验不变。任何覆盖删除、场次拆合、ID 迁移、分镜关联修复仍交由原全图事务执行。必须在多节点真实重启、ZIP 和故障注入中证明效果，再考虑默认启用。不能以 HTTP 多次请求代替一个 Task 事务。

本轮原有 13 项未提交用户文件保持不变，不触碰或纳入 Git 提交。
