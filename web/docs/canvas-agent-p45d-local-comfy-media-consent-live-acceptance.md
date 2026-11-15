# P4.5d：本地 ComfyUI 单次媒体授权实机自动连线与视频生成验收

> 日期：2026-11-15。Windows / 本地 ComfyUI 127.0.0.1:8188 / RTX 3080；MiniMax H3 I2V 使用 `minimax_h3_video_vae_int8_convrot.safetensors`。真实 GPU、SQLite/CAS/Task 和 HTTP 服务端事务均已验证。**不是浏览器内授权按钮的 UI 端到端验收，也不是长视频/远程取消压力测试。**

## 目标和实际实现

此前 P4.5c 的实机链路每个 Step 各自人工批准。P4.5d 新增明确的 `ATELIER_MINIMAX_MEDIA_CONSENT=1` 验收模式，在上游图片生成前先通过原 `/run-budget` API 发放一个 `mode=local_comfy_media` 的持久授权，只允许固定下游 MiniMax H3 工作流、第 2 项 RunIndex、`first_frame`、当前 Comfy 实例以及**最多一个新视频 Job**。

图片生成仍经过独立的首步审批；待唯一可信图片通过 BlobStore、CAS、画布 Materialization 和 Task `server_committed` 校验后，工具通过原 `canvas-steps` 冻结唯一的媒体端口连接，`runMediaGrantId` 随审批与执行进入原子图事务。下游视频由**原 `/enqueue-authorized`** 接口提交；在 SQLite 同一事务中确认权限、冻结模板、真实连线及前置 CAS 回执，写入一个 Job/Attempt 和一个 `run_budget_consumed`。没有新增 GPU 提交服务或在线支付通道。

验收脚本：`web/scripts/minimax-p3c2-live-acceptance.mjs`，原模式保持不变；只有显式开启两个环境变量才使用 P4.5d：

`ATELIER_MINIMAX_LIVE=1`

`ATELIER_MINIMAX_MEDIA_CONSENT=1`

运行：`node scripts/minimax-p3c2-live-acceptance.mjs`（在 `web` 目录中）。

## 实机发现与修复：数字节点 ID 的图哈希兼容

第一次 P4.5d 实机运行在图片成功、可信 `first_frame` 连线成功后，下游 Job 入队被 409 拒绝，**并未产生第二个 Job**。

原因：当前 Comfy Registry 的发布图 `workflow_hash` 为 `sha256(JSON.stringify(canonical(graph)))`，而现有媒体授权原本使用 `repository.stableJson(graph)` 哈希。对于 `92`、`114` 等数字样式节点 ID，JavaScript `JSON.stringify` 枚举对象键时会优先以整数索引排序，手写 lexical sorter 则完全按字母序；因此**同一张真实 27 节点图出现两个不同哈希**，导致错误地拒绝有效视频入队。

修复位于 `web/server/backend/assistant-task-run-media-grant.mjs`：授权分别固定**模板元数据摘要**和 **Comfy 注册表发布时同算法的真实图 SHA-256**，两者都必须与当前冻结快照一致。不会放宽模板变更/参数夹带检测。兼容旧版 `payload_json` 中包含图的测试格式；对于新版分离式注册表必须使用 `workflow_hash`。新增混合数字/字符串 Node ID 的正反测试：原图允许，一旦改动内部输入节点，严格禁止 Job 入队、额度保持未消耗。

## 真实恢复与最终完成

首次失败后，隔离 SQLite 中只有一个已成功、已 CAS 物化的图片 Job；授权仍有效、未扣除额度，画布连线已成功、视频 Step 冻结为 `waiting_approval`。安全恢复模式使用 `ATELIER_MINIMAX_RESUME_ROOT` 指向原隔离目录：复用原图片、`server_committed` 连线回执和已有视频 Step，不重复创建图片、连线或视频计划，再重新验证后**只入队一次**视频 Job。如果视频 Job 已经创建，则拒绝此模式，应使用 P4.5c 只读/观察式恢复器，绝不因 API 超时重复 POST。

隔离数据目录：

`H:\Temp\infinite-atelier-minimax-p3c2-1794739044806-dPCVAf`

真实验收：

| 项目 | 证据 |
| --- | --- |
| 用户媒体授权 | 1 个 `local_comfy_media` Grant |
| 上游图片 Job | `4b11b106-fbbc-45e1-9512-74d566a85ed5`，`succeeded` |
| 已验证图片 | 431,558 B；唯一可信 CAS，`materialized` |
| 画布连线 | `moss-image-source` → `minimax-i2v-workflow.first_frame` |
| 媒体图 Step | 原 `6f9103cc-9edc-408d-845f-8462faadb708`，复用且可信提交 |
| 下游视频 Job | `ff0f8d99-94d5-4ff7-bd8b-fdbf08c28031`，`succeeded` |
| 视频远端任务 ID | `e29ae0b8-b0ea-4dfe-952f-da2da0caf7e2` |
| 视频规格 | MP4 / H.264，448 × 448，1.625 秒，39 帧 |
| 视频字节数 | 98,822 |
| 视频 SHA-256 | `07675944fef9d9ee64230ab19e309b87dfc22b2926685b09c6fab02f5cb1ca4f` |
| Task / Run Sequence | 均为 `completed` |
| 可信物化 Step | 两个 `materialize` 均为 `server_committed` |
| SQLite 幂等审计 | Job 总数 2；各 Job `job_submit_barrier` 恰好 1 条；Grant `run_budget_consumed` 恰好 1 条 |

P4.5c 的只恢复、不重提交工具对本轮真实视频进行了第二次 CAS 流式 SHA-256 校验，并使用 `ffprobe` 验证视频流，同时输出便于直接播放的 MP4 副本：

`H:\Temp\infinite-atelier-minimax-p3c2-1794739044806-dPCVAf\minimax-p45c-verified-07675944fef9.mp4`

审计文件：

`H:\Temp\infinite-atelier-minimax-p3c2-1794739044806-dPCVAf\minimax-p45c-recovery-result.json`

上述 `H:\Temp` 为 Windows 临时目录路径，不应视为永久资产库；可在需要时手动复制到正式资产目录。

## 安全边界

- 只有显式开启 `ATELIER_MINIMAX_LIVE=1` 才产生真实 GPU 任务；预检不提交生成请求。`ATELIER_MINIMAX_MEDIA_CONSENT=1` 是**验收脚本的显式 opt-in**，不能替代产品界面上的用户确认。
- 这次完成的是**真实 HTTP/SQLite/Task/ComfyUI 服务端授权执行闭环**，未通过浏览器自动化点击授权 UI，也未测试完整产品的画布持久化客户端交互。前端授权与动态媒体无权自动执行测试继续由 Vitest 覆盖。
- 多候选媒体、CAS 校验失败、工作流图或参数变化、未知提交、额度用完、撤销或过期继续沿用既有 fail-closed 保护；不能自动挑第一个候选或偷偷重试 GPU。
- 尚未实机验证长视频和负载压力、实际停止/取消竞争、浏览器关停后主动续行、跨两次进程中断后的 UI 恢复。这些列为 P4.5e 后续专项，不在本次成功范围。
- 无 Schema 迁移，无在线渠道计费改造；本轮 Git 提交不包括已有的其他未提交文档/代码。

## 回归

媒体授权专项针对真实规范化注册表的**数字节点键哈希一致性**及**内部图篡改拒绝**增加了测试。完整回归以本轮实际命令日志为准，包含 Comfy Adapter / JobCoordinator / 画布 Materializer / Task Run Sequence / Grant / 恢复、Vitest 前端全量、TypeScript typecheck 与生产构建。
