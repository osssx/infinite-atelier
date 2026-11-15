# P4.4d 第 1 阶段：可信来源标注的用量计量与费用能力栅栏

> 实施日期：2026-11-15。承接 [P4.4c 有界 Job 次数预授权](./canvas-agent-p44c-budget-authorization-implementation.md)。本阶段是**计量与审计底座**，并非金额硬限额完成版。

## 一、现状调研与不能越过的边界

当前 Job 适配器能够可靠记录本地 `queued/submitting/submission_unknown/succeeded` 等状态和实际产物，但这与**渠道实际开具的账单或有法律/协议约束力的价格上限**不同：

- Chat Completions 部分 OpenAI/OpenAI-compatible 响应可能包含 `usage.prompt_tokens`、`usage.completion_tokens` 和 `usage.total_tokens`；但有的渠道不返回、返回格式不一致，SSE 通常还需要专门的 usage 帧。
- ComfyUI、音频、图像、脚本生成、Skill 工具调用、助手文本推理轮次不共享统一的费用/用量回执。一个多次请求的脚本或助手推理可能产生多笔实际费用。
- 用户自定义兼容 API 地址和模型名称不能当成任何 OpenAI 官方价格表的授权，也不能假设一致的货币、折扣、缓存计价或实际结算方式。
- `submission_unknown`、仅本地停止等待、远端失败或取消可能已经产生账单；此时客户端/服务端都不得将金额或用量自动记为 **0 元**。
- 当前**没有**服务端可信的价目版本、实际计费凭据、预先有界的最大费用报价或 Provider 承诺上限。因此必须拒绝将这些上游 token 或人工输入估价宣称为**美元硬上限**。P4.4c 的 Job 次数硬栅栏仍然有效。

## 二、本轮落地的证据链

### 1. 适配器原始响应 → 规范化 → Job 事件

`web/server/backend/openai-model-adapter.mjs` 支持从成功完成的 Chat Completions JSON 或完整 SSE 用量帧中获取三个 token 计数。

`normalizeAssistantTokenUsage` 只接受三个非负整数、上限安全、满足 `prompt + completion = total` 的严格计数；全零报告（与非空文本生成矛盾）、字符串、负数、精度损失、溢出和不匹配均标记为无效。不存储 Provider 原始请求/响应、`usage` 里的未知字段或凭据。

`recordAssistantModelUsage` 在真实 Job Adapter 调用时通过 SQLite `writeTransaction` 记录单次 `model_usage_reported` 或 `model_usage_unusable` 事件。事件只包含规范化 token 数字或固定无效理由，`source=upstream_response`。相同 Job 再次回放相同规范化结果是幂等；冲突回执拒绝，不能累加重复用量。

无 `usage` 字段则**不生成零数值事件**。不完整 SSE 或网络不确定时不标记为计量完成。

### 2. Task 范围的只读报告

`GET /api/v1/projects/:id/assistant/tasks/:taskId/cost-report` 从可信的 `assistant_task_attempts.external_id` → `jobs` → `job_events` 关联已入队的 Job。只有 Job 当前状态是 `succeeded` 且有唯一规范化用量事件时，才增加 **upstreamReportedTokens** 小计；其他状态严格区分：

| 计量状态 | 语义 |
| --- | --- |
| `upstream_reported` | 本地 Job 成功，存在上游报告 token；**不代表实际账单** |
| `usage_unavailable` | 本地 Job 成功，但无可用的 token 计量回执 |
| `billing_unverified` | 可能已远端提交，含结果不明、远端失败、取消等；实际费用未知 |
| `not_submitted` | 未出现提交标记；本地未执行上游请求 |

Task 另单独统计 `assistant_model_calls` 中的助手推理调用次数并明确标记为**未计量**。不会把仅统计了 Job 的 token 总数冒充全部 AI 请求的耗费，也不会把“没有用量”理解为免费。

`monetary` 明确输出：`currency=null`、`rateCardVersion=null`、`preflightMaxChargeMicros=null`、`settledAmountMicros=null`，`reservationSupported=false`、`settlementSupported=false`、`hardCapSupported=false`。**不提供伪造费用注入或结算 POST 入口**。当前无可靠基础，美元预算不可用。

### 3. 前端审计入口

Task 面板新增“查看生成用量（只读）”。只有用户点击后才请求报告，不触发任何模型、Job、Skill 或结算。展示输入/输出/总 token、上游可用量回执数、缺失用量、结果不明、未提交和助手推理调用次数。跨 Chat/Task 的滞后异步返回由 epoch 隔离；切换 Task 清除旧报告。所有金额只以**尚无法核实**显示，不伪造美元数值。

## 三、边界与未完成能力

**这是 P4.4d 的第一阶段，不是完整金额预算系统。** 尚未支持：

1. Provider/模型/地区/渠道/版本绑定的可信价目来源与历史快照。任何官方价格查询都需要和真实账户费率、优惠及账单核对，不能默认为官方价即实际价格。
2. 预执行费用 **maxCharge** 上界、预算预留和防并发超支锁；用户自定义 OpenAI-compatible 端点与无界 token 输出不具备硬上限资格。
3. Billing 发票、服务端实际收费回执、按渠道账单 ID 幂等的金额结算与差异对账；结果不明的独立补证。
4. Assistant 模型推理轮次、脚本里多次模型调用、ComfyUI、音频/图像/视频的完整用量对接。
5. 关闭 Canvas 后的付费自动执行或跨进程付费调度。P4.4b/P4.4c 的已有限制保持不变。

**下一阶段 P4.4d.2** 应为逐 Provider 实装可信费用能力协议：经验证的 `quoteVersion + preflightMaxCharge + currency`，原子预留、实际金额回执与 idempotent settlement，审计异常、发票核对和超额阻断。未达到实际可验证上界时只支持「预估」而不得启用「金额硬限额」。

## 四、验收与范围

新文件：
- `web/server/backend/assistant-task-cost-metering.mjs`：严格规范化、Job 持久用量事件、Task 范围只读汇总与禁用货币额度声明。
- `web/server/backend/assistant-task-cost-metering.test.mjs`：真实 SQLite、模拟 Provider、完整/缺失/无效/SSE/中断、重复冲突、跨 Task 隔离、助手推理未计量计数、HTTP 只读、双连接幂等。
- 现有 `openai-model-adapter.mjs`、`assistant-task-routes.mjs` 和 Task 面板/测试：只增加必要的上游计量捕获、只读 GET 和展示。

SQLite 仍为 **v32**，无迁移；没有真实付费 Provider 请求、GPU 或账单。原有未提交的 README/CHANGELOG/P4.4c 文档均保留。

实际验收：**P4.4d 专项 14 项通过**（正常 JSON/SSE、缺失/非法/截断 usage、跨 Task 隔离、另一路助手推理调用显式未计量、双 SQLite 连接和 HTTP 只读）；相关后端联合回归 **341 项通过**；前端 Vitest **169 个文件、1106 项通过**；`npm run typecheck` 和 `npm run build` 通过。以上测试集有重叠，不能直接相加；构建有已有的 Chunk/静态与动态导入并存非阻断警告。

**历史测试环境限制**：完整 `openai-model-adapter.test.mjs` 中有两项旧 MOSS 脚本测试依赖本地 `skills/moss-image-prompt-enhancer/scripts/compile_prompt.py`，当前工作树没有该文件，测试报告为 `ENOENT`。其余 OpenAI 适配器测试成功；没有为了使测试变绿而伪造该脚本，也未修改上述旧测试。
