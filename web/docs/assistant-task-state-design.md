# Infinite Atelier AI 助手 — 持久化任务状态（Task State）设计

> 设计版本：v2（2026-11-12，已合入 [审核结论](./assistant-task-state-design-review.md) R1–R10）  
> 状态：**P0a、P0b、P1a 已实施；P1b 本地画布事务与恢复路径已实施（明确限制支持的动作类型）；P2–P3 尚未实施**。适用现有单机、单用户、SQLite 后端。项目已有的聊天、画布、生成 Job、ComfyUI、Skill 和 CAS 机制继续复用；不引入分布式工作流平台。

## 0. 设计决策与交付边界

**核心原则：持久意图 + 冻结步骤 + 可验证回执 + 不确定结果先对账。** 聊天记录提供语义，不充当副作用完成凭据。模型生成计划，不自行把步骤写成 `succeeded`。执行器只接受经校验、冻结且满足审批的步骤。

原方案的“刷新后无重复执行、免重复模型调用/计费”不能只靠 Task 表实现。必须区分：

- **命令幂等**：同一个 `requestId` + 相同请求摘要返回既有结果；不同内容返回冲突。P0 可以实现。
- **本地副作用幂等**：普通图操作需要服务器事务与保存冲突协议；不能靠前端成功提示判断。P1 实现。
- **外部副作用去重**：使用固定执行身份、同一冻结快照和可查询记录；结果不明时停止重发并对账。若上游不支持幂等/查询，**不承诺 exactly-once 或严格免重复计费**。P0b 先保护模型请求，P2 扩展 Skill、Job、ComfyUI。
- **完成条件**：Job 成功、产物收集成功和画布物化成功是不同事实。依赖产物节点的下一步只能在物化回执确认后执行。

本设计对照现有代码：`project_chats` 存聊天；`buildCanvasAssistantTurns` 截取最近交流；`CanvasAssistantPanel` 在前端应用图操作；`saveSingleUserCanvas` 对旧版本的保护主要围绕已物化媒体；`assistant-chat.mjs` 对网络失败有底层自动 POST 重试；`jobs` 有 `idempotency_key`，但 `/skills/execute` 现为每次请求生成新 runId。以上均为**当前实现**，新 API、表和策略均为**拟实现**。

## 1. 目标、非目标与责任边界

### 1.1 目标

1. 允许一个 Chat Session 包含多个 Task。用户发送“继续、重试失败步骤、修改计划”时以明确 `activeTaskId` 为准，不依赖历史文字推断。
2. 关闭页面或重启后读取原目标、已完成步骤、尚待批准事项、实际 Job/run/物化结果；只恢复可安全执行的步骤。
3. 对步骤、审批、外部执行、模型调用和画布提交保留最小可验证记录，避免重复生成节点、重复执行脚本和不明状态下自动二次付费。
4. 继续使用单机 SQLite、现有 JobCoordinator、Canvas Materializer、Skill Registry 与 CAS，避免 Redis、Celery、BPMN、多用户 ACL 和分布式锁。
5. 保留当前用户对“画布引用关闭／选中节点／画布概览／图片 @ 引用”的模型数据发送范围。

### 1.2 非目标

- 不将旧聊天推断为已执行 Task，旧聊天无需自动迁移。
- 不让模型绕开删除、覆盖、脚本及新付费操作的用户审批。
- 不自动重试结果不明的第三方提交；旧任务恢复不等于重跑。
- 不在 P0 宣称崩溃安全画布操作或已解决外部幂等；能力需按阶段验收。

### 1.3 责任分配

| 部件 | 唯一职责 |
|---|---|
| Chat Session | 展示用户与模型对话，记录关联 taskId |
| Task Manager | 维护计划版本、步骤依赖、审批、状态汇总与取消意图 |
| Planner / Model | 解释目标、生成提案与诊断；不得直接确认外部执行结果 |
| Task Executor | 条件领取、冻结输入复核、调用原执行组件及写入回执 |
| Reconciler | 按执行身份查询事实；无法确认则标记 `needs_reconcile` |
| Existing JobCoordinator / Materializer | 继续负责生成、收集、物化；Task 只观察并关联证据 |
| Canvas persistence | 负责保存屏障、画布版本/合并冲突和后端已提交图的同步 |

## 2. 实体、数据模型与 SQLite 迁移

采用 schema **v24（暂定）**，只新增必要表、索引、触发器；`initializeSchema` 使用现有迁移惯例。既有 `project_chats.sessions_json` 保持不变，不把 Task 直接塞进聊天 JSON。

### 2.1 assistant_tasks

| 字段 | 含义 |
|---|---|
| `id, project_id, chat_session_id, root_message_id` | 身份与会话引用；始终按项目作用域查询 |
| `status, active_step_id, active_plan_version` | 派生任务状态、当前步骤、有效计划版本 |
| `original_request, goal_json, constraints_json` | 用户原始目标及修订约束，原始请求不可覆盖 |
| `summary_json` | 限长的事实摘要，只作模型提示，不作执行证据 |
| `context_policy_json` | 本轮选择的画布引用开关、scope、节点/图片白名单 |
| `cancel_requested_at, cancellation_reason` | 取消意图独立于外部调用真实结果 |
| `read_only, created_at, updated_at, finished_at` | 只读标识、时间；只读任务不可领取执行 |

### 2.2 assistant_task_steps

