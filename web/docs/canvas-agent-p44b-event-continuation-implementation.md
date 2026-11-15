# P4.4b：外部终态事件驱动安全续行与重启恢复

> 日期：2026-11-15。状态：**已实现 P4.4b** 的 Job / ComfyUI / Skill 终态事件驱动的免付费安全续行。基线 [P4.4a 免付费安全续行](./canvas-agent-p44a-safe-continuation-implementation.md)。继续使用 SQLite **Schema v32**；无数据库迁移，无新 Provider/GPU/ComfyUI API、无付费 Job 自动入队。

## 1. 本轮范围

P4.4a 提供了显式 `/continue-safe` HTTP 入口及证据验证，本轮增加真实运行时完成后的通知与持久恢复：

- `JobCoordinator` 在 Job `succeeded/failed/cancelled/submission_unknown` 的 **SQLite 状态事务提交、Lease 释放之后**，提供 `onTerminalCommitted(jobId,status)`。本轮亦覆盖已确认的远程取消和人工验证失败的 ComfyUI 对账；未确认的远程取消继续保持 `running`。
- `CanvasMaterializer` 在已经保存结果并提交 Graph + `materializations` 后，使用 `onSettled({artifactId,status})` 通知 `materialized` / `blocked`。`runOnce` 与 `recoverPending` 都支持；`retry` 结果不通知续行。
- `executeAssistantSkillStep` 先由原有 `settleAssistantSkillRun` 事务记录 Run/Attempt/Step/Task 回执，才调用可选 `onSettled(runId,status)`；即使通知抛错，也不回滚已保存的 Skill 结果。Skill `started/submitting/needs_reconcile` 永不重新启动子进程。
- `createAssistantTaskContinuationEvents` 接收**只有 ID 的非权威提示**，从 SQLite 反查 `assistant_task_attempts` / `assistant_task_steps` / `jobs` / `artifacts` / `materializations` / `skill_script_runs`，限定当前 Project、Plan Version、非归档、未取消，并调用 P4.4a `continueAssistantTaskSafely`。只有服务器可信的终态和落图证据可解锁 Skip/Join。
- 自动通知不自动运行下一项模型、ComfyUI、Skill，不创建新 Job，不新建 Canvas Step，不修改用户提示词，也不执行 Provider POST。下一项需单独用户审批与已有冻结 `actionDigest` / Plan Version 校验。

## 2. 事件持久性和恢复

### 在线路径

`Job/ComfyUI 完成事务 → onTerminalCommitted → SQLite 证据复读 → P4.4a 对账 / 免费 Skip / Join → Task 事件`

`Materialization 落图事务 → onSettled → SQLite 证据复读 → P4.4a 验证素材/回执 → 下一项等待审批`

`Skill 结算事务 → onSettled → SQLite 证据复读 → 只读验证／状态刷新`

通知队列仅在内存保存 `kind + sourceId`，不保存凭证、Provider 消息、媒体正文或执行权限。队列合并相同来源提示并限制 1024 项。每次结果处理使用来源 ID、Task ID、计划版本、**持久证据状态**计算稳定的请求幂等键；P4.4a 依旧在独立 `BEGIN IMMEDIATE` 内复验所有许可。

### 启动补偿

进程可能在「Job/Materialization/Skill 结果已提交」与「通知已消费」之间退出。因此 `runtime.mjs` 在已有 Task/Job/Skill 启动恢复完成后，执行一次**有界本地 SQLite Catch-up**，读取至多 256 个待检查 Task，不触达 Provider、ComfyUI、GPU 或外部 Skill。用户仍可通过 `/continue-safe` 随时手动处理任何超出本轮扫描数量的 Task。

启动幂等键**不能仅使用 Task 的 `status`**：相同 `waiting_external` 状态下，可能在上次启动之后新增了可信 `materializations`。本轮用当前计划的 Step/Job/Materialization/Skill 状态与回执身份生成证据指纹；持久证据变化时，新的启动扫描不会命中上次的缓存。重复收到原终态、同一个 Job 在两个 SQLite 连接上竞争时也不会重复创建 Materialization/Skip/Join 或重新入队。

### 错误和退出路径

