# P4.1 创作角色来源检索：第一轮实施记录

> 日期：2026-11-14。以 P4.0 两次提交为基线，继续在 `custom` 分支实施。
>
> 范围：Task 内的角色卡历史来源恢复、显式用户确认、来源冻结及再验证。**不是**通用 Agent Run / Transcript / 全项目跨 Task 创作记忆。

## 已完成

1. 新增 `web/server/backend/assistant-creative-context.mjs`。从当前 Task 的历史 `user_turn`、`model_infer completed` 响应和当前授权选中的文本节点，按需生成角色候选组，不持久化第二份正文。候选带 `sourceRef`、内容 `sourceDigest`、`provenance`（`user_statement` / `model_draft` / `canvas_current`）、角色名与限额摘录。模型草稿不会自动提升为用户确认事实或已执行证据。
2. 权限约束：使用 **当前冻结 Turn** 的 `contextPolicy`，仅重复可被该策略涵盖的历史 Turn；选中节点范围外的画布正文不得出现在候选或模型请求中。只取当前请求之前的用户消息，历史来源变化后返回 `assistant_creative_source_changed`。
3. 新增只读 `GET /api/v1/projects/:id/assistant/tasks/:taskId/creative-context/characters?turnMessageId=...`。候选按来源类型及时间分组显示，不会因读取而自动创建 Step、Job 或长期语义。
4. 扩展 P4.0 的 `POST .../deliverables/text`：每个角色可附 `sourceRef/sourceDigest`；服务器在冻结事务中重新检索来源，禁止伪造角色、混用不完整引用或摘要失效；相关来源与角色名单参与已有 `actionDigest`/Approval/Claim。
5. `app.mjs` 在每轮 Provider POST 前再次核对冻结引用；将确认的具体创作摘录作为**带来源、标记不可信指令的参考资料**加入 Task Context，且遵守 16 KiB 边界。已选来源时不再混入其他无关模型草稿。
6. `canvas-assistant-panel.tsx` 的“每个角色”等泛称角色卡请求会先调只读接口、展示角色名与来源摘录。用户明确确认后才冻结内容规格、调用模型，复用 P4.0 完整审批与提交/验证流程。无候选、超过人数限制或来源不符时直接解释并要求明确角色，而非创建空白节点。

## 已验证

| 测试 | 结果 |
| --- | --- |
| P4.1 SQLite/HTTP 来源检索、来源摘要校验、后端完整交付 | **11 项通过** |
| Agent/Task 兼容回归（含 P4.0、Canvas Step、Task Context、归档、Chat/Vision） | **82 项通过** |
| 前端 Vitest 全量 | **165 文件 / 1069 项通过** |
| TypeScript typecheck | **通过** |
| 生产构建 | **通过** |
| `git diff --check` | **通过** |

以上数字来自不同测试批次，存在重叠，不可相加。全部 P4.1 模型调用均使用 Mock，并未实际使用外部 Provider 或 GPU。

## 特意保留的边界

- 只从**当前关联 Task** 与本轮授权画布节点检索。跨 Task、跨项目的确认角色资料检索及场景/风格/分镜索引仍属后续阶段。
- 角色提取是保守的确定性规则：仅识别结构化角色卡动作或明确枚举的姓名。模糊叙事与超过 5 人的候选不会猜测或静默截断。
- 无法用历史结果证明模型真正了解故事的一切设定；角色一致性的进一步语义校验仍需 P4.3。
- 既有 P4.0 规格 Task 禁止 Skill 混入；P4.2 通用 Agent Tool Registry、多轮自主计划与 P4.4 Job 自动续行未实施。
- 没有真实浏览器交互/真实模型质量验收。若原角色来源在冻结后发生修改，当前 Task 本轮推理会 fail-closed；需要明确修订来源及新 Task/Plan 流程。
- `web/docs/canvas-agent-p4-implementation-status.md` 是上一轮 P4.0 的阶段记录。以本文件为 P4.1 补充记录；不要把两者的设计状态误认为全部 P4 交付完成。
