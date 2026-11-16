# P4.9e：持久化、多轮、分阶段的文本创作隔离验收

> 日期：2026-11-16，基线 `b7ddfed`。**P4.9e 的四轮模拟验收已通过，真实 Cline 文本渠道已零计费预检和初始化；本轮未发送任何新的在线文本模型 POST，不能宣称场景、分镜或修订的真实模型语义质量已通过。**

## 改造动机与边界

P4.9c 真实在线文本模型第一轮三张角色卡成功，第二轮场景生成的回执为 `needs_reconcile`。P4.9d 加上了失败链路分类，但 P4.9b 原验收器一直使用 `:memory:` SQLite，因此进程终止后只能读取输出 JSON，无法继续核对原 Task 提交栅栏、已成功返回的缓存结果和 Model Call 事件。对已发生的 P4.9c 第二次请求**绝不重放，也不猜测它是否收费或执行完成**。

本轮新增 `web/scripts/p49e-creative-stage.mjs`，继续使用既有 `buildApp`、`createAssistantTask`、`createAssistantChatService`、`listAssistantModelCalls`、`recoverAssistantModelCallsAtStartup` 和 `reviewP49BCreativeActions`，但改为**操作系统 Temp 下单独的 `acceptance.sqlite`**。原正式项目数据库只允许通过独立脚本读取在线渠道元数据/DPAPI 凭据；不会被 Task/Graph/Job 的测试写入触碰。

- `init` 只创建新 Task、固定故事目标与三条用户确认约束，**0 次模型 POST**。
- 各阶段 `characters`（3）、`scenes`（3）、`storyboard`（6）、`revision`（6）必须分别调用，每阶段仅允许 **1 次模型请求，必要时最多 1 次格式纠错**；无网络自动重试。
- **提交前先在隔离 SQLite 保留阶段记录和请求 ID**。一旦同一阶段已被保留，无论状态是 `review_pending`、`rejected`、`needs_reconcile` 或崩溃后的 `submitted`，再次执行都会被拒绝。
- 前三阶段必须凭返回的 SHA-256 digest 显式 `approve` 才能继续下一阶段。这个批准**仅表示允许把上轮模型草案作为未确认创意上下文使用**，不是把模型草案变为用户确认的事实，更不是 Canvas Graph/Task 完成授权。
- 第三轮重新关联 Chat Session，覆盖跨会话 Task 上下文与历史模型草案的连续性。所有阶段始终使用固定的用户确认人物、关系、场景顺序；私有测试节点正文不进入模型请求。
- `--status` 为只读 SQLite 查询，不写 SQLite 或修改报告。写操作需独占 `.single-writer.lock`；进程异常退出遗留锁时，必须先查明没有仍在执行的同一测试进程，再人工处理锁，不自动解锁或重发。
- `--recover` 仅对隔离 SQLite 做本地对账，不发送任何 Provider 请求：成功且已经缓存的 Task 响应可恢复审阅草案；已标记提交但回执未知的调用保持 `needs_reconcile`；没有安全证据的提交前保留状态标记为 `held_for_manual_inspection`。恢复并不自动进入下一阶段。
- 在线模型渠道、模型 ID、Base URL、渠道 ID和**加密凭据版本**在初始化时以哈希冻结。密钥版本在阶段之间发生轮换将拒绝继续，不导出 Key、不会迁移原用户 SQLite。
- 隔离画布修订始终为 1，只有测试专用私有节点；Jobs 必须为 0。全部新文件位于系统 Temp，不涉及正式画布、ComfyUI、视频或用户已有的素材库。

## 运行方式

### 离线模拟（不收费）

