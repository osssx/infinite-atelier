# P3：AI 长期记忆候选与人工确认

> 2026-11-13；本阶段扩展 `assistant-task-semantic-p3.md`，不改动既有用户确认语义结构和可信 Step 回执。

## 核心流程

1. 用户在 **AI 助手 → 当前任务 → 长期目标与决策** 点击「提取 AI 记忆候选」。前端先以当前画布权限登记独立的 `user_turn`，再用已配置的文本模型调用 `/api/v1/projects/:id/assistant/chat`，携带 `task.callKind="semantic_proposal"`、`canvasActions=false`。这是明确的模型调用，会按渠道计费，不是静默后台操作。
2. 后端只接受单条关联 Task 模型消息，**拒绝画布动作、Skills、视觉上下文**；冻结本轮已有 `turnMessageId` 的 Task 授权。服务端覆写实际发给模型的用户提示，并使用严格的提案专用系统提示（不提供执行工具）。
3. 该调用沿用 `assistant_task_commands` / `assistant_model_calls` 的幂等和不自动重试策略；`model_infer` 的请求摘要覆盖 `semantic_proposal` 标志，实际 upstream call 仍用当前 Schema 已支持的 `initial` 类别，不引入迁移。模型的 JSON 正文只经服务端解析，最多产生 5 个 `goal/constraint/decision` 候选，每条有服务端新生成 UUID、最长 400 字（goal 600 字）、脱敏筛查和重复合并。无法解析的回复产生零候选，绝不被作为已确认事项。
4. 候选和来源时刻的权限快照随完成的模型命令 **在一个 SQLite 事务中**写为 `semantic_proposals_generated` Task Event（`source=model_suggested`）。重放同一 request ID 不再请求模型，也不会再产生事件。历史只读查询：`GET /api/v1/projects/:id/assistant/tasks/:taskId/semantic-proposals`。
5. 用户逐项点击「确认候选」或「拒绝候选」，进入 `POST /api/v1/projects/:id/assistant/tasks/:taskId/semantic-proposals/decision`。接受时以独立语义 `expectedRevision` 做事务 CAS，保留来源权限并将文本写入原本的 `goal_json.current` 或 `constraints_json.semantic.notes`（标记 `user_confirmed`）；拒绝仅追加 `semantic_proposal_decided` 审计事件。两者都会关闭该条候选；接受还会在同一事务内写入 `semantic_user_confirmed` 审计事件；均不会修改 Plan/Step/Attempt/Job/Skill 状态。请求有自己的 `requestId`，同请求重复返回旧回执，不会写两次。

## 授权与信任边界

- 模型建议**不是**用户确认、可执行命令或成功执行证据。服务端不提供由客户端提交候选文本的入口；前端只能以服务器生成的候选 ID 决定接受/拒绝。
- 若候选来自早前选定的私有节点，接受前当前授权必须覆盖来源授权；拒绝仅更改候选状态，不需重新授权其历史画布资料。被接受的语义记录仍保留**来源授权**，不会因为用户确认而扩宽以后 Provider 的可见性。
- 仅当前用户明确点击才调用模型或处理候选。候选读取和 Task 归档是只读，`read_only` ZIP 恢复后的 Task 无法接受或拒绝，不会激活旧模型/Job。
- 缺失或不完整的模型回执不能生成候选；真实模型 API 的不确定结果沿用原账本 `needs_reconcile`，不能凭前端重复提交。
- 任务上下文的历史上限仍适用：模型从当前授权下的原始目标、最多最近 20 轮用户预览、持久确认目标与可信执行事实中提取候选；**不保证自动恢复更久之前未被明确保留的全部对话内容**。

## 手动与自动验收

- 单次模拟上游调用返回两项提案：两条均为 pending；分别接受、拒绝后，只有一条写入长期语义。重复 POST/变更请求不会重复计费或重复确认。
- 来源私有节点的候选：当前范围收窄时接受返回 `assistant_semantic_proposal_scope_changed`；恢复相同节点授权后可人工确认并保留旧权限。
- 模型输出非法 JSON、敏感值、不合适字段时不创建已确认记忆。
- 32+ 轮 Task 续写、备份 ZIP v2 再导入独立数据库：pending 候选仍可只读查看、没有恢复模型调用和可执行 Job。
- 前端生成→展示→逐条确认/拒绝→重新打开面板后状态保持；只读归档隐藏生成/决定按钮；整个流程不得调用媒体生成队列。

## 下一阶段

用真实已配置的 ComfyUI/MiniMax 工作流对 `Task → 计划 → 审批 → Job 提交 → 对账 → 产物物化 → 新会话继续` 做端到端验收（优先验证重复提交防护和失败对账）。本阶段不执行真实付费生成。