| 字段 | 含义 |
|---|---|
| `id, task_id, plan_version, ordinal, kind, required` | 冻结步骤、计划归属及是否为完成的必需步骤 |
| `status, depends_on_json, superseded_at` | 当前执行状态、依赖、旧计划停用时间 |
| `action_json, action_digest, preconditions_json` | 冻结操作与图/模板/来源等前置条件 |
| `approval_json` | 用户确认的 planVersion、stepId、actionDigest 和时间 |
| `receipt_json, receipt_trust, result_json, error_code` | 真实回执、可信度和错误；`client_reported` 不等于后端确认 |
| `lease_owner, lease_expires_at, attempt_count` | 并发条件领取与尝试数 |
| `created_at, updated_at` | 时间轴 |

Step `kind`：`canvas_mutation | skill_script | model_job | comfy_workflow | wait_external | materialize | clarification`。物化是**独立步骤**，不把 `model_job= succeeded` 当作图上已有产物。

### 2.3 assistant_task_attempts

`id, task_id, step_id, attempt_no, execution_key, action_digest, request_fingerprint, frozen_snapshot_json, status, external_kind, external_id, submit_marker, submitted_at, lease_owner, evidence_json, created_at, finished_at`。

约束：`UNIQUE(step_id,attempt_no)`、`UNIQUE(project_id,execution_key)`（项目字段可直接落在 attempts）。同一次执行的重复投递**绝不递增 attempt_no 或更换 execution_key**；新 attempt 只在用户明确批准新执行、且旧执行已对账或风险明确提示后创建。`external_id` 可引用已有 Job、Comfy run 或 `skill_script_runs.id`。

### 2.4 assistant_task_events

`seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id, step_id, attempt_id, kind, payload_json, created_at`，按 `(task_id,seq)` 索引；只追加最小必要审计数据。`seq` 是增量事件游标，不是 Step 执行成功的判断依据。

### 2.5 assistant_task_commands 与 assistant_model_calls（P0b）

命令去重与模型网络调用必须分开：

- `assistant_task_commands`：`id/request_id`（作用域为项目+Task）、`command_kind`、`payload_digest`、`status`、`response_json`、`created_at/updated_at`。相同 key + digest 复用已落库响应；同 key、不同 digest 返回 409；处理中命令返回 `in_progress` 或 `needs_reconcile`，不触发第二次同义执行。
- `assistant_model_calls`：`id, command_id, task_id, call_kind, parent_call_id, provider, model, request_digest, status, submit_marker, started_at, finished_at, result_ref, error_code`。每次真实上游 POST 记录一个调用身份，`call_kind` 区分 `initial`、`skill_tool_round`、`format_repair`、`skill_execution_repair`。必要时记录 token/费用估算，但不保存密钥、图片字节或未经脱敏的完整请求。

索引：`(project_id,chat_session_id,updated_at)`、`UNIQUE(task_id,plan_version,ordinal)`、`(task_id,seq)`，以及命令/执行身份唯一键。外键与项目软删除检查必须覆盖读写路径。所有 JSON 受长度、格式和无明文凭据校验约束。独立结构允许追加表而不改变 `project_chats` 版本。

## 3. 状态机与闭合规则（R3、R6、R7）

### 3.1 状态

Task `status`：`planning | ready | waiting_approval | running | waiting_external | blocked | needs_reconcile | cancelling | failed | completed | cancelled`。

Step `status`：`pending | ready | waiting_approval | submitting | running | waiting_external | succeeded | failed | skipped | blocked | needs_reconcile`。

`read_only`、`receipt_trust`、`cancel_requested_at` 是独立属性，不必增加新状态值，但在领取及完成校验中必须生效。

### 3.2 聚合算法（后端唯一实现）

1. `read_only` 或项目软删除：禁止任何写/执行；仅展示历史，不能因 UI 显示 ready 而领取。
2. 若 `cancel_requested_at` 非空：立即禁止**新**步骤领取；有未确认的在途外部操作则为 `cancelling`，只允许对账/取消尝试；全部在途证据落定后为 `cancelled`。迟到成功仅更新原 Attempt，不激活后继。
3. 存在结果不明的必需步骤：`needs_reconcile`，暂停所有依赖它的后继。
4. 必需步骤 `failed/blocked` 且无法按现有计划继续：分别为 `failed/blocked`；由用户修订或明确重试后重新推进，不能自动标成 completed。
5. 存在 `waiting_approval`：`waiting_approval`；存在已提交未完成生成/物化：`waiting_external`；存在已领取本地执行：`running`。
6. **仅当有效计划的所有必需步骤均有后端可信 `succeeded` 回执，或有明确允许的 `skipped` 决策，且不存在在途未确认执行**，Task 才为 `completed`。非必需步骤失败可显示警告但不得伪装为已完成其自身。
7. 无可执行步骤且有未满足依赖：`blocked`；可执行：`ready`；尚未形成计划：`planning`。旧计划未领取步骤已停用，不计入新计划完成度。

审批拒绝：步骤转 `skipped`（仅当可选且用户明确跳过），否则转 `blocked` 并阻止依赖。依赖失败不能自动满足依赖；修订计划才可替代。

### 3.3 计划修订与并发（R3）

- `POST /turns`（修订）携带 `expectedPlanVersion`；后端事务检查有效 Task、未取消与版本 CAS。增加 `active_plan_version` 后冻结新计划。
- 尚未领取的旧步骤设 `superseded_at`，旧审批默认失效；已领取/提交的旧步骤及 Attempt 保留原 `plan_version` 和所有证据，直到终态或对账。
- 已领取步骤结束后仍写回**原** Attempt，但只有有效计划明确依赖或复用其冻结回执时才会推进后继。禁止旧计划回调启动新计划步骤。
- 保留原冻结 Step 时，用显式的 `adopted_step_id` 或依赖映射引用已验证回执，不复制或伪造成功；若操作参数有变化必须新建 Step、新 actionDigest、新审批。