```powershell
cd web
node scripts/p49e-creative-stage.mjs --init --mock
# 记下输出 directory，设为 RUN_DIR
node scripts/p49e-creative-stage.mjs --stage characters --dir RUN_DIR --mock
node scripts/p49e-creative-stage.mjs --status --dir RUN_DIR
# 打开 RUN_DIR/summary.json 人工查看文本；从 --stage 返回中取 digest
node scripts/p49e-creative-stage.mjs --approve characters --dir RUN_DIR --digest <64位摘要>
node scripts/p49e-creative-stage.mjs --stage scenes --dir RUN_DIR --mock
# 后续分别审批 scenes、storyboard，执行 storyboard、revision
node scripts/p49e-creative-stage.mjs --export --dir RUN_DIR
node scripts/p49c-human-review.mjs --init RUN_DIR/p49e-human-review-source.json
```

`--export` 仅在四轮返回完整、前面三轮的草案已经明确允许继续、无异常 Model Call 且 Graph/Job 不变时才能创建**只写一次**的 `p49e-human-review-source.json`。该文件与既有 P4.9c 七维人工审核工具兼容；即使全部 Mock 输出都被人工评为合格，质量结论仍然是 `mock_review_only`，且 `taskCompletionAuthorized=false`。

### 现有在线渠道（每阶段独立费用授权）

```powershell
cd web
node scripts/p49e-configured-channel.mjs --probe
node scripts/p49e-configured-channel.mjs --init
# 上述两个命令都不发送模型请求。新实例路径记为 RUN_DIR。
node scripts/p49e-configured-channel.mjs --stage characters --dir RUN_DIR --ack-cost
# 查看 RUN_DIR/summary.json，确认草案后：
node scripts/p49e-creative-stage.mjs --approve characters --dir RUN_DIR --digest <64位摘要>
node scripts/p49e-configured-channel.mjs --stage scenes --dir RUN_DIR --ack-cost
```

每个**新的** `--stage` 都需要显式 `--ack-cost`；不带该标记不能发起付费请求。每阶段至多 2 次模型 POST，4 阶段合计上限 8 次；**请求数不等于金额硬上限，不能证明上游实际账单数额**。任何未知回执停止该实例的后续推进，不重新提交已提交的阶段。

### 恢复及审查

```powershell
node scripts/p49e-creative-stage.mjs --status --dir RUN_DIR
# 如果原执行进程已确实退出且没有活动写入锁：
node scripts/p49e-creative-stage.mjs --recover --dir RUN_DIR
```

所有报告默认为本机临时文件，可能含生成的角色与分镜文本。**不要将输出、完整模型请求或密钥提交版本库**。若需长期保留，迁入用户自行管理的受控目录并评估数据保护。

## 本轮已验证

- **真实本机在线配置元数据只读预检**：当前选择 `cline-pass/deepseek-v4.1-flash-1017`，持有 DPAPI 加密版本；未解密密钥/未发起模型 POST。
- **真实在线配置的零计费 Task 初始化**：Temp 下创建独立 `acceptance.sqlite`，原项目 DB 没有测试写入，调用计数为 0。
- **命令行四轮模拟**：逐阶段返回 3/3/6/6 份草案、四次模拟 Provider POST，逐阶段 digest 审批，导出审核报告，七维人工审核初始为 `draft`，不授权 Task 完成。
- 自动回归：持久 SQLite 跨轮读取、拒绝重复提交、未审批无法推进、冻结配置拒绝改变、未知回执原样保留、HTTP 503 安全诊断、二次空白结果拒绝、缓存成功结果恢复、提交前异常保留、写锁和 Temp 路径保护。
- 真实模型的场景/分镜/修订**尚未**在本阶段产生新结果。后续只能在**新的独立费用授权**下逐阶段运行；绝不能将 P4.9c 不明状态的场景请求当作已完成，或自动重发。

## 下一步

P4.9f：在用户明确许可每阶段最多 2 次潜在计费的在线文本模型请求后，逐阶段执行实际在线模型测试并用七维人工审核对照角色、场景、分镜与雨天修订的跨轮一致性。若某阶段出现 `needs_reconcile`，优先查看该阶段持久化调用诊断与证据，不使用“再试一次”来猜测远端执行结果。金额硬上限、长视频和负载测试按既定选择继续延期。
