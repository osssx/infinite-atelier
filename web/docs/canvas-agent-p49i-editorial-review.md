# P4.9i：剧情事件候选审核、来源冻结与独立编辑决策

> 2026-11-16，基线提交 `725195d`。本阶段新增在线文本模型调用 **0 次**；使用独立 Fastify + SQLite + Mock Provider 完成实际 API 验收。保留 P4.9f 四阶段真实模型结果、所有已成功请求以及 P4.9c 未知回执不变。

## 1. 新增接口与数据边界

在现有 Task API 注册两个接口（`web/server/backend/assistant-task-routes.mjs`）：

- `GET /api/v1/projects/:id/assistant/tasks/:taskId/story-events/review?turnMessageId=...`：对**最新已冻结的分镜修订用户回合**进行只读审核预览，不消耗 Provider 请求。
- `POST /api/v1/projects/:id/assistant/tasks/:taskId/story-events/review`：用户显式选择某项剧情事件的编辑审核决定；必须提交 `confirmed: true`。只新增编辑审计，不改画布、Job、模型响应或 Task 长期语义。

客户端在 GET 结果中读取 `snapshotDigest`，把它原样传回 POST。请求体示例（仅是字段示意，不包含任何私有模型正文）：

````json
{
  "requestId": "editorial-review-1",
  "turnMessageId": "revision-turn",
  "snapshotDigest": "64位SHA-256小写十六进制",
  "eventId": "star_returns_to_sky",
  "decision": "request_revision",
  "confirmed": true
}
````

决策目前有两种：

| 决策 | 解释 | 不做的事情 |
| --- | --- | --- |
| `acknowledge_candidate` | 审阅并记录“已看到该候选”，不宣称其语义正确 | 不把模型文本标记为用户确认事实，也不准许执行 Canvas |
| `request_revision` | 审阅并记录“这项事件仍需修订” | 不自动重新请求模型、不修改任何分镜正文 |

**这两个决定都只是编辑审核结果，不是发布批准，也不是 Task 完成授权。** 即使全部事件被 `acknowledge_candidate`，接口仍返回 `canvasExecutionAuthorized: false`、`taskCompletionAuthorized: false`、`semanticReview: pending`。本轮没有新增 Canvas 事务准入门槛，不能把 API 误说成已完成产品级工作流 UI。

## 2. 来源冻结

实现：`web/server/backend/assistant-story-event-review.mjs`。

审核源严格从服务端数据库中的 **同一 Task** 重新计算，不信任调用方传来的分镜内容、事件结构、故事角色、来源标题或“审核已通过”字段：

1. 项目必须存在、Task 必须属于该项目；审核指定回合必须是当前 Task 的**最新用户回合**且明确为“修订分镜/镜头”，旧回合不能用于发起新的审批。
2. 当前已完成修订命令与其上一版分镜命令，都必须有真实的 `model_command_started`→`user_turn` 绑定、`assistant_model_calls` 全部 `succeeded`、对应文本动作。仅有 `completed` 字样而没有调用审计和来源回合绑定，不能成为事件证据。
3. 历史回合必须通过本轮冻结的 `mayRepeatTurn` 披露范围验证；之前明确选取的私有创作素材不会在本轮自动扩大引用范围。源命令的服务端开始事件必须早于当前修订回合，防止一项实际上较晚启动的模型调用被冒充为“以前的草案”。当前回合有未知模型回执、缺少成功修订输出时拒绝生成审核快照，不回放远端请求。
4. 从两份真实分镜文本调用 P4.9h 版本化 IR 提取器与比较器，计算事件列表、疑似丢失事件和时序倒置。读取侧只输出受控目录标签、事件 ID、镜头序号与摘要，**不对外提供原始文本、模型生成的任意标题、API Key 或未授权画布内容**。
5. `snapshotDigest` 绑定 **项目 revision、Task activePlanVersion、长期语义 revision、最新 turn/冻结上下文策略、源及修订命令 ID 与实际响应全文 digest、受控事件目录 digest**。任意相关项改变，旧的审核决定就不适用于新快照；旧记录可以被审计，但不会成为新版本“已审核”。
6. 审核写入在单个 SQLite 原子事务内完成，通过 `assistant_task_events.kind=story_event_review_decided` 与 `assistant_task_commands.command_kind=story_event_review_decision` 保存。**不迁移 Schema**、不引入新的生成 Job 或模型费用。
7. 相同 `requestId` + 相同参数重放只返回已有决定 `existing: true`；若已经过期，返回 `current: false`，不暗示旧审核仍然有效。相同 ID + 不同参数冲突；同一事件不允许新请求偷偷覆盖已经记录的决策。

### GET 状态

- `reviewStatus: pending`：仍有剧情事件尚未记录人工选择。
- `reviewStatus: recorded_only`：当前候选全部已有编辑决策，但**不代表整体语义质量通过**。
- `reviewStatus: no_source_candidates`：源目录无法提取可靠候选，不允许凭空生成事件义务。

`comparison[]` 会列出各事件是否在修订中被候选规则观察到、出现于第几镜、差异预警和当前编辑决定。按 eventId 决策，不接受客户端自造的新事件。

## 3. 实机隔离 HTTP 验收

新增 `web/server/backend/assistant-story-event-review.test.mjs`，真实 Fastify + SQLite Task 下通过 Mock HTTP 模型响应产生**两次已审计模型命令**，包含在森林发现星星、石桥救援、结尾遗失归还动作的修订差异。测试并非模拟返回 API JSON，而是完整执行 Task 回合和事件审核端点。

覆盖：

- 查出 `star_returns_to_sky` 在原版存在、修订版缺失，原分镜/修订分镜响应摘要固定。
- 编辑明确选择后持久记录，重复请求幂等，用户长期语义及 Canvas/Jobs 均不改变。
- 假造 eventId、假 snapshot、未明确确认、冲突 requestId、跨项目 Task 均拒绝。
- 项目 revision、长期用户语义 revision、新的用户回合或模型响应内容发生变化后，旧审核快照失效；历史同 requestId 只能返回无效当前性 `current: false`。
- 当前回合模型 `needs_reconcile` 不产生可审核快照，不重试 Provider。
- 前一模型调用实际上在当前回合后启动、或源回合曾固定私有材料时，不复用其草案。
- 修订完整保留候选时也不能成为自动 Task 完成授权。

## 4. 当前限制与下一步 P4.9j

- 本阶段是**服务端 API/审计通道**，尚未在 Canvas Assistant 面板制作审核表单。若要直接点击逐事件“已查看 / 需要修订”，下一步需按 UI 主题实现用户操作。
- 目前没有在实际 Canvas 事务提交前强制要求此审核记录，也没有自动依据本 API 更改 Task 完成验证器；这仍需要与现有步骤审批及来源冻结机制明确集成。
- 事件 IR 仍是有限的词组/时序**编辑提示**，不能替代人物状态推理、影视镜头连贯性理解或独立人工质量签署。

下一步优先实现审核面板及**来源摘要绑定的显式应用前确认**，在不授权旧编辑快照修改新画布的前提下形成用户可见的审阅路径。继续推迟金额级费用硬上限、长视频及负载测试。
