# P4.4c：冻结 Run Sequence 的受限预授权与 Job 次数预算

> 2026-11-15。实现状态：**P4.4c 的模型 Job 次数预授权、授权内连续生成与撤销已实施**。基线：[P4.4b 外部任务终态安全续行](./canvas-agent-p44b-event-continuation-implementation.md)。SQLite Schema **v32 不变**，无数据库迁移、无新外部收费 API。

## 一、范围与不可承诺事项

本阶段允许用户在 Task 面板**明确勾选同意**后，对同一个已冻结的 Run Sequence 中特定的 `run_node` 模型步骤授权 **1～4 次新增 Job**（界面默认 1 次，30 分钟有效）。服务器使用现有 `assistant_task_events` 和 `assistant_task_commands` 作为持久账本，不新建队列或覆盖原有 Job/Task/Attempt 权威记录。

**次数上限不等于金额上限。** 现有 Provider 没有统一、可信的事前货币报价和实际收费回执，因此不能保证特定美元预算。这一轮的硬约束是最多允许多少个 Job 在此预授权下被原子入队，而不是实际费用。需要货币硬上限时必须先实现独立的可靠渠道报价、用量/收费回执和预留/结算协议。

下列操作仍**必须独立批准**：ComfyUI `run_workflow`、带 `inputFromPrevious` 的动态工作流端口连接、Skill 脚本、Canvas 事务、模型/渠道/生成类型变更、未知结果后的重试与重新规划。自动执行仅在原 Canvas 页面打开且具备已授权 Job 的客户端生成器时尝试；关闭画布期间服务端仍只做 P4.4b 可信免付费 Skip/Join，不在后台自行创建付费快照或新 Job。

## 二、授权的冻结与范围

`POST /api/v1/projects/:id/assistant/tasks/:taskId/run-budget`（显式 `confirmed:true`）：

- `sequenceId`、`activePlanVersion`、`intentDigest` 锁定具体 Task 和 Run Sequence，拒绝跨项目、旧计划、只读 ZIP、取消和结果未知的 Task。
- `allowedIndices` 锁定计划中允许连续执行的索引，只支持已验证的 `run_node`（最多 4 项）；`maxJobs` 为允许在本次授权下新增的 Job 总数；过期时间以**服务端时间**计算。
- 先前至少存在一个**人工批准的、真实冻结的 `model_job` Step**，将其 Provider、模型、类型、Channel ID 和 Secret Version Reference 计算为不可变授权范围摘要 `modelScopeDigest`。后续模型/渠道不同会在 Job 创建前拒绝；不把用户模型选择或模型生成建议当作权限。
- 所有允许的目标节点内容、参数和布局一起生成 `nodeDigest`。修改节点内容/参数/连接相关节点数据会使旧授权不能用于改动后的请求。运行时仍调用原有 Task Job 冻结、依赖、项目 Graph Revision、源指纹、Comfy/模型 Snapshot 校验。
- 同一 Task 同一时刻至多存在一个有效授权；过期、用尽、撤销和计划变更后可另行取得明确授权。

读取：`GET .../:taskId/run-budget` 获取当前最近授权；`GET .../:taskId/run-budget/:grantId` 获取指定授权状态。撤销：`POST .../:taskId/run-budget/:grantId/revoke`（`requestId`）。撤销只禁止**未来的自动入队**，不宣称取消已提交的 Provider/GPU 工作。

## 三、入队原子性与不会重复计费的边界

`POST .../:taskId/steps/:stepId/enqueue-authorized` 请求携带 `requestId`、`expectedPlanVersion`、`actionDigest` 和 `grantId`。

该端点最终仍调用 `enqueueAssistantExternalJobStep`，但是在**同一个 SQLite BEGIN IMMEDIATE** 中：

1. 复读 Task、冻结 Step、Run Sequence、当前项目节点、授权事件账本、撤销状态、服务端有效期和剩余额度。
2. 确认本次 Step 属于允许的 `runIndex`、`model_job`、目标节点与授权节点摘要一致，实际 Job Snapshot 的 Provider/Channel/版本/类型/模型摘要与授权锚点一致。
   **再验之前每项可信 Job、Materialization、CAS Blob 和条件分支跳过证据**：即使 Step 已在先前冻结，只要入队时发现上一项 CAS 丢失、物化回执失效或分支证据不一致，也必须在创建下一 Job 之前拒绝。
