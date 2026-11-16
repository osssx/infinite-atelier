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

## 当前优先级

- **下一阶段 P4.9b：真实 Provider 内容质量验收**：经明确授权后在隔离 Task 中固定三角色、场景与分镜素材，检验真实模型跨多轮的设定一致性，人工评分不参与 Task 完成授权。费用硬上限、长视频及负载测试仍延期。
- **后续通用 Agent 扩展**：在权限、来源冻结和审计验证后再评估跨 Task/Project 检索与复杂工具编排。

## 按用户决策延期

- **金额级费用硬上限**：暂不实现 Provider 价格保证、预留与实际收费结算；现有 Job 次数硬限制和用量来源审计保留。
- **长视频、并发及负载测试**：暂不开展 10 分钟以上视频、GPU 长时间稳定性及高并发压力测试；不会把短视频验收扩大表述为这些场景通过。

## 实施注意

所有新实机验收应使用隔离的 SQLite、CAS、Project、Chrome 用户目录；未经明确授权不向已有用户画布投递新的 GPU 任务。只读查询 Comfy 版本与队列不属于 GPU 生成测试。原仓库的非本轮未提交文件应保持不变。