### 3.4 领取、租约与异步写回（R3）

在单个 `BEGIN IMMEDIATE` 事务中条件领取，核验：项目活动状态、`read_only=false`、`cancel_requested_at IS NULL`、`task.active_plan_version = step.plan_version`、`step.status=ready`、依赖已满足、审批有效、前置条件和模板/Skill 授权有效，以及空闲 lease。使用条件 UPDATE 的 `changes===1` 证明唯一领取成功，生成随机 `lease_owner` 并设置到期时间。

后续回写必须匹配 `stepId + attemptId + lease_owner + planVersion`，只有持有者可变更执行阶段；失效持有者不能覆盖其他人结果。租约到期仅允许**重新领取“尚未跨过不可逆提交屏障”的步骤**；已经进入 `submitting` 或存在 `submit_marker` 的步骤必须先按身份对账，绝不自动重投。

后台触发：用户 resume、审批完成、相关 Job/materialization 事件、后端启动恢复扫描及必要的轻量定时检查。每次唤醒都经相同领取规则；不另建第二套 Job/Comfy 调度器。

## 4. 冻结执行身份与副作用协议（R2）

### 4.1 executionKey / 快照 / 提交屏障

冻结 Step 后，Executor 生成执行身份 `executionKey = taskId:stepId:attemptNo`（具体编码可哈希并满足既有 Job key 限长）；`frozen_snapshot_json` 包含 provider、模型/通道凭据版本引用、模板/Skill 版本、参数、输入节点/端口、来源指纹、项目 revision 和执行方式。严禁在同一次执行重投时从“最新画布”重新生成不同快照。

同 key 重投：检索原命令/Attempt/Job/run，校验 `request_fingerprint`、冻结快照及其执行来源栅栏完全相同；不一致返回 `idempotency_key_conflict`，**不能生成新的 key 绕过**。确实需要重新生成时，必须创建新的 attempt 并重新获得相应批准。

**优选同事务**：重构已有 repository，提供事务内的 `insertJobWithinTransaction` 类方法，Task Step 与 Job/Skill 执行记录在同一个事务建立并关联；现有 `writeTransaction` 禁止 async 且不允许直接嵌套，不能从 Task 外层事务调用现有 `submitJob()` 后假装原子。对外部网络/脚本的实际副作用必须在本地事务提交后开始。

**可选分事务**：先持久化 Intent 和共享 `executionKey + fingerprint`，再创建 Job/run；在任何中间崩溃点都能按 key 对账。若无法确保执行记录可发现，必须置 `needs_reconcile` 而非冒险重跑。跨事务方案须通过同样的故障注入验收。

### 4.2 画布动作、Skill、Job 与 Comfy 统一规则

| kind | 执行方式 | 可信回执 / 恢复规则 |
|---|---|---|
| `canvas_mutation` | 共享纯图变换，后端事务提交普通图和 Step | 项目新 revision + 已保存节点/连接 refs；同 Step 重复只读回执 |
| `skill_script` | 复用授权后的脚本执行器，扩充 `/skills/execute` 的执行键 | 固定 `runId` 和 `result_json`；未知执行不自动重启 |
| `model_job` | 复用 `submitJob` / JobCoordinator | 已存在 `jobId`；相同 frozen snapshot 与 key；等待完成 |
| `comfy_workflow` | 复用 Comfy Job 执行路径 | 关联同一 `jobId/runId`；恢复轮询，不创建新工作流 |
| `wait_external` | 只观察指定的外部状态 | 上游/Job 记录更新，不重新调用生成 |
| `materialize` | **复用现有 Canvas Materializer** | `materializations.status=materialized`，匹配期望 `artifactId/nodeId`；仅重试落图 |
| `clarification` | 等用户输入或修改计划 | 用户选择和新计划版本，而非伪造执行结果 |

本地脚本返回 Windows 退出码 `9009`：保留 runId、失败相位及日志；可诊断/修订环境，不在“继续”时默默重跑。Skill 产物通过 runId/blobId 引用，文本落图按独立 Step 记账，不能把草稿当最终产物。

### 4.3 后台审批（R6）

- 冻结审批回执键：`taskId + stepId + planVersion + actionDigest + userDecision + approvedAt`；对高风险任务附 exact input / cost 提示。
- Task Executor 在**领取**时从数据库读取被批准的冻结参数，同时复验项目、源节点、模板、Skill 版本/权限与用户决策。不能接受前端仅传一个 `approved=true` 或直接将修改过的 action JSON 送入 `/skills/execute`。
- 重复“确认”只复用原回执/执行身份；审批后 actionDigest 或上下文关键前置条件变化时阻断并重新申请；拒绝后没有执行权。
- 原非 Task 入口保留既有行为；Task 专用执行端必须绑定经校验的 Task 上下文，避免绕过审批。新发起的付费/脚本 attempt 必须再次获用户明确确认。

## 5. 画布提交与自动保存协议（R1、R10）

现有 `saveSingleUserCanvas` 收到滞后 `expectedRevision` 时会基于前端旧图保留部分已物化媒体，但普通节点/连线新增、修改、删除没有通用防覆盖语义。后端 Task 事务原子化**还不够**：旧前端整图自动保存仍可能覆盖 Task 效果。

### 5.1 客户端保存屏障