3. 仅对匹配授权的 `waiting_approval` Step，在同一事务里生成可审计 `approval_json.grantId`；不调用普通客户端“假确认”接口。
4. 在同一事务内写入原有 `jobs`、`assistant_task_attempts`、`assistant_task_steps` 与 `external_job_queued`；同时追加 `run_budget_consumed`（Grant ID、Step ID、Job ID 和 runIndex）。
5. 原事务任何一步失败，则 Job、Attempt、授权批准和预算占用全部回滚；同一个 Step 不会因为不同客户端 Request ID 重复入队。预算额度在**队列提交时保守占用**，不因后续失败自动退回，也不会自动重试上游不确定的提交。

未携带授权 ID 的旧 `/enqueue` 继续保持**逐项人工批准**语义。普通客户端请求不能仅设置 `confirmed:true` 或复制已冻结动作绕过预算核验。结果缺失、`submission_unknown`、撤销、计划变化、图/节点变化时都只能停止并给出对账提示。

## 四、客户端用户体验

Task 面板的顺序计划区新增：

- 可选择**最多 1～4 次 Job**，明确显示“次数不是金额上限”，需要勾选确认才允许持久化授权；授权固定 30 分钟（API 支持 1～1440 分钟范围）。
- 显示已使用/上限、有效期、模型 Provider/模型名称/生成类型、是否撤销；用户可随时撤销剩余授权。
- 使用原有项目生成器 `onRunActions` 构造并冻结下个 Job Snapshot；在有效授权内由 `submitAssistantTaskFrozenJob` 调用 `/enqueue-authorized` 而不是自行提交模拟 `/approval`。
- P4.4b 可信 Job 完成和物化事件刷新 Task/Run Sequence；**仅在画布当前打开、下一项为允许的 `run_node`、用户授权仍有效、项目未切换且额度未耗尽时**自动尝试。每个 Grant+Task+RunIndex 在当前挂载期至多自动发起一次；失败不会通过换 Request ID 偷偷重试。
- 手动“继续第 N 项生成（需审批）”依然走老的逐项批准；用户尚未授予预算时不自动付费。

## 五、主要修改

| 文件 | 用途 |
| --- | --- |
| `web/server/backend/assistant-task-run-budget.mjs` | 冻结授权、账本、读取、撤销和入队内的原子校验 |
| `web/server/backend/assistant-task-external-jobs.mjs` | 在原有 Task Job 原子入队中执行预授权核验、批准与额度占用 |
| `web/server/backend/assistant-task-routes.mjs` | 新增验证严格的预算读写和授权入队 HTTP API |
| `web/src/features/canvas-assistant/canvas-assistant-task-jobs.ts` | 基于授权的冻结 Job 提交路径；无模拟逐项批准 |
| `web/src/features/canvas-assistant/canvas-assistant-panel.tsx` | 传播授权 ID，阻断 Comfy 动态输入走自动路径 |
| `web/src/features/canvas-assistant/canvas-assistant-task-state.tsx` | 显式授权、额度选择、只读状态、撤销和 Canvas 开启时受限自动运行 |
| `web/server/backend/assistant-task-run-budget.test.mjs` | 真实 SQLite、双连接、HTTP、撤销、过期、跨 Task、变更模型、崩溃及预算回滚 |
| `web/src/features/canvas-assistant/canvas-assistant-task-jobs.test.ts`、`canvas-assistant-task-state.test.tsx` | 前端审批分流、次数确认、自动执行与 Comfy 排除 |

专项测试 **14 项全部通过**（含前置 CAS 证据在计划冻结后失效，原子入队被拒绝）；相关后端联合回归 **323 项全部通过**；前端 Vitest **169 个测试文件、1103 项全部通过**；TypeScript 类型检查和生产构建通过。测试集存在重叠，不应简单累加。生产构建有原有的动态/静态导入及大 Chunk 非阻断警告。未使用真实 GPU、模型 API 或真实账单。

## 六、后续工作

P4.4d 应首先实现真实渠道**价格/成本能力声明**和可审计预算预留/结算；只有当渠道能够证明实际价格上限时，才允许承诺美元预算。进一步自动执行 ComfyUI、动态输入或后台跨进程调度，需要独立地冻结工作流参数和动态输入依赖、提供持久 Worker/Fencing/租约以及明确的用户授权。不得把 P4.4c 的“固定模型同范围 Job 次数许可”误扩展为所有媒体生成的无限付费授权。
