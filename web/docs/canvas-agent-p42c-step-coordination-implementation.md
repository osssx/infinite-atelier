# P4.2c：Agent 决策与 Canvas Task Step 可信关联

> 实施日期：2026-11-14。阶段范围：**已完成只读 Agent Run 的图操作提案 → 冻结 Canvas Step → 人工审批 → Claim → 原子提交 → 可信回执**。不是“模型可以直接写画布”，也不是完整的外部 Job/Skill 自动继续。
>
> 基线：`4e49941`（修正混合指令与连接读取）、P4.2b `e7222a2`。
>
> 相关文档：[P4.2b 持久 Run](./canvas-agent-p42b-agent-run-ledger-implementation.md)、[P4.2a 只读工具](./canvas-agent-p42a-read-tool-runtime-implementation.md)。

## 决策与安全边界

本轮**继续使用 SQLite Schema v32**，不创建第二套模型写入接口、不改写现有 `assistant_task_steps` / `assistant_task_attempts` 的约束，也不允许任何只读工具直接执行 Canvas/ComfyUI/Skill/Job。

`agentRunId` 只是传入服务端的候选 Run 标识。服务器在冻结 Canvas Step 的**同一个 SQLite 事务**里检查并固化如下证据：

1. 同一 Project/Task 下存在已完成的 `model_infer` 命令，且具有真实的 `model_command_started.agentReadTools` 记录和至少一个成功的 `assistant_model_calls`。
2. `runId` 必须由 `projectId + taskId + requestId` 确定性计算，不能由客户端伪造或跨 Task 复用。
3. Run 的来源必须对应当前 Task **最新冻结的用户 Turn**；过期指令不能直接据此制定新 Step。
4. 从模型命令 `response_json.actions` 中剔除非 Canvas Graph 动作（`run_node/run_workflow`），剩余动作必须与本次规划传入的 Graph 动作**整体、严格一致**。拒绝局部截取、调换内容或拼接其他模型结果。
5. 记录 `agentRunBinding = {runId,requestId,planVersion,responseDigest,actionsDigest,modelCalls}`；并将 `agentRunId`、`agentOutputDigest`、`agentActionsDigest` 写进 Step `action_json`，因此已有 `actionDigest` 同时覆盖动作和 Agent 来源，审批与 Claim 无需新协议。
6. Step `preconditions_json` 保存完整绑定并参与现有冻结 Snapshot。规划前调用完整 Snapshot 的 **32 KiB** 限额校验，避免事后 Claim 失败。

**未带 `agentRunId` 的旧 Task Planner 路径不被升级为 Agent 权限**，保持原有人工审批/服务端冻结要求；带 `agentRunId` 的规划必须满足上述全部服务端条件，不能通过 Run 详情或客户端模型文本获取授权。

## 执行协调

| 阶段 | 可信证据 | 不允许发生的操作 |
| --- | --- | --- |
| Model Run completed | 持久模型命令 + Model Call 成功记录 | 不代表 Step 或 Task 已执行 |
| Agent Step frozen | `agent_step_bound`、冻结动作/回复摘要和 `waiting_approval` Step | 不修改 Graph |
| User approve/reject | `agent_step_approved` 或 `agent_step_rejected` 同事务持久化 | 拒绝后不能 Claim |
| Step Claim | 每次复核完整 Run 绑定；`agent_step_claimed` 与 Prepared Attempt 同事务 | 不开始 Provider/Job |
| Graph commit | 再次复核绑定；图修订、`server_committed` 回执与 `agent_step_committed` 同事务 | 故障中途必须整体回滚 |

Agent Run 的原始冻结 Turn 若随后被新用户 Turn 替代，审批、Claim 与 Graph 提交都会拒绝旧决策（`assistant_agent_run_turn_stale`）。即使模型回复被篡改或源权限已收回，用户仍可**拒绝**等待审批的 Step 并按公开重规划流程修订。