- 投递器异常不回滚原先已成功提交的 Job、落图或 Skill 回执；显式 `/continue-safe` 和下次启动仍能读取权威证据。
- `submission_unknown`、Skill `needs_reconcile`、缺失 CAS／落图、旧计划、取消和只读 ZIP 仍受 P4.4a 栅栏保护；不以超时、客户端事件、stdout 或伪造导入事件代替可信证据。
- **OpenAI 本地停止等待不等于远程取消**。如已保存 `job_local_wait_stopped`，即使 Job.status 是 `cancelled`，Task 也会以 `assistant_external_remote_cancel_unconfirmed` 进入 `needs_reconcile`，保留原 Job/Attempt 且不可按已验证失败自动重试或重新规划；真正确认远程取消而没有该标记时才走原终态失败路径。
- 外部 Job 终态和素材落图分开确认。只有真正存在的 Project Document 节点和 Materialization 记录足以解锁下一步。
- 当前会将有实际进展的服务端通知记录为 `assistant_task_events.kind='external_continuation_progress'`（仅任务／来源 ID、计划版本、检查点摘要、无媒体正文）。
- 不在 DB 提交事务内部调用续行协调器，防止 SQLite 嵌套事务、执行者死锁或覆盖原 Job 终态。

## 3. Task 面板实时体验

选中正在执行的 Task 时，Task 面板使用已有的 `subscribeSqliteJobEvents` 共享单个 Job SSE，订阅其 `result.jobId`。收到 Job 终态或 `artifact_materialized` 事件时：

1. 仅调用 `GET /assistant/tasks/:taskId` 获取服务端最新 Task/Step 状态。
2. 由既有状态依赖继续刷新 Run Sequence。
3. 检查当前 Task、会话和组件生命周期，拒绝旧请求污染新选择。
4. 不触发 `POST /enqueue`、`/run-skill`、`/external-jobs` 或模型生成；ZIP 历史 Task 不订阅。

Skill 是通过 Task `run-skill` 请求由同一 Task 面板启动，既有成功/失败响应后的只读 Task 刷新仍有效；没有增加自动重复执行或无授权的 Skill SSE。

## 4. 本轮修改

| 文件 | 变更 |
| --- | --- |
| `assistant-task-continuation-events.mjs` | 新增证据复读、投递、幂等和启动补偿 |
| `job-coordinator.mjs` | Job 终态提交后通知，含远程取消、可信失败复核 |
| `canvas-materializer.mjs` | Graph 与物化事务提交后通知 |
| `assistant-task-skills.mjs` | Skill Run/Attempt/Step 结算后通知 |
| `runtime.mjs` | 组装通知器、服务端实际接线、启动补偿 |
| `app.mjs`、`assistant-task-routes.mjs` | Task Skill 结算通知注入已有安全执行入口 |
| `canvas-assistant-task-state.tsx` | 共享 Job SSE 触发 Task 只读刷新 |
| `assistant-task-continuation-events.test.mjs` | Job/Materializer/Skill/真实 runtime/分支跳过/失败/崩溃恢复/双连接测试 |
| `job-coordinator.test.mjs` | 已确认远程取消和人工核对失败的提交后回调 |
| `canvas-assistant-task-state.test.tsx` | Job SSE 只读刷新与 ZIP 归档隔离 |

专项测试使用实际 SQLite、实际本地 BlobStore 与 Mock 模型适配器，覆盖正常 Job/ComfyUI/Skill 完成、事务后通知、自动 Skip、异常取消、双连接幂等、崩溃与启动恢复、只读 ZIP 和旧计划隔离。累计 **P4.4b 专项 14 项通过**；整组相关后端回归 **301 项通过**；前端 Vitest **169 个文件 / 1098 项通过**；TypeScript 检查及生产构建通过（仅原有大 Chunk/静态与动态导入并存的非阻断警告）。不同测试集有重叠，不应直接累加。不产生真实 Provider 费用，也不连接 GPU。

## 5. 尚未实施的 P4.4c

- 多步骤**预付费预算／一次性授权**策略与金额/次数上限、用户确认和预算消耗回执；不能把 Agent Run 的只读行为视作付费授权。
- 跨进程持久化的执行租约/Fencing/限流与异常终止通知的生产级调度。当前 P4.4b 只依赖单实例 Worker 的完成回调和既有 SQLite 启动恢复。
- Skill 独立进程主动监控／重连以及 ComfyUI/MiniMax 的真实远程故障演练；不可在没有验证结果的情况下直接执行新一轮生成。
