# P4.9k：分镜修订的服务端 Canvas 提交事务栅栏

> 日期：2026-11-16。基线 `01e83a3`。本阶段仍然**以本地 Mock Provider / 独立 SQLite 测试为主，新增真实在线模型 POST 0 次**，不重放任何先前真实成功或未知回执；没有修改用户实际 Graph 或其他已提交任务。

## 目标和实施结果

把 P4.9j 的**只读**分镜事件审核预检提升为**显式选择后冻结的执行前置条件**。用户点击“准备应用已审核分镜（仅冻结步骤，仍需审批）”，后端根据当前 Task 两轮已完成的分镜结果、人工编辑审核与可信 Agent Run，冻结一个真正的 `canvas_mutation` Step。后续依次经过：

`已审阅候选 → 明确准备应用 → Step waiting_approval → 独立人工批准 → Claim → Graph COMMIT 原子重验`

如果没有显式的 `storyReview` 绑定，现有普通 Canvas 操作（包括媒体链、Comfy 端口绑定、普通文本节点）**不受本阶段的额外剧情审核限制**。分镜审阅本身不会变成新长期用户确认事实，也不会产生自动授权。

## 具体变更

### 1. 后端：只根据可信模型回复规划，不接收浏览器自报动作

新服务 `web/server/backend/assistant-story-review-apply.mjs`，对应 API：

`POST /api/v1/projects/:id/assistant/tasks/:taskId/story-events/review/prepare-apply`

请求包含 `requestId`、`turnMessageId`、`snapshotDigest`、`center{x,y}`、`confirmed:true`，**不包含用户可以直接替换的画布 Actions 或 Model Run ID**。只选择最近被当前 Task 授权、模型命令已经成功、经过逐事件审核且没有遗失/时序预警的分镜修订。

必须有**真实的、服务端可验证的 Agent Read Run**；若原分镜只由普通文本模型产生而没有可信 `agentRunId`，本阶段不会擅自“补造一个 Run”，API 返回明确错误。仅接受源回复中受现有 Canvas Action Schema 支持的纯文本图形操作；不通过这一入口生成 ComfyUI Job、Skill 或动态媒体步骤。

创建步骤依旧调用现有 `planAssistantCanvasStep`：验证 Canvas Plan、冻结 Project revision、CAS 预览、Agent Response 与图形动作 digest，并原子写入待审批 Step。**不会执行、不会批准，也不会触发其他模型 POST。** 相同 request ID 重放由原有 `canvas_plan` 幂等命令防重，修改 payload 复用 ID 会被拒绝。

### 2. 新增编辑来源冻结字段

`web/server/backend/assistant-task-canvas-executor.mjs` 的可选 `storyReview` 参数为：

`{turnMessageId, snapshotDigest, confirmed:true}`

仅允许**已绑定 Agent Read Run 的非媒体、非 Run Sequence、非 Task finalize** 的画布步骤传入。`freezeAssistantStoryReviewCanvasBinding` 校验并冻结：

- 当前 Task 用户回合、上下文披露权限及版本；
- 原分镜、修订版的 Model Command ID 和完整响应 SHA-256；
- 剧情事件规则目录、项目 revision、Task 计划版本、长期语义 revision；
- 逐事件人工决策状态，不能有 `pending`、`request_revision` 或尚未解决的遗漏/时序预警；
- Agent Run ID、模型回复 hash、经 Graph Actions 筛选后的动作摘要，以及它们与传入动作一致。

完整绑定以 `preconditions.storyReviewBinding` 冻结；**同时**将用户显式的 `action.storyReview` 签入现有 `action_digest`。因此即使有人在 SQLite 中单独删除前置条件，步骤的动作仍可证明它曾要求剧情来源审核，不能悄悄降级为普通操作。

新增两个来源审计事件 `story_review_step_bound` 和 `story_review_step_committed`，只存不敏感的 ID、digest 与执行回执摘要，不复制角色卡/剧情正文。

### 3. 真正的提交栅栏

同一个 `assertAssistantStoryReviewCanvasBinding` 复核函数在以下三个写入边界使用：

1. `decideAssistantTaskStep(decision=approve)`：人工批准时源无效则拦截；**拒绝**步骤仍然允许，不会因为历史权限失效而无法撤回。
2. `claimAssistantTaskStep`：真正占用一个已批准的步骤时重新核验。
3. `commitAssistantCanvasAttempt`：在**与项目 Graph UPDATE、Receipt、Task 终态同一个 SQLite 写事务**内重新计算，任何用户回合、权限、模型输出、版本或已确认审核状态变化都使这次画布更新整体回滚。

此处不使用用户浏览器缓存的 P4.9j `preflight.verified` 作为令牌；即使浏览器曾显示预检通过，后续 Graph/Source 改变仍无法提交。原有 Agent Run 绑定、Canvas Graph digest 与项目 revision、人工 Step 审批和 receipt 信任规则**仍需全部同时满足**。

### 4. UI：显式准备应用而不是自动执行

`canvas-assistant-story-review.tsx` 在当前全部事件已作审核决定且无警告，并且尚无相关冻结步骤时，显示“准备应用已审核分镜（仅冻结步骤，仍需审批）”。点击向服务端发送上述审核快照和页面画布中心，在成功后刷新 Task 详情；待审批步骤仍按已有人工批准按钮执行，不绕过存储屏障。若命令不是 Agent Read 来源，安全返回错误供用户继续按正常创作流程整理。

## 自动验收

真实 Fastify + SQLite + Mock Provider 模型回复为基础的 Task 测试覆盖：

- 已审阅的完整三镜头修订 → 冻结 → 独立批准 → Claim → COMMIT，项目 revision 1 → 2，3 张文本节点正确写入，独立重放不产生重复节点。
- 未审核、模型没有 Agent Read Run、冒用 Run ID、剧情缺失、修改相同幂等请求的 center、明确用户确认不足，都不产生新画布步骤或绕过审阅。
- Claim 后编辑决定变化、长期语义 revision 改变、冻结绑定被删除，**在 COMMIT 中拒绝并保持 Graph/Receipt 不变**。
- 故障注入在 Graph UPDATE 之后、Receipt 写入之前失败，SQLite 事务整体回滚、没有可信提交事件、没有 Jobs。
- 原有普通 Agent Run Step、人工撤销/重新规划、归档和模型调用不受影响。
- React UI 测试包括仅用户点击才 POST `prepare-apply`、发送当前 digest 与中心、**不触发 `/approval` 或 `/execute`**，事件仍有警告时不能准备应用。

## 适用范围与下一阶段

这是**用户明确选择“应用此轮已审核分镜”**的服务端原子栅栏，而不是强制所有模型节点创建、ComfyUI 媒体链或任意分镜工作流进入同一条路径。剧情事件识别仍属可声明词组/时序的**编辑候选**，全数已查看并不等于人工语义质量全部通过。普通模型文本输出如果没有可信 Agent Read Run，专用应用接口会停止而非伪造证明。

P4.9l 建议补 **纯文本模型修订结果的可审计转 Agent Step 方案**，或从源头引导“生成草案 → 用户审核 → 真正创建 Agent Run 提案”，使无需历史 Agent Read 回执的典型剧本修订也能安全走显式应用路径；同时按需丰富通用故事事件检测的语义范围。金额硬上限、长视频、GPU 长压测仍按原计划延期。