1. Task 执行画布动作前，对项目执行 `awaitCanvasStorePersistence(projectId)` 等价屏障，暂停该项目新的自动保存发起，并等待所有已在途 PATCH 真正落定；确认没有 unresolved dirty draft。
2. 获取最新 `project.revision` 和图快照；把 expectedRevision、目标节点/连接指纹、模板版本和冻结布局中心/配置一并提交。操作期间本地编辑需排队或阻止，不能静默丢弃。
3. 后端提交成功后，按返回 `revision + canonicalGraph + refs` 同步前端缓存；在同步期间不得继续发送屏障前生成的图快照。
4. 恢复自动保存，若队列中有新的本地用户编辑，基于新图**显式重新应用或提示冲突**；失败保留本地草稿与错误提示，不覆盖后端。
5. 多标签页或后台定时保存也受服务器版本栅栏约束；客户端屏障本身不能代替服务端防护。

### 5.2 服务端版本冲突选择

**推荐：Task 管理项目的普通整图 PATCH 改为严格 `expectedRevision === currentRevision` 的 CAS 规则**；不允许旧 revision 的 `saveSingleUserCanvas` 自动继续覆盖。Task 图变更和 Step succeeded 在一个 SQLite 事务内提交，并产生新 revision/Event。对新版本不匹配的保存返回 409，附当前 revision；前端保留本地草稿，刷新后按明确规则解决冲突。

现有 Materializer 可合法单独推进 project revision。由生成物化引起的普通保存冲突，不能简单删除旧媒体；客户端先读取最新图，按现有物化来源标识识别输出，并**显式**合并非冲突修改或要求用户处理冲突。默认不将普通节点“新建、更新、删除”做猜测式自动合并。非 Task 项目原有单机自动保存策略可保持兼容，分阶段迁移。必须覆盖后台物化、手工编辑、Task 提交三者交错情形。

### 5.3 后端图事务与稳定身份

- 将 `applyAssistantCanvasActions` 相关纯函数抽成可由 Task 后端执行器复用的图变换模块；冻结输入和目标引用，事务内验证后写入 `projects.document_json`、`assistant_task_steps.receipt_json`、Task Event 和 `project_events`，不可出现图已变/Step 未成功的半提交。
- 同 Step 重复执行只读取原回执，不生成新 nodeId/edgeId。对于后继会引用的节点、分组、连线，要么在冻结计划时分配稳定 ID，要么在原图事务中将 alias → ID 映射持久写入 receipt；后继只从**已提交回执映射**解析，不凭模型重造 ID。
- 不要求所有布局时间戳/临时参数都预冻结；但跨步骤可引用的身份、前置条件、审批指纹必须冻结。`createCanvasNode` 与普通 `connect` 现生成随机 ID，需在 Task 适配层覆盖或通过回执映射避免重放不同。
- `receipt_trust=client_reported` 只能用于 P0 引导性恢复，不能满足后端执行型步骤完成条件；P1 后必须由后端事务收据确认。

## 6. 模型调用与命令去重（R4）

当前 `assistant-chat.mjs` 的 `infer()` 在某些 timeout/network error 时自动再次 POST；同一请求在上游“已受理、响应丢失”情况下可能重复推理与计费。Task 命令去重**不能代替**底层传输策略。

### 6.1 Task 专用模型执行策略

1. 先写入有唯一 `requestId` 和 `payload_digest` 的命令记录，再准备模型调用。相同请求再次到达时返回原状态/结果；不同摘要立即 409。
2. 每一次真实 POST 之前写入 `assistant_model_calls` 的 `call_id/submit_marker`。实际发出后若响应不可验证或网络断开，该 Call 为 `needs_reconcile`，Task 不自动再次发送同一推理。
3. Task 路径的**结果不明传输重试默认禁止**；若上游支持可靠幂等 token 或请求查询，才能按 provider 能力显式允许恢复。普通聊天旧路径可保持现行为，但 UI 不得给它 Task 级免重复保证。
4. 工具调用后的新模型轮次、格式纠正或 Skill 脚本提案修复是**有意的新调用**；各有独立 `call_id`、`call_kind`、`parent_call_id`，独立预算及状态，不能被粗暴地当成网络重试，也不能偷偷复用前一 Call 的身份。
5. 只有已持久提交的模型回答/动作提案才可作为后续批准/执行依据。上游响应丢失且不能查询时，应提示“可能产生一次推理费用，结果未知”，由用户选择是否发起**新的**独立调用，而非自动重试。

### 6.2 恢复行为

| 调用状态 | 重复用户命令 / resume |
|---|---|
| 本地尚未发出、无 submit marker | 可使用同一 call identity 安全开始 |
| 已发出且拿到完整可验证响应 | 返回持久化结果，不再 POST |
| 已发出但 HTTP 结果未知 | `needs_reconcile`，不再 POST；可展示人工重新请求选项与重复计费提示 |
| 已明确失败且证明上游未接受 | 可按明确定义创建新的调用；不能偷偷替换原调用证据 |

验收以**实际 provider 请求次数**为准，不以本地 Task 行数冒充免重复计费。

## 7. Job、物化与后台恢复（R5、R7）

### 7.1 任务完成的两道屏障

- `model_job/comfy_workflow` 成功：已有 Job 收到最终状态、artifacts 已入库，只能证明生成完成。
- `materialize` 成功：相应 `artifactId` 在 `materializations` 有 `materialized` 回执并指向有效的 `nodeId`。当后续步骤引用产物节点，依赖链必须为 `generation -> materialize -> downstream`。

材料化失败/`retry`/`blocked` 时，保留原 Job 成功证据，**只通过现有 Canvas Materializer 的重试/对账入口处理落图**，不得重新触发付费生成。

### 7.2 取消与迟到回执

取消命令先持久写 `cancel_requested_at`，使领取立即停止；对可取消的 Job 发取消请求，并单独记录取消请求是否成功。已经提交的外部操作可能最终成功、失败或被取消；绝不凭 HTTP cancel 返回就把外部工作视作确定取消。

