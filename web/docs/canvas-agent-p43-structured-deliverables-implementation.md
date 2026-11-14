# P4.3：结构化文本交付物验证与安全修订

> 实施日期：2026-11-14。状态：已落地 P4.3 的**结构化文本交付与计划级修订**，沿用 SQLite Schema v32；没有增加数据库迁移，没有调用真实 Provider、GPU、Skill 或 ComfyUI。
>
> 基线：`c964dfd`（Agent Run 授权/撤销加固）、[P4.2c Agent Run 与 Canvas Step](./canvas-agent-p42c-step-coordination-implementation.md)、[P4.0 设计复审修订](./canvas-agent-p4-astra-review-resolution.md)。

## 1. 范围与交付物类型

复用 P4.0 的 `kind="text_nodes"` 和唯一可信执行链，不新增独立的交付执行器。保留原有角色卡登记和验证端点与协议，新增 `deliverableType`：

| `deliverableType` | 默认标题 | 每个节点最低有效正文字符 |
| --- | --- | --- |
| `story` | 故事大纲 | 60 |
| `scene` | 场景设定 | 35 |
| `storyboard` | 分镜提示词 | 40 |

最低字符数是在剔除空白和一部分标点/数字后计算的**静态完整性阈值**，不是对故事质量、镜头语言或美术一致性的语义评分。还校验用户确认的 `requiredFields`、精确 `ref/title` 对应、空模板显式授权、真实内容与批准动作一致。后续若需模型对内容进行质量复核，应加入独立的非权威建议过程，不能让模型决定 Task 是否 `completed`。

## 2. 新增 API

`POST /api/v1/projects/:id/assistant/tasks/:taskId/deliverables/structured-text`

必填：`requestId`、`sourceTurnMessageId`、`deliverableType`（story / scene / storyboard）、`entries`（1–8 个不同的 `ref/title`）、`expectedPlanVersion`、`confirmed=true`。可选：`requiredFields`（至多 6 项）、`allowEmptyTemplate`（仅限用户原始 Turn 明确要求空白）。

- 服务端在同步 SQLite 事务内检查 **Task 可写、status=planning、当前 planVersion 匹配、此计划还没有 Step、来源为最新用户 Turn**。
- 标题必须在当前用户 Turn 中明确出现；仅对**单节点交付**允许固定的、与交付类型对应的默认标题。禁止将模型草稿或历史 ZIP 事件升级为用户确认的规格。
- 写入 `deliverable_required`（首次）或 `deliverable_revised`（修订）事件及幂等命令。注册后 Task 级完成栅栏继续对 Canvas、Job、Skill 和 Run Sequence 等所有旧完成路径生效。
- 修订必须在**旧验证失败 → Task blocked → 公开 `/replan` → planVersion 增加**后登记；同一个任务不能静默切换交付类型，不能绕过审核修改一个已冻结的规格。
- 传统角色卡 `POST /deliverables/text` 和双方共用的 `POST /deliverables/text/verify` 保持兼容。

## 3. 冻结、审批与执行

现有 Canvas Planner 为所有 `text_nodes` 规格继续执行：

1. `freezeAssistantTextSpec` 将类型、目标节点、阈值、必填字段、来源 Turn 的不可变 `seq`、`requirementDigest` 和 `planVersion` 冻结为完整 `deliverableSpec`。
2. `action_json.deliverableSpecDigest` 和 `preconditions_json.deliverableSpecDigest` 互相绑定，参与原有 `actionDigest`，审批和 Claim 复核；规划时提前按完整 Claim Snapshot 执行 **32 KiB** 上限校验。
3. 每个阶段再次检查当前最新 `user_turn.seq` 必须等于来源 `sourceTurnSeq`。新 Turn 会撤销旧规格的新增执行授权。**Task 模型网关也在真实 Provider POST 前执行同样的检查**，避免为过期规格付费。即使旧 Step 已批准，只要未 Claim/提交，也允许用户**安全拒绝**并触发公开重规划；不会借此产生写入权限。
4. 使用原有 `claimAssistantTaskStep`、`commitAssistantCanvasAttempt`，Graph、`server_committed` Step Receipt、Attempt 和项目修订在同一 SQLite 事务提交。不额外调用 Provider/Job。
5. 只有 `verifyAssistantTextDeliverable` 可以执行交付 Task 的最终完成条件更新。它独立同步复读持久 Graph、Step 原始动作/摘要、完整冻结规格、审批、可信回执、节点实际正文和 Project Revision。在同一事务中写验证事件并条件更新 Task。
6. 不合格写 `deliverable_verification_failed`，将 Task 状态收敛为 `blocked`；公开 `/replan` 可以按原有安全检查恢复修订。旧 `server_committed` 回执保留，不能被替换或当作新版规格的交付证明。