**Run completed 与 Task completed 不是同一个状态。** Run 详情通过权威 `assistant_task_steps` 关联，单独提供 `agentStep.status`、`approval`、`receiptTrusted`、`superseded`。历史 ZIP 导入的只读 Task 仅能查看旧记录，`historicalOnly=true` 且不会暴露为新的可信执行授权。

Run Transcript 的白名单新增 `agent_step_bound` / `approved` / `rejected` / `claimed` / `committed`；仅记录 Step ID、摘要、计划版本和回执摘要，**不保存私密模型输出或未授权节点正文**。

## 前端与浏览器刷新恢复

`canvas-assistant-panel.tsx` 在服务端返回 `agentRunId` 时，将它随模型提出的**Graph 操作**传入 `planAndExecuteAssistantCanvasActions`。冻结时传一次，后续 Approval/Execute 仅使用 Step ID、`actionDigest`、`expectedPlanVersion`，防止浏览器在审批后暗改动作。

浏览器关闭或刷新后，已冻结为 `waiting_approval` / `ready` 的 Canvas Step 沿用现有 Task 面板 `executeFrozenAssistantCanvasTaskStep` 恢复，Task 面板显示对应的 Agent Run ID。没有重新规划或重新调用模型的隐藏流程；**若模型调用结果未知，仍走 P4.2b 的 `needs_reconcile` 而不是自动重发。**

本轮不将 `run_node` / `run_workflow` 的外部生成执行与模型 Run 绑定；它们继续走原有独立 Job/Step 审批链，待 P4.4 处理真实外部执行的持久协调。

## 变更文件

| 文件 | 作用 |
| --- | --- |
| `web/server/backend/assistant-agent-step-coordinator.mjs` | 冻结前校验 ModelCommand/来源 Turn/输出摘要；审批和提交复核；从权威 Step 投影状态 |
| `web/server/backend/assistant-agent-step-coordinator.test.mjs` | P4.2c SQLite、Mock Provider、HTTP、拒绝、故障回滚、ZIP 归档测试 |
| `web/server/backend/assistant-task-canvas-executor.mjs` | 规划、完整 Claim 限额、Graph 原子回执绑定 |
| `web/server/backend/assistant-task-step-gate.mjs` | Approval/Claim 再校验以及协调事件 |
| `web/server/backend/assistant-task-routes.mjs` | 规划接受可选 `agentRunId`；Run 详情展示权威 Step 状态 |
| `web/server/backend/assistant-agent-run-ledger.mjs` | Transcript 添加受限 Step 生命周期事件 |
| `web/src/features/canvas-assistant/canvas-assistant-task-execution.ts` | 冻结时转发 Run ID，后续只提交 Step 身份 |
| `web/src/features/canvas-assistant/canvas-assistant-task-execution.test.ts` | Browser 请求只传冻结 Run 身份、审批后不重复提交动作 |
| `web/src/features/canvas-assistant/canvas-assistant-panel.tsx` | 将已完成 Agent Run 关联到真实 Graph Step |
| `web/src/features/canvas-assistant/canvas-assistant-task-state.tsx` | 恢复面板显示 Run → Step 关联身份 |
| 本文件 | 实施约束与验收记录 |

## 验收边界

测试必须覆盖完整 Mock Provider → Function Tool → HTTP Planner → 用户审批 → Graph Executor 回执，审批拒绝、重复执行、跨 Task/过期 Run/变更动作、浏览器刷新后原 Step 继续、篡改绑定、事务失败回滚及只读 ZIP 不可授予权限。以上测试不会调用真实 Provider、ComfyUI 或 GPU。

本轮完成的自动化验收：**P4.2c 专项 16 项通过；相关 Agent/Task 后端回归 150 项通过；前端 Vitest 168 个文件 / 1083 项通过；TypeScript typecheck 与生产构建通过**。各测试批次存在重叠，数量不可直接相加。构建存在大 Chunk、无效动态导入的非阻断优化警告。

待后续阶段：多步依赖 Agent 的调度、Job/Skill 自动续行、恢复中间工具输出和完整长期 Transcript，以及真实 Provider 质量验收。**不把 P4.2c 视为完成整个 P4。**
