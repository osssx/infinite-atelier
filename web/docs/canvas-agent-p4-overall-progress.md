# P4 总体实施进度索引

> 更新：2026-11-16 · 分支：`custom` · 范围：当前仓库已有代码/提交与阶段专项验收，不等于任意创作任务端到端都已完成。

## 阶段状态

| 阶段 | 已实现及可信证据 | 保留边界 |
| --- | --- | --- |
| P4.0 | [显式角色卡交付](./canvas-agent-p4-implementation-status.md)：Task 规格冻结、审批、Graph 提交、最终验证。提交 `33b6d1e`、`51f3b12` | 旧文档是 11 月 14 日的阶段快照，其中“P4.2–P4.4 未实施、未提交”**不是当前总体状态**；该文件目前未被 Git 跟踪，保留其历史记录而不覆盖。 |
| P4.1 | [角色来源](./canvas-agent-p41-creative-context-implementation.md)、[故事/场景/风格来源](./canvas-agent-p41b-creative-materials-implementation.md)；`127d3e1`、`ca616ad` | 仅关联 Task/会话和明确授权材料；非跨项目通用记忆。 |
| P4.2a–c | [只读工具](./canvas-agent-p42a-read-tool-runtime-implementation.md)、[持久 Run](./canvas-agent-p42b-agent-run-ledger-implementation.md)、[Step 关联](./canvas-agent-p42c-step-coordination-implementation.md)；`c3102f2`、`e7222a2`、`f849208` | 有界读轮次、授权节点、人工审批及可信执行回执，不是无限制的自主工具执行。 |
| P4.3 | [结构化交付和重规划](./canvas-agent-p43-structured-deliverables-implementation.md)；`00b29c7` | 静态完整性阈值不代表故事/人物语义质量已获真实模型验收。 |
| P4.4a–d | [安全续行](./canvas-agent-p44a-safe-continuation-implementation.md)、[终态事件](./canvas-agent-p44b-event-continuation-implementation.md)、[Job 次数预授权](./canvas-agent-p44c-budget-authorization-implementation.md)、[费用计量](./canvas-agent-p44d-cost-metering-implementation.md) | 次数限制不是金额硬上限；未知外部结果不自动重发。 |
| P4.5a–e | [本地静态序列](./canvas-agent-p45a-local-comfy-chain-implementation.md)、[可信媒体绑定](./canvas-agent-p45b-trusted-media-chain-implementation.md)、[真实 MiniMax H3](./canvas-agent-p45c-minimax-h3-live-acceptance.md)、[GPU 媒体授权](./canvas-agent-p45d-local-comfy-media-consent-live-acceptance.md)、[前端恢复](./canvas-agent-p45e-media-ui-recovery-implementation.md) | 仅针对已确认的本地 ComfyUI、冻结模板和有限授权。 |
| P4.5f | [真实 Chrome 验收](./canvas-agent-p45f-real-browser-acceptance.md)，`04fc238c`、`b412151`、`fab4978`：A 17、B 13、C 18，**共 48 项断言通过**；C 实际生成 Moss 图片和 MiniMax H3 视频各一次 | 正常刷新恢复不同于浏览器 HTTP 入队响应丢失后的未知提交。 |
| P4.6a | [本地取消竞争校验](./canvas-agent-p46a-comfy-cancel-reconcile.md)：旧版 Comfy 队列删除后查询历史，避免将已执行或历史不可达误报为确认取消；Comfy/Coordinator **42 项专项回归通过** | 仅缩小取消竞态窗口，仍无真实运行中 GPU 的 scoped cancel 验收。 |
| P4.6b | [真实 Chrome 响应丢失验收](./canvas-agent-p46b-chrome-lost-ack.md)：`enqueue-authorized` 服务端 HTTP 200 后 Chrome 关闭响应，UI 提示不自动重试、刷新可见原 Job；**18 项浏览器断言通过** | 仅覆盖入队 API 的响应丢失；不等于 Comfy `/prompt` 响应丢失后的真实 GPU 人工对账。 |
| P4.6c | [本地真实协议对账](./canvas-agent-p46c-comfy-native-reconcile.md)：修复 Comfy 0.45 五元素历史元组、活跃队列原始证据核验、无远端 ID 时显式有界查找、旧队列删除不再被误报为已确认取消；专项与只读实机协议预检通过 | 已只读核实当前 ComfyUI 0.45 的 scoped cancel 源码实现，但尚无真实运行中 GPU 取消实测；历史扫描不保证完整覆盖所有提交。 |
| P4.6d | [真实 scoped cancel 实机验收](./canvas-agent-p46d-scoped-cancel-live-acceptance.md)：本地 ComfyUI 0.45 使用两个 64×64 短时工作流验证排队/运行中按 ID 取消、彼此隔离、终态幂等及无全局中断；**14/14 实机检查通过** | 轻量 Sleep 工作流，非 MiniMax H3 GPU 核心推理；尚缺应用层 JobCoordinator + Task UI 的真实远端组合验收。 |
| P4.6e | [真实 Chrome → JobCoordinator → Comfy scoped cancel 闭环](./canvas-agent-p46e-real-browser-scoped-cancel.md)：新增项目级安全取消入口及任务历史停止按钮；Chrome 真实按钮、远端待执行任务定向取消、SQLite 终态与刷新恢复 **22/22 项检查通过** | 浏览器闭环验收的是远端**等待中**任务；运行中 scoped cancel 由 P4.6d 直接实机验证；非大型模型 GPU 内核中断或长视频负载测试。 |
| P4.9a | [角色/故事/场景/分镜文本完整性](./canvas-agent-p49a-creative-text-completeness.md)：对明确生成具体创作文本节点的请求拒绝空白/占位符，最多纠错一次；修复补救模型请求遗失已授权 Task 上下文的问题；Mock Provider + 实际 SQLite/HTTP 验收及前端错误提示 | 静态正文完整性而非真实 Provider 的语义一致性验收；不自动生成用户未授权设定或跳过 Canvas 审批。 |
| P4.9b | [多轮创作质量隔离验收](./canvas-agent-p49b-creative-quality-acceptance.md)：固定角色、场景、分镜和雨天修订，在真实 Task/SQLite/Fastify 下完成四轮 Mock 模型调用审计、上下文授权与跨会话草案连续性；输出自动疑点和人工复核报告 | 默认本地后端未启动，**仅 Mock Provider 通过**，真实模型语义评价和人工审核仍待执行。 |
| P4.9c | [已配置在线渠道真实模型与人工复核](./canvas-agent-p49c-real-provider-acceptance.md)：只读读取现有 Cline 文本模型/DPAPI 渠道，真实模型首轮 3 张角色卡成功、审计成功；第二轮结果未知，按栅栏停止；人工复核摘要及在线渠道安全选择测试 | **实际调用 2 次**，第一轮成功，不代表场景和分镜完成；第二轮 `needs_reconcile`，未自动重发，真实四轮语义验收仍未完成。 |
| P4.9d | [模型未知回执的安全诊断](./canvas-agent-p49d-provider-call-diagnostics.md)：新增模型调用失败白名单分类，按响应前/后、HTTP 状态、DNS/传输异常或正文解析失败记录安全摘要；持久写入已有 Task 事件并通过项目级调用审计查询提供；专项 Fastify/SQLite 回归 | 原 `needs_reconcile` 与一次性模型提交栅栏保持不变；新诊断无法倒推 P4.9c 已丢失的原始 HTTP 错误，也不代表上游没有收费或生成。 |
| P4.9e | [持久化、多轮、分阶段验收](./canvas-agent-p49e-durable-creative-acceptance.md)：独立 Temp SQLite 保留 Task/模型调用审计，四阶段独立提交与摘要审批；模拟 3/3/6/6 草案、缓存恢复、未知回执防重发和人工审核导出均通过，现有 Cline 渠道只读预检及零计费 Task 初始化成功 | **本阶段真实在线 Provider 新调用 0 次**；场景/分镜跨轮语义的真实模型结果仍待逐阶段单独费用授权和人工复核。 |
| P4.9f·角色卡 | [真实在线第一阶段验收](./canvas-agent-p49f-real-characters-acceptance.md)：经明确授权，用已选 Cline 文本模型新隔离 Task 执行第一阶段；**1 次真实 Provider POST，3 张角色卡全部有正文且客观内容检查通过**，原始模型调用审计 succeeded，Graph/Job 不变 | 角色卡仍为 `review_pending`，未批准或发起场景生成；新增外观细节为未确认 AI 草案，后续跨轮语义仍待验收。 |

## 当前优先级

- **下一步 P4.9f·场景设定**：当前 3 张真实角色卡仍为 `review_pending`。仅在明确批准把角色卡草案作为**未确认上下文**，并单独授权最多 2 次潜在计费模型请求后，才执行 `scenes` 阶段；之后的分镜及修订同样单独审批/授权。金额级费用硬上限、长视频和负载测试继续延期。
- **后续通用 Agent 扩展**：在权限、来源冻结和审计验证后再评估跨 Task/Project 检索与复杂工具编排。

## 按用户决策延期

- **金额级费用硬上限**：暂不实现 Provider 价格保证、预留与实际收费结算；现有 Job 次数硬限制和用量来源审计保留。
- **长视频、并发及负载测试**：暂不开展 10 分钟以上视频、GPU 长时间稳定性及高并发压力测试；不会把短视频验收扩大表述为这些场景通过。

## 实施注意

所有新实机验收应使用隔离的 SQLite、CAS、Project、Chrome 用户目录；未经明确授权不向已有用户画布投递新的 GPU 任务。只读查询 Comfy 版本与队列不属于 GPU 生成测试。原仓库的非本轮未提交文件应保持不变。
