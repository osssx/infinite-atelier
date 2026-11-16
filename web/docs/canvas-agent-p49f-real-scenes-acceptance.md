# P4.9f：真实在线场景阶段与后续测试自动续行批准

> 日期：2026-11-16，基线 `60a5e16`。用户已明确批准前轮 3 张角色卡**仅作为未确认草案上下文**，并授权本次 `scenes` 阶段**最多 2 次潜在计费的在线文本模型请求**；另外要求后续测试自动批准。本阶段实际在线请求 **1 次**，未使用第二次额度；未发起分镜或修订请求。

## 1. 实机执行记录

- 使用前次 P4.9e 已冻结的独立 Temp SQLite 验收实例，当前在线模型为 Cline `cline-pass/deepseek-v4.1-flash-1017`。执行前只读核实 `characters / review_pending`、场景阶段尚未提交、选中渠道加密凭据可用。
- 使用用户明确批准的角色卡 digest `90664190b62614bed23f3838620d3ae7870541854d87e9f19644d4f42df95d46`，将 `characters` 标记为 `approved_for_continuation`；该状态**不会**修改任务确认事实、正式 Canvas 或 Task 终态。
- 仅执行 `node scripts/p49e-configured-channel.mjs --stage scenes --dir RUN_DIR --ack-cost` 一次。
- 实机回执：`stageId=scenes`、`modelPosts=1`、`review_pending`、`diagnostic=null`、`graphUnchanged=true`。实际 SQLite 原始 Model Call：`initial / succeeded`，约 **5634 毫秒**。该隔离 Task 当前累计 2 次真实模型调用（角色卡一次，场景一次），**没有多余纠错 POST**。
- 场景动作内容 digest：`bdd6a387bf844c5063b4beb7b7f425f67750af8796365a360d9455fed18a3c06`。
- `jobs=0`；正式项目数据集保持只读，测试隔离 Graph 没有变化；未向现有画布写入任何场景节点。

### 三份场景草案

| 场景 | 正文长度 | 核查要点 |
| --- | ---: | --- |
| 晨光森林小径 | 366 字符 | 清晨光照、森林小径与星星线索；小兔雪白毛色/蓝色斗篷，妈妈米白/棕色围裙，小龟橄榄绿龟壳 |
| 暴雨石桥 | 413 字符 | 午后暴雨、左端连接森林、桥右端过溪；小兔保护迷路动物，小龟观察湿滑路面，妈妈保护队伍 |
| 观星草地 | 394 字符 | 雨后夜晚、草地团聚；同一批人物和获救动物抵达，星星情节收束 |

- 自动客观检查：`expectedCount=3`、`actualCount=3`、`objectiveChecksPassed=true`、`flags=[]`、三卡 `truncated=false`。
- 人工初读：没有发现固定的毛色、服饰和角色关系被更改；森林→石桥→草地的时间与地点顺序得到保持。
- **待分镜阶段确认的叙事细节**：森林场景描述了星光线索和星屑，草地则写明星星在森林找到；「发现线索」与「拾取星星」的具体动作时点应在后续分镜里统一。这不是自动规则可证明的一致性结论。
- 生成文本里的配饰、人物站位和辅助视觉元素仍然只是 AI 草案细节，不自动替代用户已确认的主设定。

## 2. 后续测试的自动批准（本次用户要求）

实现于 `web/scripts/p49e-creative-stage.mjs`，**仅作用于指定的独立验收 Task**。

```powershell
cd web
node scripts/p49e-creative-stage.mjs --auto-approve --dir RUN_DIR
node scripts/p49e-creative-stage.mjs --status --dir RUN_DIR
```

已对本次隔离 Task 执行上述开关，`autoApproveDrafts=true`：原角色卡保持用户批准的 `approved_for_continuation`，本次场景在通过客观检查后变为 `auto_approved_for_continuation`。该设置保存在**隔离 SQLite**，后续重开进程仍有效。

从此实例的下一轮开始，只有当以下条件均满足时才自动赋予继续使用草案的权限：

1. 模型返回符合阶段规范的节点数量、正文完整且未截断，客观问题标记为空。
2. 该阶段所有持久模型调用均为 `succeeded`，前置阶段已被允许续行。
3. 测试画布未被修改，媒体 Job 数量为 0。
4. 调用结果摘要有效，阶段仍处于 `review_pending`。

若存在未知回执、调用失败、空正文、设定漂移标记或不完整结果，**不会自动批准**；崩溃恢复仅使用成功缓存重建草案，不发送新模型请求，仍使用同一安全门槛。自动续行批准使用独立状态 `auto_approved_for_continuation`，明确区别于人工批准。

**边界：自动批准不代表人工内容质量通过，不会修改 user_confirmed Task 事实，不会授权 Canvas Graph 操作或 Task 完成，也不会自动支付下一阶段费用。** 后续真实 `storyboard` 与 `revision` 仍必须分别使用新的明确费用授权和 `--ack-cost` 才能发起至多两次模型请求/阶段。

## 3. 验收与剩余工作

- `assistant-creative-autoapproval.test.mjs`：验证打开开关时已有合格场景与之后阶段自动允许继续，坏文本、设定疑点、未知回执仍被拦截，崩溃后的成功缓存可安全恢复自动批准，不会增加 Provider POST。
- `assistant-creative-stage-e2e.test.mjs`：保持原有的手动批准和兼容场景不变。
- 本次仅完成角色卡+场景 **2/4** 个真实在线阶段；六个分镜与雨天修订尚未开始，跨镜头的故事连续性仍待验证。金额级费用硬上限、长视频和负载测试继续延期。
