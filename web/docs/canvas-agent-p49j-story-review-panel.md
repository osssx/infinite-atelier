# P4.9j：Canvas AI 助手剧情事件审核面板与冻结步骤来源预检

> 2026-11-16，基线：`a5ff47b`。仅改正式产品的 Task 详情与后端只读来源核验。本轮**新增在线 Provider 模型请求 0 次**，P4.9f 已完成的四次真实 Cline 调用不重发；工作区原有其他未提交内容不触碰。

## 1. 任务详情中的剧情事件审核

前端新增 `web/src/features/canvas-assistant/canvas-assistant-story-review.tsx`，在现有 `canvas-assistant-task-state.tsx` 的**任务详情**中挂载。用户点击“剧情事件审核（只读差异）”后才访问 P4.9i 的 GET 接口，默认不自动请求模型、不创建任务步骤或改画布。

- 预览每个候选事件的标签、原始镜头索引、修订镜头索引，以及“候选保留／修订中未观察到／顺序变化”状态。
- 对待审核事件逐项显示“已查看”和“需要修订”按钮，分别提交 `acknowledge_candidate` 或 `request_revision`，请求体只传当前服务端快照 SHA-256、事件 ID、当前用户回合、唯一 requestId 和明确 `confirmed:true`。没有浏览器生成的模型文本、`userConfirmed` 或步骤批准字段。
- GET/POST 回执必须与当前任务、用户回合和待审核源摘要相符；错误或过期时清空当前结果并提示刷新。切换 Task、聊天用户回合或冻结步骤时清除旧审核与 UI 预检标记，丢弃延迟到达的旧请求结果。
- 仍保留旧 Task 的状态展示、长期事项编辑、媒体生成和 Skill 操作；本面板的按钮与其互不替代。
- 已归档 Task 允许查看，但禁止新的审核决定或步骤来源预检。

面板中**“已查看”只是编辑审计，不会升级为长期用户确认语义，更不会默认批准 Canvas 执行**。

## 2. 冻结步骤的应用前来源预检

后端新增只读接口：

`GET /api/v1/projects/:id/assistant/tasks/:taskId/story-events/review/preflight?turnMessageId=...&snapshotDigest=...&stepId=...`

实现：`web/server/backend/assistant-story-event-review.mjs` 中的 `inspectAssistantStoryEventApplyPreflight`。会重新核对（不会读取浏览器自报的动作正文）：

1. 当前审核快照必须仍和项目、Task 计划/长期语义版本、最新用户回合、双方模型成功响应与目录版本相符；
2. 至少有一项原始关键剧情事件；每项必须有显式编辑记录，且**无“需要修订”决定、未解决的缺失/时序预警**；
3. 待应用步骤必须是同一 Task 当前计划中尚未完成、未作废、已冻结并等待人工审批的 `canvas_mutation`；
4. 冻结步骤的 `actionDigest`、`preconditions.projectRevision`、`agentRunBinding.requestId`、原始模型回复 digest、`agentActionsDigest` 和实际 Graph Actions 逐项一致。缺少可信 Agent Run 来源绑定的普通步骤**保守地返回未核验**，不猜测它属于哪个分镜；
5. 返回 `verified:false` + 受控原因，或 `verified:true` + 原冻结步骤 action digest。**无论结果为何**，响应固定 `editorialOnly:true`、`canvasExecutionAuthorized:false`、`taskCompletionAuthorized:false`。

前端只有在最新 GET 审核仍就绪且冻结步骤预检**同源同摘要**时显示“当前快照已完成编辑候选初核”。不存在待审批的 Agent 绑定画布步骤、发现剧情事件遗漏或要求修订时不会给出通过标记。预检标记依赖 Task/用户回合/步骤/actionDigest 的 UI scope，切换任何一项均失效。

**注意：这是来源核对和用户可见的非授权提示，不是新的画布事务完成栅栏。** 实际应用仍走原来的 frozen Step -> 逐项人工审批 -> server commit -> graph revision/content digest 栅栏。用户不能借预检 `verified:true` 跳过步骤审批，当前版本尚未把这个编辑预检插入所有生产 Canvas 提交流程。

## 3. 自动验收范围

服务端 `assistant-story-event-review.test.mjs` 新增源绑定预检案例：

- 未完成编辑审核时返回 `editorial_decisions_pending`；
- 事件全部审核、正文无缺失且现有冻结 Agent 步骤与修订回复完全绑定时预检通过，但 **0 个 Canvas Attempt / Job / Provider POST**；
- 未解决的剧情遗漏始终不通过，即使已标“已查看”；篡改冻结步骤原模型动作摘要不通过；旧 Project revision 的快照过期失败。

前端新增 `canvas-assistant-story-review.test.tsx`，覆盖点开加载、逐项提交、正常/异常来源预检、切换 Task 丢弃旧异步结果及只读模式。扩展现有 `canvas-assistant-task-state.test.tsx` 验证任务详情挂载和实际 scoped API URL。前端没有直接调用 POST `/execute`、`/approval`、`/canvas-steps` 的路径。

## 4. 仍需完成的生产整合（P4.9k 建议）

当前只支持**可信 Agent 运行绑定的冻结文本画布步骤**的来源预检，不对普通模型草案、批量复制或媒体步骤伪造绑定结论。正式 Canvas 执行路径仍以其原生审批为准，尚未要求所有分镜修订必须拿到事件预检回执。建议下一轮：

- 设计在真正的 Graph Step **批准/提交服务端事务内**复核事件快照及其来源（非前端标记），并限定仅影响用户明确选择了“应用此次修订草案”的步骤，避免全局阻断无关的 Canvas 操作。
- 让应用计划将 `storyReviewSnapshotDigest` 与可信 Model Run ID 一起冻结到 Step preconditions，真正将“编辑审核”和“正式步骤批准”并列核验而不相互代替。
- 增加完整人工审稿、剧情 IR 的语义覆盖及更多典型故事测试；金额级费用硬上限、长视频、负载测试继续按原计划延期。
