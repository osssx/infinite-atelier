# P3：可信事实摘要与长会话连续性

> 实施于 2026-11-13。对应 `assistant-task-state-design.md` 第 8、12 节和 `assistant-task-archive-v2.md`；不改动原设计文档的历史讨论。

## 实施边界

`assistant_tasks.summary_json` 由服务端的 `assistant-task-facts.mjs` 从 SQLite Task、有效 Step、Server Receipt、模型 Call 状态、`user_turn` 事件重新推导。**没有让模型写 summary 的权限，也没有来自客户端的“执行成功”快捷入口。**

- `summary.version=1,source=server_derived`；存原始 Task 状态、有效计划版本、事件游标、用户续写总数与最多最近 20 轮（每条至多 160 字的原始用户输入预览及其当轮授权快照；授权 ID 过长时按 12 KiB 预算裁剪最旧预览，但永不裁剪事实计数）、模型 Call 计数、当前计划状态分布、可信回执数量及生成/物化/画布事务计数。
- 仅 `step.status=succeeded && step.receipt_trust=server_committed` 计入可信回执；当前计划另要求 `step.plan_version=active_plan_version && superseded_at IS NULL`。旧计划可信回执只做审计，不能被视为新计划依赖已经满足。
- `model_job/comfy_workflow` 的可信产物数量与 `materialize` 的可信落图绑定分开。模型输出文字和 `client_reported_reply/error` 不产生任何可信完成。
- Task 快照生成时在同一 SQLite `BEGIN IMMEDIATE` 事务中按原始记录刷新并持久化摘要，随后读取 Step 和 `lastSeq`，确保返回视图不丢事件。通常写入命令本身会返回 Task 快照并刷新摘要；仅由 Job/Materializer 造成的后台变化在下一次 Task 快照读取时刷新。重复读取内容不变不会更新 `updated_at`、`project.revision` 或新增审计事件。
- `read_only=1` 的 ZIP 导入 Task 保持归档内冻结的原始摘要，不会因为本机读操作而重写或激活旧 Job。
- Task ZIP v2 导出时对非只读 Task 即时从源数据库推导摘要，即使后台状态变化后还没有触发 GET，也不会把过时的缓存摘要打入归档；导出不写入任何新的任务状态。

## Provider 外发与隐私

外发上下文继续使用冻结的 **本次 Turn** `contextPolicy`，而不是某个标签页之后修改的默认选择。Task 的事实统计只包含数量、状态与类型，不包含节点标题、提示词、Step 原始结果、完整事件或私有媒体。最近用户请求是**非可信用户陈述**，不能作为审批或执行凭证；只在该历史请求的画布权限范围不大于本轮冻结权限时加入摘要，且用 JSON 字符串表示、做凭据和媒体数据脱敏。当前用户 Turn 从历史列表排除，防止在模型请求中重复。未授权范围内的画布实体仍不外发。Task 原有上下文总长度上限 12,000 字符。

助手面板在任务快照就绪时显示累计续写轮数、当前计划可信 Step 比例与待对账数量。只读归档显示历史摘要，不给恢复执行入口。

## 验收与非目标

- SQLite 文件持久化的连续 28 轮用户请求 → 关联第二聊天会话 → 关闭并重新打开数据库；无客户端历史也能重建摘要和恢复目标。
- HTTP 模型调用携带跨 15 轮以上历史用户意图；只发送最后一条实时用户消息，不重播过往 assistant 文本和旧画布私有信息。
- 旧计划成功状态不能满足新计划；客户端伪造成功文案和仅有 `client_reported` 的 Step 不计入可信结果。
- 节点外发许可从 selection 缩窄为无上下文后，历史旧选择请求不再发送。
- Task ZIP v2 原有只读语义保持，Task 摘要不是可执行授权，也不代替每次真实 Job/Skill/Comfy 的原始数据库校验。

这轮不引入 LLM 自由文本自动总结、跨节点语义记忆、对外部 Provider 真正的收费生成，也不将 Chat Session 与 Task 的所有原始问答合并外发。超过最近 20 条用户请求时，保留累计轮数及不可覆写的原始 Task 目标，较旧请求仍可通过 Task 事件审计查询，不能承诺模型自动理解所有更早的细节。