取消后迟到结果继续更新**原 Attempt/Job/Materialization** 证据与事件，不启动后继、不清空已有合法产物。未确认在途操作保持 `cancelling` 或待对账，直到有依据转 `cancelled`。原 Job 与任务状态不得互相伪造终态。

### 7.3 唤醒与启动恢复

- API `resume`：先扫描现有 Step/Attempt，查询 Job、Skill、物化与模型 Call，执行本地一致性对账；再领取允许的 ready Step。
- 后台 Job 终态/物化事件通知：只唤醒有依赖的 Task，不自动二次生成。
- 启动 `recoverAtStartup`：按提交标记、lease、冻结快照核对，恢复观察与可安全执行的本地工作；任何无法确认的外部提交进 `needs_reconcile`，租约过期不代表可以重投。
- 以 DB 状态为唯一事实来源；临时网络/浏览器控制器的取消、断线不等于 Task 已完成或失败。

## 8. 模型上下文、隐私与缓存（R9）

区分两个作用域：

1. **后端本地验证上下文**：读取所需完整图、节点指纹、模板和 Job 信息，用于验证合法性和恢复对账；**不默认转发给 provider**。
2. **Provider Payload**：严格遵循当前用户选择的 `includeContext`、`scope`（`selection/overview`）、`includedIds`、显式图片引用和会话/Task 允许发送范围。选择随 Task/Turn 持久化，用户可显式修改；恢复不得自动从 selection 扩大到全画布概览。

上下文生成次序：系统约束与权限规则 → 符合外发范围的 Task Goal/必要状态摘要 → 用户允许的图/节点/图像信息 → 最近聊天摘要 → 当前用户指令。即使 Task 存储了更多本地图状态，`summary_json` 与执行日志中的节点文本、脚本 stdout/stderr、图片信息也不得绕开用户的外发限制。对模型无法在授权范围内完成的操作，要求用户扩大引用范围或说明不足；不能偷偷读取并发送未授权节点。

模型预算超限时先裁剪普通历史问答；不会为了凑预算而丢弃执行器本地需要的前置条件、审批和回执。执行器的 DB 校验不依赖模型上下文截断。原 `/assistant/chat` 的 20 轮、96KiB 等限制仍需遵守，不以任务长文直接塞满最后一个 user turn。

## 9. 资源生命周期与版本固定（R8）

- Task Step/Attempt 中**仅由任务独占**的 CAS 输入、输出或审计 blob 引用纳入 `blob-reference-ledger.mjs` 的扫描来源，并添加对应表 INSERT/UPDATE/DELETE 的 dirty trigger。已经被 Job、artifact、Skill run 持有的引用可复用原账本，不重复存储相同资源。
- 冻结 `comfyTemplateId + revision` 的 Step 应进入 `comfy-registry.mjs` 的版本引用检查；尚有效的 Step 不允许静默删除其模板。若版本在有效规则外失效则 `blocked`，需要用户显式重新规划，不能换最新版执行。
- Skill 固定 `skillId + version`；继续执行时复核授权/完整性和版本可用性。失效时 `blocked`，已生成 run 仍允许按原 runId 查询合法历史证据。
- 已完成/取消任务仍可能需要查看历史，保留期、归档导出与删除后的 GC 清理要有明确策略；不能因任务状态改变而无条件删除仍被项目、Job 或归档引用的文件。

## 10. 接口协议（草案）

前缀：`/api/v1/projects/:projectId/assistant/tasks`。原 `/assistant/chat` 保留兼容，但 Task 执行必须走带身份的专用入口。

| 方法 | 路径 | 语义 |
|---|---|---|
| POST | `/` | 创建 Task；`requestId + payloadDigest` 幂等 |
| GET | `/?chatSessionId=...` | 列出当前会话任务 |
| GET | `/:taskId` | 同一 DB 读取视图的任务快照 + `lastSeq` |
| POST | `/:taskId/turns` | 用户继续/修订；携带 `requestId`、必要时 `expectedPlanVersion`、contextPolicy |
| POST | `/:taskId/resume` | 先对账后条件领取；重复命令不制造新 Attempt |
| POST | `/:taskId/steps/:stepId/decision` | 审批/拒绝；携带 `planVersion + actionDigest + requestId` |
| POST | `/:taskId/cancel` | 持久写入取消意图，随后尝试取消既有 Job |
| GET | `/:taskId/events?afterSeq=N&limit=100` | 按 `seq ASC` 返回 `seq>N` 的事件，附 `nextSeq/hasMore` |

需要为 Task Executor 设计内部事务入口（画布提交、模型 Call 登记、关联 Job/Skill run），不得让外部客户端直接上传一个未验证的 `status=succeeded`。接口字段有 `taskId,status,activePlanVersion,activeStepId,steps,lastError,updatedAt,lastSeq`；写操作按实际结果返回已提交回执、冲突或未知状态。

**事件无漏读协议（R10）**：GET Task 在同一个 SQLite 读事务读取步骤与 `MAX(seq) AS lastSeq`；客户端先渲染快照，再按 `afterSeq=lastSeq` 拉增量事件。服务端按 seq 递增稳定分页；重复使用 cursor 允许收到相同数据，UI 按 seq 去重。快照与事件并发写入不能漏事件，不应通过 updatedAt 时间戳做游标。

## 11. 前端交互

