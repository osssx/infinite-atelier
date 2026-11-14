# P4.1b：故事 / 场景 / 美术风格来源检索与关联会话复用

> 状态：本阶段代码实施完成，自动化专项与相关 Task 回归已通过；仍需真实浏览器和真实 Provider 质量验收。
> 实施基线：`73ef6bf`（已绑定模型调用与来源 Turn）。
> 前序阶段：[P4.0 实施记录](./canvas-agent-p4-implementation-status.md)、[P4.1 角色上下文](./canvas-agent-p41-creative-context-implementation.md)。

## 本轮范围

- **同一 Task、关联 Chat**：复用既有 `assistant_task_chat_links`。用户显式将其他 Chat 关联到同一个 Task 时，后续该 Task 的当前 Turn 可以重新检索其先前可披露资料；**不允许自动扫描其他 Task、其他 Project 或未关联会话**。
- **来源类型**：`story`（故事/剧情/世界观）、`scene`（场景/环境/地点）、`style`（美术风格/画风/视觉规范）。P4.1b 仅识别带明确标签的历史用户陈述、已完成且真实绑定来源 Turn 的模型草稿、以及本轮授权选中的文本节点。不会猜测模糊自由叙述或凭模型回复伪造已完成事实。
- **按需检索**：新增 `assistant-creative-materials.mjs`，实时按 Task/Turn/来源权限读取 SQLite 和当前 Project Document，返回带 `kind`、`sourceRef`、`sourceDigest`、`provenance`、短摘录的候选。无新 Schema、无向量索引、无第二份可写创作正文。
- **用户确认后冻结**：只读查询 `GET /api/v1/projects/:id/assistant/tasks/:taskId/creative-context/materials?turnMessageId=...`；确认提交 `POST /api/v1/projects/:id/assistant/tasks/:taskId/creative-context/materials/select`。服务器用当前 Task 的**最新冻结 Turn** 重新解析引用和摘要；在 SQLite 原子事务中写 `creative_sources_selected` 事件和幂等命令回执。一个 Turn 只允许一组确认、最多四条资料，不允许模型调用开始后补批。
- **Provider 外发守卫**：`app.mjs` 在登记模型命令之前，以及**每次真正的 Provider POST 前**重新读取并核对来源；若摘要失效、Turn 已过期、Task 为只读归档则 fail-closed。已选资料使用约 3.5 KiB 的 UTF-8 预算、含来源和未确认草稿标识，资料中的操作命令不具授权效力；不自动混入其他历史模型草稿/历史用户预览，画布内容也收敛到本轮已选的来源节点。
- **前端触发条件**：关联 Task 的用户指令同时涉及故事/场景/风格与「之前、根据、参考、沿用、继续、保持、一致」等意图时，先展示来源和摘录，获得用户明确确认后再启动本轮模型调用。若有超过四条或无足够授权来源，提示用户缩小选择/指定资料，不悄悄截断。角色卡生成仍由 P4.0/P4.1 的独立规格冻结与审批/验证流程管理。

## 修改文件

| 文件 | 内容 |
| --- | --- |
| `web/server/backend/assistant-creative-materials.mjs` | 新增来源发现、授权验证、确定性引用/摘要、选择事务和上下文预算 |
| `web/server/backend/assistant-creative-materials.test.mjs` | 新增 SQLite、HTTP、跨关联 Chat、失效/并发、Mock Provider 安全回归 |
| `web/server/backend/assistant-task-routes.mjs` | 两个 Creative Materials API |
| `web/server/backend/app.mjs` | 模型请求来源校验、收敛 Task 上下文与最终 Provider payload |
| `web/src/features/canvas-assistant/canvas-assistant-panel.tsx` | 来源检索、候选显示、用户确认、再执行 |
| `web/src/features/canvas-assistant/canvas-assistant-creative-materials.ts` | 可测试的资料引用意图解析、候选缩小与提示文案 |
| `web/src/features/canvas-assistant/canvas-assistant-creative-materials.test.ts` | 前端单元测试：触发规则、按标题过滤、拒绝静默截断、未确认来源提醒 |
| 本文件 | 实施约束、测试、已知限制 |

## 验收与限制

- P4.1b 独立专项：**14 项通过**（含完全 Mock 的模型请求检查）。
- P4.0/P4.1/P4.1b 及 Task/Canvas 相关回归：**76 项通过**（各测试组存在重叠，不可简单求和）。
- 前端 `npm test`：**167 个文件、1078 项通过**（包含本轮前端选择逻辑单测）。
- `npm run typecheck`：通过。
- 生产构建：通过。旧端到端 Skill fixture 缺失的问题仍需在独立后端全量回归中复核；本轮未用虚构文件绕过。

**已知限制：**

1. 历史用户消息事件仅包含约 160 字的 `preview`；超过此长度的完整故事需要既存授权文本节点或历史已完成模型输出提供。此轮不突破现有隐私/存储契约来记录未授权全文。
2. 检索优先安全性：只提取明确标签的创作内容；故事内容相似性和跨类型语义冲突尚未实现自动裁决。
3. 本轮只提供**单轮明确确认**，每 Turn 最多 4 条来源；不等于用户永久确认风格，也不等于对任意 Tool/Skill 赋权。更复杂的交互式多来源挑选和通用 Agent Tool Registry 属 P4.2。
4. 不支持自动从其他 Task / 未关联 Chat 合并创作记忆，也不提供跨用户授权代理。跨会话复用限于已显式关联同一个 Task 的上下文。
5. 不调用真实 GPU / 真实 Provider；实际文本质量、浏览器 UI 手动流程需另行验收。
