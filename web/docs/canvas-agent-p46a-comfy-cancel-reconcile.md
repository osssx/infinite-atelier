# P4.6a：本地 ComfyUI 取消竞争与未知提交边界复核

> 日期：2026-11-15。仅修正取消结果判断并回归已有未知提交机制；**不实施**运行中的全局 `/interrupt`，不提交新 GPU Job，不涉及金额硬上限或长视频负载测试。

## 当前本地实例只读检查

- `GET http://127.0.0.1:8188/system_stats`：本地 ComfyUI **0.45.0**。
- `GET /queue`：`queue_running=[]`、`queue_pending=[]`（仅该次检查时的瞬时状态）。
- `GET /api/jobs/placeholder/cancel`：404；这只是**占位 ID 的只读探测**，不能证明实际运行中某个合法 Job 可通过该端点取消，也没有执行取消操作。
- 本轮未发送 `POST /interrupt`、`POST /queue`、`POST /prompt`。

## 已有安全约束

`comfy-v2-adapter.mjs` 的 `cancel` 优先使用指定 `prompt_id` 的 `/api/jobs/:id/cancel`，只有确认 `cancelled:true` 才将其视为远程取消。无法使用该接口时，只对 `/queue` 中**确实排队**的相同远端 ID 尝试删除；运行中的任务不会调用可能中断其他任务的无作用域 `/interrupt`。

`job-coordinator.mjs` 为远端取消加 Lease；未获确认时继续维持 `running`，不写 `job_remote_cancel_confirmed`，不凭客户端点击推断 Job 已停止。

先前已有的“结果未知”提交对账（测试名含 `P4.8`）保持原样：`submission_unknown` 不重新发送 `/prompt`；仅人工提供 ID 并从 `/history/:id` 验证提交标记和冻结 Graph 后，才可原子恢复 `running/collecting/failed`。

## 本轮改动与回归

1. 旧版 Comfy `POST /queue` 删除返回空的 HTTP 200 时，**队列消失并不必然意味着被删除**，任务可能同时开始或完成。现在二次查看队列后增加 `GET /history/:prompt_id`：发现同 ID 历史记录则返回 `comfy_cancel_raced_with_execution`，不得宣称确认取消；历史查询失败则返回 `comfy_cancel_history_unavailable`，同样不得宣称确认取消。
2. 新测试覆盖“待执行任务在删除后已经进入历史”和“历史查询断线”，验证适配器返回未确认、Coordinator 状态不被适配器擅自修改、永不调用全局 `/interrupt`。原有正常队列删除、正在执行拒绝、未知 POST 回执、恢复收集等场景继续保留。
3. `node --test server/backend/comfy-v2-adapter.test.mjs server/backend/job-coordinator.test.mjs`：**42/42 通过**。

## 尚未解决的风险和下一步

- 即使两次队列快照和 `/history` 都没有任务，旧版 `POST /queue` 的空响应也没有提供明确的单 Job 删除回执。**仍存在快照之间的竞态**；本轮新增历史核对缩小了误报窗口，但不能宣称彻底证明远端已停止。后续如需严格的远程取消证明，应优先支持有明确结果回执的 scoped cancel，并对旧接口提供“取消请求已发送但未确认”的交互/对账能力。
- 本地 ComfyUI 运行中 GPU 取消与断线竞争还未做真实受控实机测试；不应通过全局 `/interrupt` 去尝试证明它。
- 浏览器真实断线导致“HTTP 提交后响应未知”的端到端恢复尚未覆盖。下一轮 P4.6b 优先使用独立的临时项目/服务端故障注入，并确认不会再次 GPU 提交。