- 助手顶部显示「当前任务」：目标、步骤数、当前状态、最近错误、已提交的 Job/run 与对账入口；同一个 Chat 可切换多个 Task。
- 仅在 `ready` 且确认条件满足时展示“继续执行”；`needs_reconcile` 显示“检查执行结果”，不得把按钮写成无风险重试。
- 危险操作审批展示冻结操作摘要、影响对象和源 revision；后台验证原审批有效性。用户取消与真正停止 Job 的结果分别展示。
- 保存冲突提示本地未提交草稿存在、当前服务器版本和可选解决路径；不静默清空草稿、不继续发旧快照。
- 模型上下文选择可预览；恢复沿用用户上次明确选择，且能主动修改。普通解释型问答无需创建新的可执行任务。

## 12. 分阶段实施与门槛（更新后的 P0–P3）

| 阶段 | 实施内容 | 交付验收 / 不能承诺 |
|---|---|---|
| **P0a — Task 基座** | schema v24 核心 Task/Step/Attempt/Event、命令记录、Repository、任务查询和任务条；旧会话不迁移 | 刷新后仍能看到目标、错误、上次可验证进度；同一 requestId 去重；**仅指导性恢复，不宣称副作用崩溃安全** |
| **P0b — 推理连续性** | `assistant_model_calls`、Task 模型禁用结果不明自动重发、模型 Call 类别、Task Context Builder、上下文外发白名单 | 上游响应丢失不二次 POST；合法工具/修复轮次各自登记；不同引用开关实际 payload 检查通过 |
| **P1a — 图执行安全边界** | R1 保存屏障和服务器严格版本栅栏、R2 统一执行身份、R3 原子条件领取、R6 审批验证、R10 refs 映射 | 迟到旧 autosave 无法覆盖已提交 Task 图；并发 resume 不重复；旧审批或变更参数拒绝 |
| **P1b — 可靠画布恢复** | 后端图事务与 Step 回执、R7 取消/计划修订/依赖状态闭合、后台触发与重启对账 | 重复 resume 100 次图只改变一次；断线、取消、计划修订/回调交错均不激活无效后继 |
| **P2 — 外部执行恢复** | Task 关联 Job、Comfy、Skill 的 frozen execution key/快照与查询、R5 `materialize`、R8 CAS/模板/Skill 生命周期 | POST 丢答复定位原记录；物化失败只重试落图；未知提交不重跑；GC/版本删除不损失活动任务 |
| **P3 — 长任务体验** | 多任务切换、事实摘要、事件视图和分页、归档/导入只读、用户恢复提示 | 连续 10+ 轮保持目标和状态；刷新/跨会话隔离；导入只读任务不触发外部执行 |

**门槛**：P0a 可先上线，但外发推理不宣称免重复；开始 P1 执行前必须关闭 R1–R4 的相关前置问题（其中 R4 在 P0b），以及后台审批/领取。不能把执行正确性前提推迟到 P3。现有全局模型聊天重试策略可以暂时不变，但 Task 专用路径必须执行 P0b 策略后才允许声称“不会对结果未知推理自动重发”。

### P0a 落地记录（2026-11-12）

- 已完成 schema v24 的 `assistant_tasks`、`assistant_task_steps`、`assistant_task_attempts`、`assistant_task_events`、`assistant_task_commands`，及 `assistant-tasks.mjs` 的事务型创建、查询、客户端观察记录、命令幂等和仅指导性 resume/cancel。
- 已新增 `assistant-task-routes.mjs`，公开创建、列表、详情、turns、observations、resume、cancel、events；客户端无步骤成功回写接口，不创建生成 Job 或运行 Skill。
- 已添加 AI 助手任务条：在已有聊天中显式选择「记录为任务」，可查看任务、关联后续消息、填写继续指令及结束记录。步骤执行尚未迁移到 Task Executor，客户端观察仅为 `client_reported`。
- 当前 P0a 并未实现自动判定任务归属、将 Task Snapshot 注入模型、模型调用重试控制、图原子提交或外部 Job/Skill 对账。P0b/P1/P2 执行前必须遵守前述门槛。
- 增加后端 Task 路由/迁移测试、前端任务条与聊天关联测试；实施进度以测试实际结果为准。


### P0b 落地记录（2026-11-12）

- 数据库 Schema **v25** 新增 `assistant_model_calls`：独立记录每次实际上游 POST 的 `callId`、父调用、调用类型、请求摘要、提交标记及结果状态。`assistant_task_commands` 复用 `requestId + payloadDigest` 进行 Task 推理的整轮去重；完全相同的已完成请求读取持久响应，不再次收费调用；不同 payload 明确冲突。
- `assistant-chat.mjs` 对 Task 推理注入持久 `callObserver`；每次真正开始传输前登记。Task 专用路径将底层结果不明重试次数设为零；超时、断连等标为 `needs_reconcile`，不自动再次 POST。普通非 Task 聊天保留历史重试行为。工具引用轮次、Skill 兼容回退、脚本提案修复、结构化格式修复、脚本完成后的后续推理各用独立 Call/命令身份。
- `runtime.mjs` 在取得唯一进程锁并打开数据库后执行 `recoverAssistantModelCallsAtStartup`：提交中、状态未知的调用转需对账；尚无提交标记的预处理命令可释放；**不会重新发起外部模型请求**。
- `assistant-task-context.mjs` 后端只将原任务目标、步骤状态及可信度、按用户明确选择的画布节点/概要发送到 provider；不外发所有 Task Event、脚本日志、未授权节点正文或整个旧聊天。`assistant_task_events.user_turn` 保存每轮冻结的 `contextPolicy`，`/assistant/chat` 的 `task.turnMessageId` 与当轮快照绑定；后续修改任务默认偏好不能扩大已冻结消息的对外发送范围。显式图片 @ 引用仍由原视觉引用校验机制授权。
- 前端已关联 Task 的模型请求只发送该轮明确用户文本（历史推理语义由 Task Snapshot 支持）；发送前必须先保存该轮任务命令，否则阻止未记账的模型调用。AI 助手任务区可展开模型调用记录，结果不明时提示风险；既有手动 Skill 脚本执行及画布操作**仍不属于 P0b 的可恢复执行账本**。
- 已针对同 key 并发、HTTP 响应丢失、504 超时、同 key 参数冲突、修复与工具新轮次、冻结 selection/overview/关闭画布引用、P0a→P0b 兼容迁移、取消后只读回放及服务启动对账运行测试。实际模拟通过不代表第三方 provider 支持 exactly-once。

