# P4.6d：本地 ComfyUI 真实按任务取消验收

> 日期：2026-11-15。实机 ComfyUI 0.45.0，真实 HTTP `/prompt`、`/api/jobs/:id/cancel`、`/queue`、`/history/:id`。本轮仅进行**两个新建的小型临时任务**的执行与取消，不读取/修改正式画布、SQLite 或 CAS。不涉及费用硬上限、长视频或压力测试。

## 测试目标及防护

可复现脚本：`web/scripts/p46d-comfy-scoped-cancel-live.mjs`。

```powershell
cd web
node scripts/p46d-comfy-scoped-cancel-live.mjs --live-scoped-cancel
```

- 不带完整 `--live-scoped-cancel` 参数会拒绝运行；只支持 `http://127.0.0.1:<port>` 或 IPv6 loopback，拒绝非本机地址。
- 开始前要求远端 `queue_running` 和 `queue_pending` **同时为空**；核查 `EmptyImage`、`Sleep`（本机 KJNodes）和 `PreviewImage` 可用。任何预检不满足则不提交任务。
- 两个临时工作流使用 `EmptyImage(64×64) → Sleep → PreviewImage`，分别创建 9 秒与 2 秒的睡眠节点以控制执行窗口，**不加载模型或视频推理权重**。
- 每个 `/prompt` 提交携带本轮生成的独立 client/marker，脚本只保留本轮 HTTP 成功回执中收到的两个 `prompt_id`。只有属于本轮 `owned` 集合的 ID 才能调用 `/api/jobs/:id/cancel`。
- HTTP POST 路径仅允许 `/prompt` 和带 UUID 的 `/api/jobs/:id/cancel`。严禁全局 `/interrupt`、批量 `/queue` 删除、全局 `/free`。
- 结束时再次只按自有 ID 清理；异常会记录报告，不触碰未知或其他用户任务。若 `/prompt` 的 HTTP 回执丢失，本脚本不会重发，应另行根据 P4.6c 冻结 marker 做人工对账。
- 这不是负载测试。场景使用的短延时节点是测试夹具，不构成真实 MiniMax H3 GPU 推理取消验收。

## 本轮实机结果

环境：本地 ComfyUI **0.45.0**。测试前后队列均为空。脚本输出 `P46D_REAL_SCOPED_CANCEL_PASS`，**14/14 项检查通过**。

| 核对事项 | 结果 |
| --- | --- |
| 先提交测试 A，确认其在运行队列 | 通过 |
| 再提交测试 B，确认其在等待队列，且队列只有 A / B | 通过 |
| 定向取消等待中的 B，远端回执 `cancelled:true` | 通过 |
| 取消 B 后，A 仍在运行中、B 从等待队列消失 | 通过 |
| 定向取消运行中的 A，远端回执 `cancelled:true` | 通过 |
| 运行结束后二者均不在活动队列 | 通过 |
| B 没有历史执行记录，A 历史为 `error`，没有 PreviewImage 输出 | 通过 |
| A 终态再次取消返回 `cancelled:false` | 通过 |
| 全局 `/interrupt` 调用数 | **0** |
| 脚本本轮创建的远端任务数 | **2** |

> 这里 `cancelled:true` 表示 ComfyUI 指定任务取消接口明确确认其已调度取消或已出队。最终运行历史与下游产物的检查**独立于 HTTP 回执**，防止把请求收到当成任务已经结束。KJNodes 的短 `Sleep` 本身不可在 `time.sleep` 中途立即停止，取消在后续调度检查生效。

完整独立报告：

`H:\Temp\infinite-atelier-p46d-oi45NH\scoped-cancel-report.json`

该报告在临时路径中，非项目源码或长期存储，不依赖该绝对路径才能重新运行脚本。

## 保留风险与后续阶段

- 本轮证明 **当前运行的 ComfyUI 在真实待运行/运行中场景支持按 ID 取消**，且两任务之间未发生互相中断；未跑完整 App 的 `JobCoordinator.cancel` + Task UI 链路。该应用层链路已有 mock/事务测试，但还缺“真实 Comfy 远端 + 隔离 SQLite + 用户按钮”的组合实机验收。
- 本轮没有启动 MiniMax H3 模型 GPU 推理；实际 GPU 内核中断延迟、显存回收和复杂模型插件的中断可响应性不能从 `Sleep` 任务推断。
- 运行在同一 ComfyUI 共享端口，因此必须维持“队列空闲才开始，取消只允许本轮 ID”的防护。未来并行用户任务出现时，测试脚本应直接中止，不把其作为压力场景。
- 推荐 P4.6e：隔离浏览器/服务端 SQLite/CAS 下，用本次真实 Comfy scoped cancel 端点完成原 Job 的状态回执与刷新恢复闭环。然后进入真实文本 Provider 的人物、故事、场景一致性专项。
- **继续延期**：费用金额硬上限、长视频与负载测试。
