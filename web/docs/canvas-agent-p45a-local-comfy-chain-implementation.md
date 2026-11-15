# P4.5a：本地 ComfyUI 静态工作流的受限连续执行

> 2026-11-15。阶段：**本地 ComfyUI 同模板、无外部媒体端口的顺序工作流**，不是任意图生视频/动态端口无人工确认自动化。基线：[P4.4b 可信终态续行](./canvas-agent-p44b-event-continuation-implementation.md)、[P4.4c 有界 Job 次数预授权](./canvas-agent-p44c-budget-authorization-implementation.md)。保留 SQLite Schema **v32**；不对在线渠道金额结算继续投资。

## 目标与边界

从「用户必须每一步手动确认」扩展到「用户先手动批准一个真实本地 ComfyUI Step，再明确确认一个有界连续授权，由现有画布 ComfyUI 生成器执行其余同模板、同参数的静态工作流」。具体过程：

1. AI 助手将 2～4 个已有、已绑定模板的 `run_workflow` 节点登记为 Run Sequence；初始 WorkFlow Step 仍通过原 `/external-jobs` → `/approval` → `/enqueue` 人工确认。
2. 已批准 Step 的不可变 Job Snapshot 包含实际 Comfy 模板 JSON、实例 ID、模板版本、参数覆盖、输出捕获端口；服务端将这些组成一个**严格冻结的本地 Comfy 范围**。
3. 用户在 Task 面板确认最多 1～4 次新 Job、允许的 RunIndex 与 30 分钟有效期，产生独立 `mode="local_comfy"` 的 v2 Grant。
4. 前一项 Job 的运行状态、Artifact、CAS Blob、Graph Materialization 和 Task 回执通过 P4.4b 持久校验之后，Run Sequence 进入 `ready`；在当前画布开启的前提下，面板通过 **原有** `executeComfyWorkflow` 和 `startBackendComfyWorkflowRun` 构造下个真实 Comfy 快照。
5. 后端在 `enqueueAssistantExternalJobStep` 的同一 `BEGIN IMMEDIATE` 里核对 v2 Grant、冻结模板的完整 JSON、参数、实例、端口、当前节点/源指纹、上一项 CAS 证据、剩余次数/有效期以及 Task 状态。随后原子写入 `jobs`、Task Step、Attempt、`run_budget_consumed`，再由原 JobCoordinator 和 Comfy 适配器执行（Comfy 后端的 `comfyConcurrency` 仍限制实例并发）。
6. 产物经真实 Materializer 落入 Graph 之后，可信事件触发下一项等待；重复 HTTP、两个 SQLite 连接争抢、重启补偿不会重复生成或超出 Grant 次数。

**没有新外部 Executor、GPU 计费 API 或数据库迁移**。P4.4c v1 `model_job` Grant 保持独立且兼容，默认未传 `mode` 时仍为模型授权。

## 安全校验

本轮 `frozenLocalComfyScope` 只允许以下情形：

- 目标为已有 `comfy:workflow` 节点，且没有进入该节点的 Graph 边，且没有 `comfyMediaPreset` 或 `inputFromPrevious`。
- `comfyRequest.schemaVersion=2`，一个根工作流节点；只能包含明确的源输出端口（模板定义的可捕获 source port），无 `edges`、`externalInputs`；`runOptions={}`，模板修订号和完整模板体由先前人工批准冻结。
- 授权期间目标节点必须仍保持同一模板 ID、修订号、`inputOverrides`；其源指纹必须与创建 Grant 时相同。
- Comfy 实例 ID、模板体（含内部 Graph、捕获适配器及端口）、参数、输出集合必须与原 Grant 全部一致。允许浏览器每次更换临时幂等 ID 与自动保存后正常变化的画布 Revision；但在最终入队时强制 `comfyRequest.canvasRevision` 等于服务端最新 Revision。
- 上一项 Task 必须具有实际可信 Job/Materialization/CAS 和无损证据。CAS 丢失或原分支回执失效都不能启动第二项。
- 取消、ZIP 只读、计划版本变化、额度耗尽、授权过期、撤销、模型版本或 Comfy 模板切换都不能自动入队。`submission_unknown` 不重试，已提交 Job 不因撤销而悄悄取消。
- 任务的「下一步自动提交」只在当前画布打开时生效；每个 Grant/Task/Index 在当前 UI 挂载期间最多自动尝试一次。若生成器已完成 Job 入队但 HTTP 响应丢失，服务端重复请求返回原 Job 身份，不创建第二个。