任何 `finalizeTask=true` 仍被此类 Task Planner 拒绝；ZIP 历史事件对只读 Task 不授予执行/完成权限。模型返回“已完成”的文字不构成任何执行事实。

## 4. 前端工作流与限制

关联 Task 的画布助手在用户**明确要求生成文本节点**时才会触发对应类型，先展示确认内容和最低正文要求，再于模型 POST 前向服务端登记新规格。普通文本问答、非 Task 会话、同时要求多种类型、明确要求多个故事/场景/分镜节点或连线布局的指令，不自动登记不匹配的单节点规格；这些操作保留原有 Canvas/Task 路径。

后续仍走原有 `planAndExecuteAssistantCanvasActions` → 审批 → 可信 Graph Commit → `/deliverables/text/verify` 的前端路径，且现有 Task 面板支持浏览器刷新后恢复已冻结 Step。登记已有未完成规格时，如果用户想换目标，必须先根据状态执行安全拒绝/重规划；不会擅自覆盖目标正文。

**已知边界**：这一轮的修订是**新的 planVersion 与新文本节点**，保留旧节点和历史回执；未实现对已经交付的节点执行原地覆盖或差异合并。当前自动入口只冻结一个默认文本节点；批量多节点必须使用明确的用户确认规格 API，或继续普通画布工作流，不会悄悄合并成一个节点。真实 Provider 生成的语义质量与 ComfyUI/Skill 外部执行不在本轮验收范围内。

## 5. 代码与验证

- `web/server/backend/assistant-task-deliverables.mjs`：类型化注册、版本来源、正文阈值、冻结、来源 Turn Fence、通用验证与复读。
- `web/server/backend/assistant-task-routes.mjs`：新规格注册端点。
- `web/server/backend/app.mjs`：服务端为模型拼入当前已确认的类型化规格，不让模型自行扩大目标。
- `web/server/backend/assistant-task-canvas-executor.mjs`、`assistant-task-step-gate.mjs`：规划、审批、Claim 和提交前重新校验源 Turn，旧角色卡行为不变。
- `web/server/backend/assistant-task-structured-deliverables.test.mjs`：真实 SQLite / HTTP Mock、三类交付、规格篡改、撤销、失败后修订、ZIP 只读、CAS 崩溃回滚、并发验证。
- `web/src/features/canvas-assistant/canvas-assistant-structured-deliverable-intent.ts` 及其测试：仅明确单一交付目标进入冻结入口。
- `web/src/features/canvas-assistant/canvas-assistant-panel.tsx`：用户确认 → 注册 → 模型推理 → 既有执行/验证链路。

本轮已验收：P4.3 专项 18 项通过；相关后端 179 项通过；前端 169 个文件 / 1091 项通过；TypeScript 类型检查通过。生产构建以最终工具执行结果为准。

回归证明以本次 `node --test`、`npm test`、`npm run typecheck`、`npm run build` 的实际输出为准。测试数量有重叠，不能直接累加。

## 6. 下一阶段

**P4.4** 应聚焦已获审批的 ComfyUI/Job/Skill 的受控自动续行：需要单独的执行预算、未知状态对账、可取消性、Job/Skill 可信结果与 Task Step Receipt 的绑定。不可将只读 Agent Run 的 Transcript 事件直接作为外部执行授权。
