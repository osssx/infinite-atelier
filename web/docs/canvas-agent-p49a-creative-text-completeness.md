# P4.9a：明确文本交付指令的内容完整性防护与 Task 纠错上下文保留

> 日期：2026-11-16。基线：`59edbad`，分支 `custom`。本轮实现为代码改造、SQLite/HTTP 与真实 Provider 格式的 Mock 验收；**未使用用户已配置的付费文本 Provider 或真实 LLM 输出**。沿用现有数据库 Schema，不迁移表结构。

## 1. 现有问题与原因

在普通画布动作模式中，`parseAssistantActionResponse` 对 `create_text` 的 `content` 仅校验数据类型和长度，也允许 `create_node(nodeType="text")` 省略正文。因此模型即使给出语法完全合法的「三个角色卡」`create_text`，也可能只创建空文本或「姓名：、外貌：、性格：」空白表单。已登记 `deliverable_required` 的任务有更严格的服务端冻结规格和校验，但没有显式登记规格的通用多文本节点请求缺乏对应入口防护。

同时，`createAssistantChatService` 的原始推理将经服务器授权的 Task 上下文、持续约束、历史 AI 草案纳入 `system`，然而首次响应格式错误后的 `format_repair` 曾只重建 `CANVAS_ACTION_SYSTEM`，使修复请求看不到原 Task 上下文。此时模型容易给出空白内容，或重新创作与上轮不一致的人物。

## 2. 实施与安全边界

- `assistant-creative-content.mjs`：窄范围识别**明确要求创建角色卡、故事大纲、场景设定、剧本或分镜的文本节点**的积极指令。只有这类请求启用正文完整性门槛；讨论、普通非文本节点、纯文本问答、未指定创作类型的普通文本节点不启用。
- 只有用户明确要求「空白」「空模板」「不填正文」时允许无正文；「不要空白模板」等否定表述不能获得空正文例外。
- 在模型动作解析后、任何动作返回前，确认至少一个新建文本节点，并检查这些文本节点都具备具体正文。少于 18 个有效文本字符、多个空表单标签、「待填写/TODO」占位符会被识别为不完整。
- 首次输出不合格时，**最多一轮** `format_repair`，补救调用恢复原始 `system`，包括该 Turn 的服务端 Task 上下文及已授权历史草案，并明确提示不能把未确认的模型草案冒充用户设定。
- 补救结果仍不合格，返回 `assistant_creative_content_incomplete`（HTTP 502），不返回可执行动作；前端给出中文可恢复错误，不宣称已经写入画布。
- 每次真实上游 POST 继续由现有 `callObserver` 与 `providerPayloadGuard` 独立审计；不重复发送请求、自动改写用户确认范围、跳过审批/Step/Graph Commit，也不把文本完整性检测冒充模型语义质量评价。
- 既有 `create_node` / `create_text` 接口的数据结构和「空模板」功能保持兼容，未在全局 parser 禁用空内容。
- 有显式 `deliverable_required` 的 Task 继续沿用 P4.0/P4.3 的冻结规格、批准操作、正式 Graph 写入和唯一完成验证器；本层仅作为模型响应返回前的质量预检。

## 3. 本轮测试证据

- `assistant-creative-content.test.mjs`：识别正负意图、模板例外、三人物具体内容、空占位符、模型答复格式纠错后上下文完整保留、最多两次模型 POST 与失败拒绝。
- `assistant-creative-content-http.test.mjs`：真实 Fastify + 内存 SQLite + Mock OpenAI-compatible 完整 Task HTTP。两次 Provider 格式响应分别记录为 `initial` 和 `format_repair`；首次空白后成功返回三角色文本操作，但不自动修改画布；两次空白时服务器返回 `assistant_creative_content_incomplete`，且项目修订号仍为 1、Graph 节点仍为 0、Jobs 仍为 0；相同命令 ID 不自动重复支付或上游 POST。
- 前端 `canvas-assistant-panel.test.tsx`：展示明确的空正文失败提示。
- 有关 Task 创作来源、隐私隔离、持续约束、冻结规格与 Step 的既有测试一并回归。

此处**未**做真实 Provider 文学质量评价。规则只能检测空白/占位文本，不能证明正文的人设、场景空间关系或分镜镜头语言符合需求；即使通过 18 字门槛也可能存在剧情矛盾。

## 4. 后续 P4.9b：人工判读的真实文本 Provider 质量验收

建议单独的、显式同意消耗模型额度的隔离 Task：使用固定的中文儿童动画故事设定、确认三角色、三个场景、6 个分镜及追加变化条件进行两轮生成。保持完整 Prompt、冻结的用户确认事实与 Task 状态；对照结果按以下维度做人工抽检：人物数量与姓名、外貌服饰前后一致、动机与角色关系、场景空间连续、分镜与故事事件映射、改写后未覆盖旧已确认事实、Task 续行与刷新一致性。针对遗漏与冲突输出问题清单，而不是让模型决定 Task 终态或修改用户材料。

真实 Provider 验收尚未执行。执行前应明确授权渠道和模型；不得读取或输出密钥，不在生产画布自动写入，也不在前端隐式多次调用付费模型。费用金额硬上限、长视频和负载测试按用户决策继续延期。

## 5. 当前已知限制

现有 `failAssistantModelCommand` 在已经发出 Provider POST 后对本地格式/内容拒绝仍保守地将命令记为 `needs_reconcile`（即使每个 Provider 回执均为成功）；同一 `requestId` 不能直接重放，需要显式新请求 ID。真正的网络未知状态仍必须对账。本阶段不迁移 Schema 或放宽幂等隔离；后续可以区分「已收到结果，但本地内容拒绝」与「远端结果未知」，减少误导性的 Task 诊断。
