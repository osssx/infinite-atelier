# P4 总体实施进度索引

> 更新：2026-11-15 · 分支：`custom` · 范围：当前仓库已有代码/提交与阶段专项验收，不等于任意创作任务端到端都已完成。

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

## 当前优先级

- **继续 P4.6c**：对本地 Comfy 运行中取消建立**作用域明确**的支持检测和真实竞争验收；不使用无目标约束的全局 `/interrupt`，不把队列消失等同于远端确认取消。再验证 Comfy `POST /prompt` 响应丢失且无法获取远端 ID 时的人工查找/冻结证据对账。
- **后续内容质量验收**：使用真实文本 Provider 评估长故事角色和场景的一致性；静态文本验证不作语义正确性承诺。
- **后续通用 Agent 扩展**：在权限、来源冻结和审计验证后再评估跨 Task/Project 检索与复杂工具编排。

## 按用户决策延期

- **金额级费用硬上限**：暂不实现 Provider 价格保证、预留与实际收费结算；现有 Job 次数硬限制和用量来源审计保留。
- **长视频、并发及负载测试**：暂不开展 10 分钟以上视频、GPU 长时间稳定性及高并发压力测试；不会把短视频验收扩大表述为这些场景通过。

## 实施注意

所有新实机验收应使用隔离的 SQLite、CAS、Project、Chrome 用户目录；未经明确授权不向已有用户画布投递新的 GPU 任务。只读查询 Comfy 版本与队列不属于 GPU 生成测试。原仓库的非本轮未提交文件应保持不变。
