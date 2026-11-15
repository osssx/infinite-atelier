# P4.4a：Job / ComfyUI / Skill 的免付费安全续行协调器

> 日期：2026-11-15。阶段：**P4.4a 已实施：用户显式触发的一次安全续行**。这是 P4.4 的无新外部副作用子阶段，不代表自动发起下一轮付费 Job 或自动重跑 Skill。
>
> 基线：[P4.3 通用文本交付与修订](./canvas-agent-p43-structured-deliverables-implementation.md)、[P4.2c Agent Run/Canvas Step](./canvas-agent-p42c-step-coordination-implementation.md)。**继续使用 SQLite Schema v32**，无迁移。

## 一、为什么不再造外部 Executor

现有 `assistant_task_steps` / `assistant_task_attempts`、`jobs` / `artifacts` / `materializations`、`skill_script_runs` 与 Run Sequence 已提供 Server Commit、Task 级单活、动作摘要、计划版本、实际外部身份和回执来源。因此本轮没有建立另一个 Job/Skill 执行器，也没有引入不能和 Task/Step 同步对账的新运行表。

新增 `assistant-task-safe-continuation.mjs` 将已有证据协调为一个**显式且有界**的后续行动：

1. 检查 Task 不属于 ZIP 只读归档、当前 `activePlanVersion` 和调用者提交的 `expectedPlanVersion` 完全一致、没有已撤销的权威状态。
2. **仅使用本地 SQLite 已有 Job 状态**调用 `reconcileAssistantExternalTask`，复读 Job/Attempt/执行密钥/产物及落图结果。若 Job 完成但未落图，返回 `awaiting_verified_materialization`；若 `submission_unknown`，保留 `needs_reconcile`，不补发提交。
3. Skill 由已有 `reserveAssistantSkillRun` / `settleAssistantSkillRun` 保护，协调器只读其真实 Step/Attempt 状态。`started`、`submitting`、`needs_reconcile` 均不自动重新运行脚本；`succeeded` 仅用于观察已完成的可信回执。
4. 当 Run Sequence 从既有 Server Commit + Materialize 回执推导出 `skip_ready` 或 `join_ready` 时，使用其已有服务器验证命令 **`skipAssistantRunBranch` / `commitAssistantRunJoin`** 写入免付费的跳过/汇合检查点。单次调用最多处理 4 个检查点。
5. 检查点使用 `sha256(taskId,sequenceId,kind,index,evidenceDigest)` 导出的确定性幂等请求 ID；每条检查点命令本身通过 `BEGIN IMMEDIATE` 验证状态和证据。即使协调器在两个独立事务之间崩溃，第二次调用也不会多写分支/Join 或多建 Job。
6. 下一步若需要付费模型、ComfyUI 或 Skill，则**只返回下一步身份和 `requiresApproval=true`**。新的 Job 入队、Skill 启动、Graph 变更、用户选择产物和实际模型 POST 都不在此 API 内触发，继续使用各自的权限与审批入口。

任务完成条件仍受 `mayCompleteAssistantTask` / `deliverable_required` 守护：`skip` 末分支只能在服务端不存在额外交付要求时关闭 Task。文本交付依旧需要 P4.3 验证器复读图和审批/回执后才能最终完成。

## 二、API 与前端

新增：

`POST /api/v1/projects/:id/assistant/tasks/:taskId/continue-safe`

请求：

`{"requestId":"valid-id","expectedPlanVersion":1}`

返回主要字段：

| 字段 | 含义 |
| --- | --- |
| `taskStatus`、`sequenceState` | 服务端当前真实 Task 和 Sequence 状态 |
| `reconciledJobs` | 本轮已核对并推进的现有 Job/落图状态条数 |
| `checkpoints` | 本轮已原子记录的免付费 skip / join 回执 |
| `next` | 下一目标的冻结 Index、类型与节点 ID；没有则为 null |
| `requiresApproval` | 下一步须保持单独审批，不表示已获批 |
| `reason`、`requiresManualReview` | 状态不明、缺少物化、需要人工选择或重新规划的原因 |
| `steps` | 当前计划下 Job / ComfyUI / materialize / Skill 的受限审计摘要 |
| `executionStarted=false` | 本次协调调用没有启动任何新外部执行 |