**动态图生视频尚未纳入自动授权范围**：例如上一项生成图片后需要 `connect_workflow_port`、输入媒体自动上传、首帧/尾帧引用、输入候选选择、混合模板链。这些仍使用已实现的 P3c 可信候选、用户选择、明确画布绑定审批，再单独确认执行。不能因上一项输出单一就跳过既有动态媒体核对。

## 代码与用户界面

| 文件 | 变更 |
| --- | --- |
| `web/server/backend/assistant-local-comfy-scope.mjs` | 新增完整 Comfy 模板、版本、参数与输出根端口范围校验 |
| `web/server/backend/assistant-task-run-budget.mjs` | 新增 `mode=local_comfy` 的 v2 Grant；核验与额度占用仍与 Job 原子入队 |
| `web/server/backend/assistant-task-run-sequences.mjs` | P4.4c 的入队前 CAS/分支校验扩展到可信 Comfy 工作流 Step |
| `web/server/backend/assistant-task-routes.mjs` | `/run-budget` JSON schema 支持显式 Comfy 模式 |
| `web/src/features/canvas-assistant/canvas-assistant-panel.tsx` | 在已授权且无待连线输入时允许原生产 Comfy 执行器提交 |
| `web/src/features/canvas-assistant/canvas-assistant-task-state.tsx` | Task 面板选择本地 Comfy 静态授权、显示模板与实例、撤销、自动启动已验证下一项 |
| `web/server/backend/assistant-local-comfy-scope.test.mjs` | 真实 SQLite / HTTP / Comfy Mock / BlobStore / Materializer / Task 事件 / 两连接回归 |
| `web/src/features/canvas-assistant/canvas-assistant-task-state.test.tsx` | 前端明确授权与动态媒体输入隔离验收 |

## 验收限制与后续

专项测试使用**真实 SQLite、原本地 JobCoordinator、真实 CAS BlobStore + CanvasMaterializer**，但 Comfy Adapter 的 Submit/Poll 为 Mock；没有连接实际显卡或真实 ComfyUI，不能声称显存占用、远程取消或不同实际自定义工作流的兼容性已验证。最终验收：**P4.5a 专项 11 项通过**，含真正的 SQLite + Mock Comfy Adapter / JobCoordinator / BlobStore / Materializer 两步顺序闭环、完整产物回执、CAS 丢失、无捕获输出拒绝、无独立审批拒绝、提前启动/取消阻断、两连接并发、HTTP 重复回执与未改变的计数。
相关 ComfyUI/Task/Job 后端联合测试 **301 项通过**（专项属于该集合，不应累加）；前端 Vitest **169 个测试文件、1108 项通过**；`npm run typecheck` 与 `npm run build` 均通过。生产构建仅有大 Chunk/静态与动态导入并存等非阻断警告。

所有测试统计以本轮最终工具输出为准。

**P4.5b**：在严格的同 Task 信任链中，逐步支持唯一、类型匹配、真实 CAS 的上游媒体→下游 Comfy Input 绑定（先生成独立预览与授权，再考虑无二次点击）；加入真实 Comfy 断线、取消、重启与 GPU 资源恢复演练。对于多个媒体候选、端口冲突、来源变化、表单必填或动态文本条件，继续停止并要求用户确认。