**能力边界**：P0b 解决的是“已关联 Task 的**模型推理**记录和不明结果自动重发”，不是全局所有模型渠道/旧聊天的免重试保证，更不是 Skill、ComfyUI 或画布步骤的可靠执行。下阶段 P1a 必须先修复 R1 的旧自动保存覆盖、R2 真实执行身份及 R3/R6 的领取审批问题，才能实施可恢复图操作。

### P1a 落地记录（2026-11-12）

- **R1：Task 管理项目的整图保存版本栅栏。** `saveSingleUserCanvas` 在数据库事务中检测项目是否曾有 Task；存在 Task（包括已取消的 Task）时，普通 `PATCH /api/v1/projects/:id` 必须提供与当前图版本严格一致的 `expectedRevision`，否则返回 `409 project_revision_conflict`（含 `currentRevision`）。防止滞后 autosave 删除/覆盖后端已提交的普通节点和连线。未纳入 Task 的单机项目继续原有媒体物化补全路径。
- **R1：冲突草稿保护。** 画布 Store 遇到版本冲突会保留本地 `dirty` 和完整未保存图、且不会将本地已知 revision 擅自更新；页面不再对该冲突提供无意义的「重试保存」，而是提供「导出本地草稿」及二次确认后的「舍弃草稿并重新载入」。**不会自动合并一般节点新增、删除和修改**。客户端已提供 `commitAssistantCanvasGraphWithSaveBarrier`：先排空旧 autosave、冻结该项目图版本，暂时阻止并行新 PATCH；有新本地草稿时阻止远端图覆盖，确认没有新编辑才原子更新缓存的 revision 与权威图。该帮助函数尚未被真正 Task 图执行器调用，P1b 才将执行流程接入此屏障。
- **R2/R3/R6/R10：`assistant-task-step-gate.mjs` 内部安全准备。** 计划写入 `addAssistantTaskStep` 现在必须提供 `expectedPlanVersion`；`prepareAssistantTaskStep` 将原图 `revision + graphDigest`、冻结 actionDigest 与稳定的 node/edge alias→ID 映射存入 Step `preconditions_json`。一旦图或计划改变，旧审批和旧准备均失效。审批 API `POST /api/v1/projects/:id/assistant/tasks/:taskId/steps/:stepId/approval` 仅接受冻结 `actionDigest + expectedPlanVersion + requestId + decision`，在后端事务中验证冻结动作和来源版本；明确拒绝不可事后改为批准，重复命令安全去重。
- **R2/R3：仅后端可调用的 `claimAssistantTaskStep`。** `BEGIN IMMEDIATE` 中检查计划版本、依赖的 `server_committed` 回执、审批、图版本、无取消/只读及空闲租约；条件更新成功后持久写入冻结 Attempt（含 `executionKey`、`requestFingerprint`、`frozenSnapshot`、`leaseOwner`）。同 Task 只能领取一个 Step；租约过期、冻结图改变、计划修订和无效持有者不具有后续写回资格。`releaseUnsubmittedAssistantTaskClaim` 只允许持有实时租约、尚无提交标记的 Prepared Attempt 释放；计划修订也只自动释放**未跨提交屏障**的旧占位，已经提交或不明的保留待后续对账。
- **执行范围限制：** P1a 只允许内部预留 `canvas_mutation` 类型 Step；`skill_script`、`model_job` 和 `comfy_workflow` 不能通过该领取路径开始执行。没有 HTTP claim、执行、标记 succeeded 入口，也没有在 P1a 将 Step 和图改动原子提交。`executionStarted=false` 不代表动作已执行。Task UI 的 resume 仍是指导性恢复；实际图执行器/原子回执和取消后续状态闭合属于 **P1b**，外部 Job/Skill/Comfy 同一执行身份恢复属于 **P2**。
- **验证：** 覆盖旧 PATCH、取消后的迟到保存、非 Task 兼容、客户端 dirty 草稿保留、屏障先排空旧 PATCH 与新编辑期间不误覆盖、冻结 refs、未批准领取、批准后改图/改参数、同 key 审批重放、显式拒绝、并发领取、租约过期、旧计划失效、依赖 `client_reported` 不可满足、不同执行类型禁止提前调用等故障点。


### P1b 本地画布事务与恢复落地（2026-11-12）

