# P4.9f：真实在线六分镜、雨天修订及完整四阶段验收

> 2026-11-16，基线 `04b13bf`。用户明确说明**本次对话内在线文本模型调用无需再逐阶段授权**。此授权仅适用于当前对话里的文本模型测试；独立隔离 Task 的单阶段最多 2 次上游 POST、未知回执不自动重发、无真实 Canvas 提交和任务完成验证器的约束保持不变。本阶段实际新调用 **2 次在线文本模型**，未额外调用格式纠错或重试。

## 执行环境与隔离边界

- 当前 Cline OpenAI-compatible 文本模型：`cline-pass/deepseek-v4.1-flash-1017`。利用既有 Windows DPAPI Vault，只读匹配冻结的模型、渠道 ID 和加密凭据版本，不输出凭据。
- 继续复用 P4.9e 的独立 Temp `RUN_DIR/acceptance.sqlite`，执行前角色卡 `approved_for_continuation`、三个场景 `auto_approved_for_continuation`；`storyboard` 和 `revision` 尚无保留记录。所有模型调用使用不重复的 Task `requestId`。
- 两次分别执行 `node scripts/p49e-configured-channel.mjs --stage storyboard --dir RUN_DIR --ack-cost` 和 `--stage revision`。每次最多两次潜在计费文本模型 POST，本次实测分别只发生 **1 次**。
- 输出只落盘于该隔离 Task。项目测试 Graph `revision=1` 保持不变，`jobs=0`，正式项目数据库未被这两轮测试写入；未发起图片、视频或 ComfyUI 生成。
- 此前 P4.9c 遗留的 `needs_reconcile` 场景请求属于另一个测试实例，本次**没有重放**。

## 四轮真实在线模型审计

| 阶段 | 草案数量 | 本隔离 Task 在线 POST | 结果 | 执行耗时 |
| --- | ---: | ---: | --- | ---: |
| `characters` | 3 | 1 | `succeeded` / 已允许续行 | 5201 ms |
| `scenes` | 3 | 1 | `succeeded` / 自动续行批准 | 5634 ms |
| `storyboard` | 6 | 1 | `succeeded` / 自动续行批准 | 17463 ms |
| `revision` | 6 | 1 | `succeeded` / 自动续行批准 | 11751 ms |
| **总计** | **18** | **4** | **4/4 已收到成功回执** | — |

四轮共 18 份正文，均有内容且不属于截断文本；原始持久 `assistant_model_calls` 共 4 条，全部 `succeeded`。独立 `summary.json`、原有 Task 原始成功响应与模型调用日志均保留，未重复提交同一个已完成阶段。

## 标题误报修复（没有任何新模型请求）

模型对首次六分镜使用标题 `分镜1·...`，但校验曾要求 `镜头1`；对修订六分镜使用 `分镜1（修订）·...`，校验曾要求 `修订镜头1`。两次模型实际均成功返回且内容符合阶段规格，**仅标题等价识别不足，导致每阶段出现 6 个 `expected_title_missing` 误报并保持 `review_pending`**。

- `assistant-creative-consistency.mjs` 接受分镜用 `镜头N` 或 `分镜N`，修订用 `修订镜头N`、`修订分镜N` 或 `分镜N（修订）`。编号从标题开头精确识别，**不会把 1 与 10、重复标题或未声明修订的普通镜头当作等价**；人物和场景标题的校验保持原状。
- `scripts/p49e-creative-stage.mjs` 新增 `--recheck storyboard|revision --dir RUN_DIR`：仅对 **review_pending 且此前全部标记都属于标题缺失**的历史成功响应进行重新评分；必须验证原始任务缓存为 `completed`、响应 JSON 与已持久 SHA-256 digest 完全相符、原内容摘要相同、原有模型调用审计全部成功。任何非标题问题、内容更改、未知提交或非待评审状态均拒绝。
- 对这两轮分别进行了缓存重检，均消除 6 个标题误报，更新为 `auto_approved_for_continuation`；**重检各发生 0 次 Provider POST**。没有改变模型生成正文、用户确认事实、原 Graph 或 Task 完成状态。

## 初步内容一致性复核

固定事实：嘟嘟雪白毛色、蓝色斗篷；兔妈妈米白毛色、棕色围裙；小龟慢慢橄榄绿龟壳且是主角可靠朋友。固定场景与事件顺序为：晨光森林找到遗失星星 → 暴雨石桥帮助迷路动物 → 雨后观星草地团聚。

- 六分镜：按编号依次展示森林发现星屑、拾取遗失星星、暴雨赶往石桥、桥上营救、雨后到达草地、星空下团聚。每镜都交代景别、摄影机运动、动作、地点及出场角色。
- 雨天修订：前三镜保留森林和暴雨转场；第 4 镜桥上发现/安慰小动物，第 5 镜强调三人配合穿越湿滑石桥，第 6 镜雨后草地团聚。角色基本服装、关系和地点顺序未见直接矛盾。
- **需要进一步修订的剧情动作**：原六分镜结尾明确描述“嘟嘟把星星放回天空”，修订版本最后一镜只写“举高星星、温暖照亮大家”，**没有明确完成放回天空这一动作**。这不是用户直接确认的人物外貌事实，但属于前轮重要叙事收束动作，在雨天修订时可能被遗漏。建议后续补回，并由编辑复核；不能据此宣称“修订完整保留全部剧情细节”。
- 雨天修订将原来的两镜草地结尾压缩成最后一镜，把第 5 镜分配给石桥协作，这是强化雨天叙事的有意改动；需要在实际成片节奏设计时确认是否仍应给草地结尾保留两个独立镜头。

**结论边界：**全部四阶段的在线调用、内容数量、既定人物与场景关键词检查已经通过；但单靠自动审查不能证明全文语义质量通过。特别是上面发现的结尾动作遗漏，须保留为编辑修订项。

## 正式审核产物与安全状态

- `node scripts/p49e-creative-stage.mjs --export --dir RUN_DIR` 已导出 `p49e-human-review-source.json`，共 4 个真实 Provider 阶段。此操作只读取隔离 SQLite，不提交模型请求。
- `node scripts/p49c-human-review.mjs --init RUN_DIR/p49e-human-review-source.json` 已生成 `p49e-human-review-source.review.json`。
- `--verify` 结果：`qualityStatus=draft`、`sourceMode=live`、7 个审核维度 × 4 个阶段均为 `pending`；`taskCompletionAuthorized=false`、`modelQualityProvenByAutomation=false`。此处的编辑初读不冒充用户/独立审核人员已完成质量签署。
- 所有原始模型正文和单次调用缓存仅存放在本地 Temp 隔离实例，不纳入 Git；本阶段文档只记录摘要、模型名称、结果和需改进的叙事动作。正式项目用户素材/画布保持不变。

## 下一阶段建议

进入 **P4.9g：剧情关键动作在分镜修订中保持**。优先设计轻量、可解释的“已确认事实 + 前轮关键剧情动作”两层约束和非强制编辑预警，避免只看标题、角色服饰而忽略结局动作遗失；然后在一个**新的独立验收任务**中对修订质量开展受控验证。已经成功的四轮请求不得重放。金额级费用硬上限、长视频和负载测试仍延期。
