# P4.5b：Task 可信媒体输入自动绑定与一次本地 ComfyUI 生成

> 2026-11-15。基线：P3c 可信媒体输出/绑定、P4.4c 有界 Job 次数授权与 P4.5a 静态本地 ComfyUI 顺序执行。**无 SQLite schema 迁移、不新增外部请求执行器**。这是已明确批准的单一媒体链，不是任意节点、任意图片或多候选的自动生成。

## 流程

用户在同 Task 的 Run Sequence 中确认上游图片（或视频/音频）生成与下游 `run_workflow.inputFromPrevious` 媒体端口意图。任务面板显示下游节点、指定端口、当前本地 ComfyUI 实例和单次执行权限。用户勾选后服务端发放 `mode="local_comfy_media"` 的 v3 Budget Grant，最多 1 次新 Job、默认有效期 30 分钟。**授权不提交任务、也不会修改画布**。

只有上游 Job 成功、原 Artifact 与 CAS Blob 完整一致、图节点已落图且 Task Materialization 具有 `server_committed` 回执、并且恰好一个来源种类匹配的可信产物时，浏览器在画布打开且 Task 有效期间尝试自动续行：

1. 服务端用冻结的 Run Sequence、当前模板版本/完整模板内容、目标节点及端口、Comfy 实例 URL 等校验授权；原有 P3c 校验同时确认唯一来源身份和端口类型。
2. 通过 Task `canvas-steps` 冻结唯一的 `connect_workflow_port`，带上 `runMediaGrantId`。审批 `/approval` 携带原 `grantId`；服务端在审批、claim 和原子图提交中重新验证 Grant 与唯一 CAS 来源。原图变更仍由 save barrier 同步本地画布，提交回执不可伪造。
3. 连线成功之后使用原 `executeComfyWorkflow` 生产路径冻结下游工作流请求，并用已有 Task `external-jobs` → `enqueue-authorized`（而不是普通 `/jobs`）提交。`BEGIN IMMEDIATE` 内核对授权、连接回执、当前最新 revision、固定模板版本及内容、输入覆盖、输出捕获端口、唯一外部 CAS 资产与边、Comfy 实例和执行次数，原子创建 Job/Attempt/Step 以及 `run_budget_consumed` 账本。
4. 旧 Job 的幂等提交回执优先；`submission_unknown` 永不自动重发。撤销授权不会悄悄取消已提交的 Job。原 JobCoordinator 拥有本地 Comfy 提交、轮询、捕获、重启恢复及并发控制。

## 安全限制

- 目标必须是已存在的 `comfy:workflow` 节点，有冻结修订号与可信类型匹配端口（`IMAGE`、`VIDEO`、`AUDIO`）。冻结时不允许已被连接的输入、`comfyMediaPreset` 或上游条件分支。
- 只处理明确的 `sourceKind` 和 `toPortId`，只使用**上一 RunIndex** 的唯一可信、CAS 可寻址媒体节点；即使存在先前用户选择，多个同类型候选仍要暂停，不能在自动执行中猜选。
- Grant 冻结下游目标节点摘要、模板修订号、完整模板摘要、捕获输出端口、Comfy 实例和 URL 摘要；重指向实例、更换模板/参数、CAS 缺失或输入图变更均不能使用原 Grant。
- 单次授权只能批准一条真实画布连线和一个本地 Comfy 工作流；不能夹带标题编辑、额外输出、任意 graph edges、额外 media inputs、额外快照字段或 `runOptions`。
- Grant 失效、次数用尽、取消/撤销、结果未知、临时断线或 Task 只读状态时自动续行停止；失败后不会在当前画布会话中自动重复入队。重新启动客户端时，以服务端 Step/Job/Grant 状态为准，而非重放浏览器猜测。
- 未确认的画布/媒体输入继续沿用 P3c 人工选择、连线确认和下游生成审批流程。此前 P4.4c 模型授权 v1 与 P4.5a 静态 Comfy 授权 v2 不自动扩权。

## 修改位置

| 文件 | 内容 |
| --- | --- |
| `web/server/backend/assistant-task-run-media-grant.mjs` | 新增单次媒体链权限、来源与模板安全核验 |
| `web/server/backend/assistant-task-run-budget.mjs` | 在原持久账本里增加独立 mode v3 与原子 admission |
| `web/server/backend/assistant-task-canvas-executor.mjs`、`assistant-task-step-gate.mjs` | 画布连线 plan / approve / claim / commit 逐层校验同一授权 |
| `web/server/backend/assistant-task-routes.mjs` | 按严谨 JSON Schema 扩展明确的媒体授权字段 |
| `web/src/pages/canvas/project.tsx`、`web/src/features/canvas-assistant/canvas-assistant-panel.tsx`、`canvas-assistant-task-execution.ts` | 传递本地 Comfy 实例和一次绑定 Grant，复用现有 Save Barrier/Task 工作流 |
| `web/src/features/canvas-assistant/canvas-assistant-task-state.tsx` | 用户明确同意与单次 Job 的自动续行、撤销 |
| `web/server/backend/assistant-task-run-binding.test.mjs`、`web/src/features/canvas-assistant/canvas-assistant-task-state.test.tsx` | 真实 SQLite/HTTP、媒体唯一性、CAS 失效、模板变更、撤销、幂等与 UI 同意测试 |

## 验收边界与后续

最终验收：**相关后端联合回归 249 项通过**（含 P4.5b SQLite、HTTP、伪造快照、撤销及多候选安全测试），前端 Vitest **169 个文件 / 1112 项通过**；TypeScript 类型检查与 Vite 生产构建通过。构建有非阻断的动态导入与大 Chunk 警告。没有执行真实本地 GPU 或第三方工作流端到端操作。

本轮测试使用真实 SQLite、Task/Canvas/Job 路径与 HTTP 路由；本地 ComfyUI GPU 仍是 Mock/未直接连接真实硬件。不能声称已验收真实 ComfyUI H3 图生视频、显存占用、远端中断或任何第三方自定义节点。后续 P4.5c 可以先用真实 MiniMax H3 I2V 工作流与实际 ComfyUI 进行端到端验收，再补充视频长任务超时、断线、取消及重启恢复专项用例。必须保留多产物歧义阻断及未知提交不自动重试。
