# P4.9f：真实在线角色卡第一阶段验收

> 日期：2026-11-16。基线提交：`b26166d`。本次用户明确授权：**仅第一阶段 characters，最多 2 次潜在计费的在线文本模型请求**。本次实测仅发出 **1 次**。未经新授权不执行场景、分镜或修订阶段。

## 环境及隔离证据

- 实际复用当前已选中的 Cline OpenAI-compatible 文本渠道：`cline-pass/deepseek-v4.1-flash-1017`；从正式 SQLite **只读核对**已加密凭据存在。
- 使用 P4.9e 新建、冻结渠道和凭据版本的独立 Temp SQLite Task。请求前 `--status` 确认 `stages=[]`，无此前提交记录。**未重放 P4.9c 那次结果未知的场景请求**。
- 唯一授权执行：`node scripts/p49e-configured-channel.mjs --stage characters --dir RUN_DIR --ack-cost`。
- 执行响应：`phase=stage_result`、`stageId=characters`、`status=review_pending`、`modelPosts=1`、`diagnostic=null`、`graphUnchanged=true`、`semanticVerdict=human_review_required`。
- 返回动作摘要（SHA-256）：`90664190b62614bed23f3838620d3ae7870541854d87e9f19644d4f42df95d46`。
- 直接只读检查该独立 SQLite：`assistant_model_calls` **恰好 1 条**，`call_kind=initial`、`status=succeeded`，耗时约 **5201 ms**；`p49e_stages` 仅 1 行 `characters / review_pending`；`jobs=0`，Graph revision 未变化。

## 三张真实创作文本

| 卡片 | 正文长度 | 固定事实核查 |
|---|---:|---|
| 角色卡·小兔嘟嘟 | 331 字符 | 雪白毛色、蓝色斗篷、乐观好奇、兔妈妈的孩子、小龟的冒险伙伴 |
| 角色卡·兔妈妈 | 336 字符 | 米白毛色、棕色围裙、温柔耐心、鼓励主角 |
| 角色卡·小龟慢慢 | 355 字符 | 橄榄绿色龟壳、沉稳细致、嘟嘟的朋友而非反派 |

- 自动审阅：`actualCount=3`、`expectedCount=3`、`objectiveChecksPassed=true`、`flags=[]`，三份 `truncated=false`。
- 人工初读：未发现固定角色外貌、服饰或关系的直接矛盾；正文同时给出动作习惯、外观细节和可用于绘图的描述。
- **非用户确认的新创作细节**：小兔斗篷滚边与胸前绳结、兔妈妈围裙口袋内容、小龟脖颈小挂饰等，后续使用应按未确认 AI 草案处理，不能改写 P4.9e 已冻结的用户事实。
- **验收范围**：仅验证真实模型的第一阶段角色卡；未验证场景顺序、六分镜镜头语言、后续剧情事件或雨天修订的跨轮语义稳定性。自动客观检查通过不意味着全部语义已获批准。

## 终态与费用边界

- `characters` **保持 `review_pending`，未执行 `--approve`，未授权继续场景阶段**。
- 此轮只有 1 次可能计费的在线文本推理；第 2 次授权额度**没有被使用**。请求次数不是实际扣费金额，金额级硬上限仍延期。
- 从 `summary.json` 或只读 SQLite 可以复核结果；不要把生成的全文、用户本机路径、凭据或模型请求头提交版本库。
- 任何下一阶段实际执行前，应先明确批准使用这 3 张卡片作为**未确认创意草案**的历史上下文，并独立确认下一阶段可能发生的付费模型调用；旧回执不明任务始终不能重放。