`requestId` 返回幂等缓存。**即使返回的是旧命令缓存，也会先复核当前 Task 的只读状态和最新计划版本**；Task 已被取消或进入未知状态时，不返回旧的审批提示。想读取后来新增的 Materialization/Skill 回执时，应使用新的 `requestId`，不能把缓存当实时状态。

Task 面板新增**“安全续行（不提交新生成或 Skill）”**按钮。它只在当前 Task 存在外部 Step 或 Run Sequence 时显示；手动点击后刷新 Task/Sequence，展示已提交的可信检查点以及仍需单独审批的付费步骤。原有 `/reconcile`、Job 入队与 Skill 审批入口保留，界面不自动调用付费接口，也没有后台轮询或定时任务。

## 三、安全与恢复边界

- **禁止静默费用**：安全续行模块无 `submitJobInTransaction`、`runSkillScript`、HTTP Provider POST / 模型修复调用，也不创建新 Canvas Step。
- **结果不明绝不重试**：包括 Provider 提交未知、Skill 子进程启动后未知、CAS 缺失、物化未完成。返回状态供人工检查，不更换 Request ID 偷偷重试。
- **取消、归档、计划撤销**：入口及幂等缓存前必须检查；旧计划 Job 缺失证据不能覆盖新版计划的 Task 状态。受保护的 `read_only` ZIP 记录仅历史展示。
- **容错与竞争**：检查点按稳定事件来源去重；SQLite 两连接同 Request ID 或不同 Request ID 竞争均最多生成一次可信 Skip/Join。聚合响应写入最后的独立事务，**在最终 BEGIN IMMEDIATE 内再核对当前 Task 身份、计划版本、状态、Graph Revision、Active Step 和取消标记**；中途状态发生变化则拒绝缓存过期的下一步提示。因此崩溃后必须重新从权威 Task/Step/Job/Materialize 读取，不能凭半成品响应恢复。
- **授权不升级**：`agent_run_completed`、Skill stdout、客户端 status、ZIP 事件及模型自称成功都不构成完成、入队或继续执行的权限。新的付费 Job 仍需用户确认和原有冻结 `actionDigest`/`planVersion`。

## 四、代码、专项验收与后续

| 文件 | 修改 |
| --- | --- |
| `web/server/backend/assistant-task-safe-continuation.mjs` | 新增有界、幂等、证据驱动的安全续行 |
| `web/server/backend/assistant-task-safe-continuation.test.mjs` | 实盘 SQLite/HTTP/崩溃/双连接/Job/ComfyUI/Skill/ZIP/交付完成栅栏验收 |
| `web/server/backend/assistant-task-external-jobs.mjs` | 旧计划缺失 Job 证据不能污染当前任务 |
| `web/server/backend/assistant-task-routes.mjs` | 新增严格 body Schema 的 `/continue-safe` POST |
| `web/src/features/canvas-assistant/canvas-assistant-task-state.tsx` | 显式安全续行按钮与结果展示 |
| `web/src/features/canvas-assistant/canvas-assistant-task-state.test.tsx` | 验证 UI 仅调用免付费协调端点 |

本轮专项测试共 **20 项**，均使用真实 SQLite（内存、备份后重启及两个磁盘连接）、Mock 任务结果与 HTTP 注入，包含多客户端幂等与**最终写回前的 Graph Revision 变化拒绝**。相关 Job/Skill/Run Sequence/交付物后端回归 **180 项通过**；前端 Vitest **169 个文件、1095 项通过**；TypeScript 类型检查及生产构建通过。构建仅有大 Chunk / 非有效动态导入的非阻断警告。测试组有重叠，不应直接相加。未连接真实 Provider/GPU/ComfyUI。

### P4.4b 留待下轮

1. 针对真实 Job 状态转移设计 **事件驱动** 的安全对账通知（仍不可自动重复提交）。
2. 在单独确认的预算与策略下，评估预授权连续 Job 的代付/多轮执行；不得复用“只读 Agent Run”作为付费授权。
3. 完成真实 ComfyUI / MiniMax / Skill 子进程恢复行为验收，以及失败后人工安全对账 UX。
4. 如需真正的跨进程持久自动调度器，须重新审查 Task 级所有权/租约/Fencing 与数据库 Schema 升级备份方案。
