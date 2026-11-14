# P4.2b 实施记录：持久 Agent Run、受限 Transcript 与安全恢复

> 日期：2026-11-14。实现状态：已完成 P4.2b **只读 Agent Run 账本与恢复栅栏**，不是通用写入/外部 Job 自动续行。
>
> 前序：[P4.2a 只读工具实施记录](./canvas-agent-p42a-read-tool-runtime-implementation.md)。
>
> 本轮未升级 SQLite Schema，仍为 `v32`，不触发 `database_schema_too_new` 兼容风险。

## 1. 核心决策：利用现有事务与事件，不创建第二套执行者

本项目现有 `assistant_task_commands`、`assistant_model_calls`、`assistant_task_events` 已具备请求唯一身份、同步事务、模型 POST 标记、结果未知拦截及 Task 级互斥。P4.2b **不新增 Run/Transcript 表**，以现有数据库权威记录 + 事件化投影实现：

- `runId = "ar_" + sha256({projectId,taskId,requestId}) 前 40 位十六进制`。身份与 Task、模型命令请求固定绑定，页面刷新或重复请求不会生成不同 Run。
- `agent_run_started` 与 `model_command_started`、`assistant_task_commands` 在同一事务提交。
- `agent_read_round_planned` 先于实际 Provider POST 持久化固定轮次；`agent_run_model_received` 与对应 `assistant_model_calls.status='succeeded'` 在同一事务提交。
- `agent_read_tool_completed` 仅持久化工具调用 ID、名称、轮次、来源 Revision、参数/结果摘要和字节数。
- `agent_run_completed` 与 `assistant_task_commands.status='completed'`、最终响应 JSON 在同一事务提交。**Run 完成永远不等于 Task 完成**，不能满足画布 Step、外部 Job 或 DeliverableSpec 的执行回执。
- 如果中断时已记录 Provider POST，调用/命令按照现有 `needs_reconcile` 机制恢复，Run 投影状态也为 `needs_reconcile`；禁止通过新 Request ID 为同一个 Task 偷偷发起第二次模型请求。
- 模型命令在实际 POST 前失败时删除其 in-progress 命令、记 `agent_run_preflight_released`；同一身份重新发起、重用 round 0 事件仅限 `assistant_model_calls` 不存在的情况。
- 实际模型 POST 预算在现有 `createAssistantModelObserver.start` 统一检查，包括格式修复等额外 POST。只读 Run 上限 **3 次实际 POST**，不是只统计工具轮数。

权威性原则：`assistant_task_commands` 和 `assistant_model_calls` 是真实执行状态来源，审计事件用于核查与安全投影。ZIP 导入的历史事件不能产生模型权限；归档 Task 的 `read_only` 限制保持不变。使用同步 SQLite 事务 CAS，无异步后台任务与租约时钟抢占。

## 2. Run 与 Transcript 查询接口（只读）

`GET /api/v1/projects/:id/assistant/tasks/:taskId/agent-runs?limit=20`

返回最多 50 个当前 Task 下的 Run：身份、状态、模型 POST 数量、未知 POST 数量、轮次、只读工具调用数、是否归档与恢复指引。

`GET /api/v1/projects/:id/assistant/tasks/:taskId/agent-runs/:runId?afterSeq=0&limit=50`

返回来源限定在该 Task/Run 的稳定 seq 分页 Transcript 和 Model Call Ledger 摘要。可按 `nextAfterSeq` / `hasMore` 继续读取，不需要重新调用模型。默认分页不超过 50 条，上限 100 条。

**隐私规则**：Transcript 白名单字段仅包括轮次、工具名、`callId`、`argsDigest`、`resultDigest`、`sourceRevision` 等；**不存模型原始回答、工具返回正文、API Key、完整 Provider payload 或未授权节点数据**。这是一份可审计的 *受限 Transcript*，而不是支持从任意中间状态重放模型对话的完整聊天记录。

服务端 `/assistant/chat` 在成功响应中附加 `agentRunId`；画布助手消息元信息显示 Run ID 和读工具调用数，以便查看任务诊断接口。

## 3. 状态与恢复策略

| ModelCommand 权威状态 | Run 投影 | 服务端行为 |
| --- | --- | --- |
| 新建且尚未 POST | `planning` | 持久身份与轮次计划；失败时安全释放 |
| 已有模型 POST 正在处理 | `reading` | 同 Task 新请求被 CAS 栅栏拒绝 |
| 模型命令完整保存 | `completed` | 旧请求幂等返回已缓存结果，不重计费 |
| POST 或其结果未知、启动恢复失败 | `needs_reconcile` | 必须人工对账；**任何同 Task 新模型请求均不能抢占** |
| 事务故障/计划中止 | `blocked`（仅存在对应命令时） | 不以事件自称成功，未形成可信 Task Step 回执 |

**恢复只恢复权威状态，不自动重新推理。** 本阶段没有自动 `POST /resume`：如果丢失的是模型结果、工具返回正文或 Provider 回执，仅凭摘要不能安全重建下一轮 Prompt。把状态恢复与自动续行分开可避免重复计费与提示词/授权串线。后续若要实现自动重放无副作用的读取阶段，需要单独评审加密存储、授权续期与全量 Transcript 的数据生命周期。

## 4. 变更范围

| 文件 | 作用 |
| --- | --- |
| `web/server/backend/assistant-agent-run-ledger.mjs` | 新增稳定 Run ID、权威状态投影、受限 Transcript 和 Run 列表 |
| `web/server/backend/assistant-agent-run-ledger.test.mjs` | 新增事务崩溃、双 SQLite 连接、HTTP、ZIP 归档、计费预算专项测试 |
| `web/server/backend/assistant-model-calls.mjs` | 将 Run 生命周期写入原有命令事务，强化未知 Run 占用和实际 POST 上限 |
| `web/server/backend/assistant-agent-read-tools.mjs` | Run ID 随轮次/工具元数据保存；每次读取重新验证活动 Run 所有权 |
| `web/server/backend/assistant-task-routes.mjs` | 新增两个只读 Run/Transcript HTTP 查询接口 |
| `web/server/backend/app.mjs` | 校验 Read Session 所有权，并在完成响应附带 Run ID |
| `web/src/features/canvas-assistant/canvas-assistant-panel.tsx` | 显示可用于排查的 Run ID 与只读工具次数 |
| 本文件 | 设计边界、恢复策略与验证证据 |

## 5. 验收与风险

- P4.2b 专项：稳定 ID、模型审计与 Run 完成原子性、故障中途回滚、分页隐藏私有正文、真实 HTTP 缓存、跨标签页/SQLite 连接互斥、启动后未知模型禁止重发、ZIP 只读归档、错误前安全释放、格式修复额外 POST 预算。
- 与 P4.2a、P4.1、P4.0 的兼容测试均使用 SQLite 内存/临时磁盘数据库及 Mock Provider。**没有真实 GPU/Provider/付费 Job**。
- 不覆盖真正的 ComfyUI/Skill 外部任务恢复；其结果以既有 Job/Step 可信回执为准。
- 大量 Run 的历史浏览仍应考虑按 Task/Run 增加专用索引；当前查询沿用 v32 的任务事件，避免为本阶段改动旧数据库。
- 后续如果引入 Schema v33，**必须先实现可验证的 SQLite 备份与恢复方案**（含 WAL/SHM 一致性备份、恢复到临时数据库后完整性检查、只读兼容构建或明确升级不可逆告知），不能只靠功能开关回滚。