- **原子图执行**：新增 `assistant-task-canvas-graph.mjs`、`assistant-task-canvas-executor.mjs`。先冻结动作、项目版本、图指纹、稳定 Node/Edge refs，复用 P1a 的租约/审批；同一 SQLite 事务提交项目图、revision、`project_events`、Step `server_committed` 可信回执、Attempt 结果和 Task Event。模拟回执写入前崩溃会整体回滚；重复调用只读取旧回执，不产生第二批节点或外部 Job。
- **API 与权限**：`POST /api/v1/projects/:id/assistant/tasks/:taskId/canvas-steps` 持久化并预验证操作；`POST .../:taskId/steps/:stepId/execute` 只接收身份和动作摘要，后端从冻结记录执行；用户审批绑定 planVersion/actionDigest。过期图或旧计划 409，未批准不得执行，旧浏览器 PATCH 继续受 P1a CAS 保护。
- **前端保存与恢复**：Task 关联的 AI 画布动作改为保存屏障→冻结步骤→明确审批→后端事务→权威图同步；普通聊天保留原浏览器行为。Task 面板显示待批准和已批准但未执行的冻结步骤，刷新后可核对并继续；相同 revision 同图的已提交重放是只读结果，不能用同 revision 异图覆盖本地草稿。
- **依赖与取消**：拒绝后阻断 Task 和依赖后继；取消在未提交时撤销 Prepared Attempt，未知提交时保留证据与 `cancelling` 状态。`runtime.mjs` 在独占实例锁后运行 `recoverAssistantCanvasTasksAtStartup`，只释放尚未提交的本地 Attempt；未知提交须对账、绝不重跑。跨步骤引用只能读取 `server_committed` 的前驱回执；`client_reported` 不能冒充完成。
- **当前限制**：只支持创建内置文本/图像/视频/音频/配置/导演节点、普通连线，修改文本/标题/提示词以及删除文本节点或连线，均需明确确认。复杂组与布局、Comfy 端口绑定、Skill 文本落图、`run_node` / `run_workflow` / GPU/外部脚本与 Job 不经此路径执行，也不会偷偷退回旧浏览器路径。Task 下的 Skill 脚本提案先阻断，等待 P2；普通非 Task 功能仍可用。
- **验收范围**：HTTP plan/approve/execute/replay、事务中途失败、重复 Step、后续稳定 refs、取消与 unknown、重启 Prepared 对账、保存屏障及前端恢复动作均有自动化测试。无真实上游/Comfy 的 exactly-once 声明；P2 的 Job/Materialize/CAS/Skill 生命周期仍未开始。

## 13. 故障注入与验收清单（R1–R10）

| 编号 | 故障与交错点 | 必须观察到的结果 |
|---|---|---|
| R1 | Task 事务提交后延迟发送旧 PATCH；同时存在本地编辑与后台物化 | 旧 PATCH 返回冲突或明确合并；普通图变更和本地草稿均不静默丢失 |
| R2 | Intent 写入、Job/run 创建、Task 关联之间逐点模拟崩溃；同 key 不同快照 | 可按 key 找回原执行；冲突明确报错；不创建第二次付费/脚本调用 |
| R3 | 两标签页同时 resume，随后新 planVersion 在旧回调前生效 | 一次领取；旧结果保留证据但不推进停用后继；失效 lease 不可写回 |
| R4 | 模拟 provider 已接收 POST 但丢响应 | Task 路径不第二次 POST，命令进入需对账；正常工具轮次/格式修复分别留 Call 记录 |
| R5 | Job succeeded，但 materialization 反复 retry 或 blocked | 下游等待物化；只重试落图，原 Job ID 与费用保持一个 |
| R6 | 未批准 resume、批准后篡改 actionDigest、重复批准脚本 | 未批准不执行，失效提案阻断，重复批准只启动一个 run |
| R7 | 前端关闭、服务重启、取消与提交并发、依赖失败、取消后迟到成功 | 状态闭合规则一致；取消后不启用后继，仍更新原 Attempt 证据 |
| R8 | 输入仅被未执行 Task 引用后运行 GC；模板版本删除；Skill 版本失效 | blob 不被误删；有效模板被引用保护；版本失效时明确 blocked |
| R9 | 画布引用关闭/仅选 2 节点/显式 @ 图片后恢复 Task | 检查真实 provider 请求体，未授权图/图片/日志内容均未外发 |
| R10 | 页面刷新后后继引用先前新增节点/连线；Task 快照与事件并发写入 | ID 稳定可解析；`lastSeq` + `afterSeq` 不漏/不重复应用事件 |

额外回归：Skill Windows `9009` 失败后不无提示重跑；项目删除或归档只读禁止恢复；`project_chats` 旧格式、现有模型生成、Comfy Job、Canvas Materializer 和项目 ZIP 导入不因 Task 新增而回退；日志与 JSON 无明文 API key。

## 14. 升级、兼容与文档治理

- 从当前 schema v23 迁到 v24（实际实施前重新核对当前版本），按现有冷备流程备份。旧 `project_chats`、`jobs`、`skill_script_runs` 不回填成“已完成任务”，避免臆造证据。
- 现有 `/assistant/chat` 和普通节点生成/Skill 接口保留；Task 逐步接入受控执行路径。发布期间 UI 必须标记 P0 的“指导恢复”与 P1/P2 的“执行级恢复”能力差别。
- 项目 ZIP `manifest.version=1` 当前仅含图、视口、聊天、媒体与模板；需要导出 Task 时定义新版本。导入外部 Task 默认 `read_only=true`，原本机 Job/run ID 仅作为文字历史，不允许直接恢复发起付费任务。
- 项目软删除后禁用 Task 执行；Task 的 CAS 保留/GC 与版本生命周期依 `9` 实现。
- 本次修改仅为设计文档更新；原审核结论保持独立审计记录。未运行故障注入、未修改 schema/API/前后端执行代码。

## 15. 最终决策

**先交付可解释的持久任务状态，再交付经证明安全的副作用恢复。** 实施顺序为 `P0a → P0b → P1a → P1b → P2 → P3`，执行安全的阻断项必须在对应阶段开始前闭合。所有“成功”和“可以继续”的结论由持久回执、有效计划和后端条件校验决定；模型历史文字只能作为参考。
