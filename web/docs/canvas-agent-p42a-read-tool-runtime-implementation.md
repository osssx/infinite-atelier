# P4.2a 实施记录：Task 只读工具与有界模型读取轮次

> 日期：2026-11-14 · 范围：**P4.2 首个可验收子阶段（P4.2a）**。
>
> 状态：已实施服务端只读 Tool Registry、受控模型工具往返、Task 级活动轮次互斥、持久审计；完整通用 Agent Run/Transcript 及非只读工具恢复留给 P4.2b。未使用真实 Provider/GPU。
>
> 设计背景：[画布 Agent P4 总方案](./canvas-agent-p4-improvement-design.md)、[P4.1b 创作资料](./canvas-agent-p41b-creative-materials-implementation.md)。

## 1. 实现路径

- `web/server/backend/assistant-agent-read-tools.mjs`：服务端所有可调用的读工具均来自一张静态注册表，属性 `effect="read"`、`approval="none"`；不能从客户端或模型注入新工具名。Canonical 名称以点分隔，实际 OpenAI-compatible function 名称使用下划线：
  - `canvas.get_map` → `canvas_get_map`：本轮允许的节点标题、类型、ID；概要模式绝无节点正文。
  - `canvas.search_nodes` → `canvas_search_nodes`：只搜索授权节点；概要只检索标题、selection 才允许正文检索。
  - `canvas.read_nodes` → `canvas_read_nodes`：最多 4 个**当前已选中**节点的受限正文/prompt；不能读取相邻未选节点。
  - `canvas.get_connections` → `canvas_get_connections`：连接两端都在授权范围内才返回。
  - `task.read_history` → `task_read_history`：按当前冻结 Turn 允许重复的历史用户陈述及可信 Step 状态；客户端报告不能作为执行回执。
  - `creative.search` → `creative_search`：复用 P4.1 的 Task 内角色及故事/场景/画风来源检索，明确区分历史模型草稿与用户事实。
- `web/server/backend/assistant-agent-read-rounds.mjs`：复用已有模型网关的 JSON/SSE tool-response 解析及逐次 Model Call 审计；本轮最多 **2 轮工具读取、3 次模型 POST、6 个工具调用**；每项工具结果最多 **4 KiB**、每次请求累计 **12 KiB**。不支持非法工具、重复 callId、无限循环或自动 downgrade。
- `web/server/backend/app.mjs`、`assistant-chat.mjs`：通过关联 Task 的显式 `agentReadTools=true` 请求进入该路径；冻结当前 Turn 的披露策略与工程 revision，读前、每次工具调用前及每次付费 POST 前再验证。与 `skills`、视觉输入、`semantic_proposal` 或 Gemini 的组合在前置阶段拒绝。所有最终画布动作仍仅作为原有 JSON Action *提案*，继续走 Task Step 批准与 Canvas Executor。
- `web/server/backend/assistant-model-calls.mjs`：现有模型命令事务以 `model_command_started.agentReadTools` 标记活动只读轮次；**同一 Task 的第二标签页无法抢占**。真实模型 POST 仍逐次创建 `assistant_model_calls` 记录。没有创建另一个写入者或另一本账。
- `web/src/features/canvas-assistant/canvas-assistant-read-tool-intent.ts`：前端只对关联 Task 且明确请求搜索/查看画布、任务历史、角色或创作资料时选择读工具模式。普通创作、非 Task 对话与用户已确认的 P4.1b 来源流程维持原状。

## 2. 持久化与恢复边界

复用现有 `assistant_task_events`，只存**无敏感正文**的工具读取元数据：

- `model_command_started`：请求 ID、原始消息 ID 及当前是否启用了只读工具。
- `agent_read_round_planned`：`requestId`、`round`、`sourceRevision`；在每次 Provider POST 前以同步 SQLite 事务创建轮次检查点。
- `agent_read_tool_completed`：`callId`、Canonical 工具名、参数/结果摘要、结果字节数、图版本及轮次；**不存储原始私有工具输出**。
- `assistant_model_calls`：每次真实 POST 的提交、完成、未知状态、父调用 ID 和顺序索引；`model_command_completed` 仍是请求最终结果。

若进程在 POST 后丢失结果，原有 `needs_reconcile` 规则阻止自动重发；本阶段**不从不完整事件拼接续轮、不自动补做模型推理**。如果只有轮次检查点、从未产生任何模型 POST，现有 `failAssistantModelCommand` 可释放命令，且 round 0 可以安全复用。由于本轮无 Schema 迁移，续轮模型在 `assistant_model_calls.call_kind` 暂沿用允许的 `initial` 类别，由 `call_index` / `parent_call_id` 与 `agent_read_round_planned.round` 关联。升级专属 `agent_read_round` 类型及稳定 Agent Run/Transcript 表应在 P4.2b 设计备份与兼容方案后独立迁移。

## 3. 安全与兼容性说明

1. **没有改动 Graph/Job/Skill 写入路径**。只读 Tool Handler 不会批准 Step、物化产物或执行 Skill 脚本；已有 P4.0 完成栅栏不变。
2. **用户本轮授权是上限**：overview 无正文；selection 仅 ID 白名单；未授权节点即使在图上与选中节点相连也不能被遍历读取。
3. **模型结果不构成执行事实**：历史创作草稿仍标记未确认，Task Step 只有 `server_committed` 才能作为实际已执行证据。
4. **范围有意收窄**：仅 OpenAI/OpenAI-compatible 原生 function calling；不支持 Gemini、同轮 Skill/图像工具混用。模型不支持工具协议时直接失败，不改走另一执行路径。
5. **尚不包含**：完整持久 Run 所有权/Transcript 恢复、Agent 结果浏览器侧交互面板、长时间外部 Job 自动续行、任意画布写入工具及真实 Provider 的内容质量测试。下一步为 **P4.2b**，需要独立审查迁移/备份计划。
6. 当前浏览器只是按照明确文字意图启用工具。无权自动跨 Task 或跨未关联 Chat 读取创作资料。

## 4. 验收证据

- `assistant-agent-read-tools.test.mjs`：工具权限、Node/Graph 越权、角色/Task 检索、重复调用 ID、UTF-8 预算、并发 Task、Mock Provider 两轮往返、超轮限制、预提交检查点与非 Task 拒绝。
- `assistant-model-calls.test.mjs`：P3/P0b 模型调用、模糊提交禁止重试、格式修复、Skill 调用身份、Task 消息严格一致及授权创作草稿。更新了历史测试中已被 P4.0 禁止的**客户端历史注入**夹具与无可信 Turn 绑定的虚假模型结果，未放宽服务端校验。
- `canvas-assistant-read-tool-intent.test.ts`：纯函数测试显式任务查询才启用；普通创作、非 Task 不启用。
- 其他 Task Executor/角色交付旧回归保留，具体通过数量以本轮测试工具报告为准，勿将专项测试数简单相加。

执行过程未调用任何真实 GPU、付费 Provider，也未创建新的 SQLite Schema。
