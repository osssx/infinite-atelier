# P4.9h：通用剧情事件 IR 与正式 Assistant 只读提示接入

> 2026-11-16，基线提交：`b2faf2d`。本轮的重点是**可声明的剧情事件结构**和**用户当前权限下的只读提示**，不是自动制作完整故事语义图或代替人工验收。**新增在线模型调用 0 次**；没有回放此前成功或未知回执的 Provider 请求，也没有写入正式画布。

## 1. 事件 IR v1

实现：`web/server/backend/assistant-story-event-ir.mjs`。

一个事件声明包含：

| 维度 | 字段与示例 | 安全语义 |
| --- | --- | --- |
| 事件身份 | `id=star_returns_to_sky`、可读标签 | 编码在受控目录中，不使用模型任意生成的事件标识 |
| 执行者 | `actor.entityId=rabbit_dudu`、角色 | `verification=catalog_expectation`，并非模型证明该演员真正完成了动作 |
| 对象/道具 | `target.entityId=lost_star`、`kind=prop` | 事件定义的预期实体 |
| 动作 | `action=return` | 受控动作类型 |
| 状态变化 | `location: carried → night_sky` | `verification=expected_not_directly_proven`，**不是已确认状态机结果** |
| 时序关系 | `after=[star_found_in_forest,lost_animal_rescued_at_bridge]` | 候选事件相对顺序，可提示镜头顺序倒置 |
| 来源证据 | `source.shotIndex`、正文 SHA-256、短动作证据摘要 | 只能来自前一版文本动作段落，不能把标题、备注或伪造字段当作事件成功证据 |
| 权限和结论 | `userConfirmed=false`、`semanticReview=pending` | 永远不借事件 IR 完成 Task、修改用户确认事实或授权画布操作 |

本轮初始目录定义三种事件：森林发现星星、石桥营救迷路动物、星星回归夜空，并验证可以替换为独立的“将钥匙交给朋友”等故事事件，而无需重新编写比较器。

**目录为纯数据声明，匹配模式是有限的中文字面词组序列，不接受模型输入的可执行正则、函数或脚本**；进行 ID、字段、引用存在性、环状时序依赖及规模校验，初始化后深冻结。检测器只在文本节点的 `动作：` 段落提取候选，排除常见的禁止、未完成、假设和计划语境，并支持同一动作段中较晚出现的有效词组。

### 比较结果

`extractStoryEventIR(actions)` 输出版本化来源证据；`compareStoryEventIR(source,revision)` 区分：

- `prior_story_action_not_observed`：原版候选事件在修订动作中未观察到。
- `prior_story_event_order_changed`：原版先后关系在修订镜头中倒置。
- `candidate_observed_in_revision`：在修订中观察到了候选词组，**并不等于语义质量通过**。
- `no_source_candidate`：原版没有可靠候选，不凭空创建不可变剧情义务。

任何结果均为**编辑预警**；名称、转移状态和依赖代表目录预期，未验证真实世界状态。旧 P4.9g 的 `extractP49GActionEvidence`、`buildP49GRevisionGuidance`、`reviewP49GRevisionContinuity` 仍可用，新版内部改为事件 IR，并保留旧审核字段；旧报告不修改也不要求数据库迁移。

## 2. 正式 Assistant 的最小只读接入

实现：`web/server/backend/assistant-story-event-context.mjs`，接入 `web/server/backend/app.mjs` 的 Task Provider 上下文装配。

只在以下全部条件满足时附加受控 IR 提示：

1. **当前服务器验证的用户回合**明确是修订分镜/镜头，而不是普通聊天。
2. 当前 Task、原历史模型命令、源用户回合均属于同一 Task。历史命令必须是 `completed`，所有持久模型调用均 `succeeded`，且命令和回合有可信绑定。
3. **当前冻结的上下文权限仍允许引用该历史回合**。若本轮缩小画布范围，则不恢复先前选中的私有节点信息。显式固定的创作素材、结构化交付物、Skill/视觉/代理读取流程不会附加无关模型草案。
4. 源动作来自至少 2 个实际分镜文本节点，且在受控事件目录中至少匹配到事件。优先使用最近有权限的分镜版本；**新版无候选时不会重新启用旧版事件**。
5. 提示内容只包含代码目录中的事件标签、角色与道具 ID、预期状态、时序依赖、镜头位置和有限哈希摘要，**不把模型生成的标题、自由文本、命令或隐藏画布内容转发成指令**。
6. Provider 上下文保持 16 KB 上限；空间不足时省略可选提示，不因提示触发其他付费请求、额外工具或 Graph 写入。

原 `assistant-task-context.mjs` 的语义权限、已确认事项、选中节点范围和模型幂等机制保持不变。P4.9g 的隔离 Task 在新 IR 支撑下继续支持**缺失动作预警阻止自动续行**，以及崩溃恢复、缓存重检和摘要核验。

**本阶段正式产品入口只提供“修订前提示”，暂未把自动事件预警接入生产 Canvas 事务验证器，不能将该能力称为生产级语义完成栅栏。**

## 3. 历史真实在线模型结果：只读核对

使用之前已完成的 P4.9f 隔离 Cline Task，对其原始 `storyboard` 和 `revision` 模型响应进行**本地 SQLite 只读**检查，结果：

| 事件 ID | 原分镜 | 雨天修订 |
| --- | --- | --- |
| `star_found_in_forest` | 第 1 镜观察到 | 第 1 镜观察到 |
| `star_returns_to_sky` | 第 6 镜观察到 | 未观察到 |

最终为 `requires_editor_review`，包含 `prior_story_action_not_observed` 预警；`taskCompletionAuthorized=false`。原隔离 Task 的 **4 条**模型调用审计仍保持成功状态，未重新发送任何旧请求。

## 4. 验收

- Event IR 定义验证：无效事件 ID、重复 ID、缺失前置事件、环依赖、危险匹配词组、嵌套目录意外改动均拒绝。
- 事件提取与比较：真实动作、同义词、时序倒置、缺失事件、未发生/假设语境、标题/备注伪造、无源候选以及不同道具的定制目录。
- 正式 Fastify + SQLite + 模拟模型 HTTP：旧历史分镜的授权回合可生成只读提示；本轮非修订请求、缩窄权限、不同 Task、角色卡来源、较新版本覆盖、私有画布正文泄露均被阻断或排除。
- 旧 P4.9g 的隔离 Task 兼容：源响应摘要核验、模型未知回执、缺失动作阻止自动续行、缓存重检与崩溃恢复。
- `node --test ...`、`npm run typecheck`、`npm run build`、`git diff --check` 需全部通过后提交。本轮不做实际付费模型请求，避免重测已完成的历史阶段。

## 5. 后续建议 P4.9i

在明确版本、证据范围及编辑权限后，为**通用剧情事件 IR**增加专门的事件审核/确认通道，将“事件目录匹配、前轮草案候选、人工审批结果”分开保存，并在用户请求实际应用修订到画布之前核实来源与差异。第一阶段仍以只读审核呈现为主，生产 Canvas/Task 完成不能因为模型给出了相同关键词就自动放行。金额级费用硬上限、长视频和负载测试继续延期。
