# P3 长任务语义连续性：用户确认的目标、约束和决策

> 2026-11-13。本轮接续 `assistant-task-fact-summary-p3.md` 与 Task ZIP v2。实现面向单机、单用户的明确用户确认流程，不引入 LLM 自动记忆写入器或可执行 Plan 修改接口。

## 数据模型

复用现有 `assistant_tasks.goal_json` 与 `constraints_json`，不修改 SQLite schema 版本：

- `original_request` 和 `goal_json.description` 始终保留创建时的目标；`goal_json.current` 是可选用户确认的目标修订，包含 `text, provenance:"user_confirmed", confirmedAt, contextPolicy`。
- `constraints_json.semantic = {revision, notes}`；每条 Note 为 `id, kind:"constraint"|"decision", text, provenance:"user_confirmed", confirmedAt, contextPolicy`。初始状态按 `revision=0,notes=[]` 解释，兼容历史数据和 ZIP v2。
- 每个变更记录 `semantic_user_confirmed` Event，仅保存修订号、操作类型、Note ID 和文本摘要；不在事件中再次复制完整文本。旧版 User Turn 历史、Step/Attempt/Job 的原始回执依旧独立保留。
- 单条目标最多 600 字，约束或决策最多 400 字，至多 16 条活跃 Note；Goal 与 Notes 仍受原字段 JSON 字节、凭据与长度限制。用户删除或修改后由最新状态取代，旧状态不自动成为待执行任务。

## 用户确认接口

`POST /api/v1/projects/:id/assistant/tasks/:taskId/semantic`：

```json
{
  "requestId": "unique-confirmation-id",
  "expectedRevision": 0,
  "operation": "add_constraint",
  "text": "所有镜头必须保持水彩画风",
  "confirmed": true,
  "contextPolicy": {"includeContext": false, "scope": "selection", "includedIds": []}
}
```

操作集合：`set_goal` / `clear_goal` / `add_constraint` / `add_decision` / `update_note` / `remove_note`；更新和移除 Note 时提供已存在的 `noteId`。服务端按 `requestId + payloadDigest` 幂等，独立语义 `revision` 做事务内 CAS；旧版本返回 `assistant_task_semantic_conflict`，不覆盖新内容。输入 `confirmed:true` 由**用户手动保存按钮**发送，是本地用户界面的显式意图，不是后端对人类身份的密码学证明。此端点不从模型回答自动调用。

已完成、已取消、正在取消或存在取消意图的 Task 不能变更；失败/阻断的 Task 可修改未来规划参考，但不能借此恢复执行；已归档的 `read_only` Task 仍可查询语义历史，但完全禁止修改。每次提交仅写语义与审计，不修改 `active_plan_version`、`project.revision`，不发起 Job、Skill、ComfyUI，也不更改 Step/Attempt 的执行证据或费用审批。

## 长会话与隐私

Task Snapshot 与跨会话 Task 关联直接带结构化 `semantic` 字段，SQLite 重启后可恢复；Task ZIP v2 自动包含 `goal_json` 与 `constraints_json`，只读导入不恢复执行权限。生成模型上下文时，将**用户确认事项作为非执行事实**，放在最近用户对话历史和最近 16 条 Step 之前，防止 20+ 轮以后丢失早期决策。

语义记录的 `contextPolicy` 在确认时冻结；每一轮 Provider Context 使用该轮已持久化的 Turn 授权与当轮选中节点名单。旧记录如涉及比当前范围更广的画布上下文，就不外发该条；不会因为新会话或新标签页修改默认选择而自动扩权。允许发送的文本仍脱敏、限长，且显式标识为**用户意向，不能证明 Job 成功、落图完成或脚本已执行**。用户自己输入的文字可能包含早期素材摘录，所以必须遵守冻结的范围。

## 验收

- 32 轮以上用户续写后，仍能查询目标、约束与关键决策；跨 Chat 关联以及 SQLite 重开保持不变。
- 同一请求幂等、不同载荷冲突、独立 Revision CAS、删除/修订审计、敏感文本拒绝、只读 Task 禁止修改。
- HTTP 模拟模型调用：长期公开目标在 30+ 轮后仍被外发，受私有节点约束的事项在未授权回合完全隐藏；授权重新明确选择后才可进入上下文。
- 前端手动确认、移除、只读查看；均不会触发付费执行。
- 与既有 Task/Job/Skill/Comfy/项目 ZIP 回归共存，无需新的数据库迁移。

## 有意保留的下一阶段

本轮**不**自动提取/压缩大量聊天中的语义、不为模型提供可自批准的长期记忆写入工具，也不保证模型理解未被用户明确提炼、且超过最近 20 轮的所有早期对话内容。后续可设计候选约束提案和逐项人工确认（与现有可信事实分离），再进行真实 ComfyUI/MiniMax 的连续长任务验收。
