# P4.6e：真实浏览器 → 项目级 Job 取消 → 本地 ComfyUI → 刷新恢复

> 日期：2026-11-15。已通过 **Chrome + 真实 React/Vite + Fastify + 独立 SQLite/CAS + 本地 ComfyUI 0.45.0**。本阶段以本地 ComfyUI 为主，费用金额硬上限、长视频和负载测试继续延期。

## 用户可用能力

- 在 Canvas「任务历史」中，属于当前项目的 `comfy` Job 处于 `queued` 或 `running` 时新增 **「停止此 ComfyUI 任务」** 按钮及危险操作确认。
- 前端使用 `POST /api/v1/projects/:id/jobs/:jobId/cancel`（CSRF/Origin、登录状态以及后端事务内的 Project/Job 关系核验），而不是全局 Job 取消入口。
- `queued` 状态仅结束尚未认领的本地 Job；`running` 必须按对应的远端 `prompt_id` 发送 `POST /api/jobs/:prompt_id/cancel`，并且远端明确返回 `cancelled:true` 后，JobCoordinator 才将 SQLite Job 写为 `cancelled`、释放 Lease、记录 `job_remote_cancel_confirmed`。
- 对 `cancelled:false`、连接中断或其他不确定结果，UI 只提示 **取消未确认**，原始 Job 保持原状态。刷新浏览器后只从后端读取真实状态，不凭弹窗或按钮点击推断远端已停止。
- `submission_unknown` 不会暴露重发生成或取消远端身份不明任务的按钮；取消不使用全局 `/interrupt`。

## 新增隔离实机夹具

- `scripts/p46e-browser-cancel-fixture.mjs`：仅通过 `ATELIER_P46E_BROWSER_E2E=1` 和具名临时数据目录启动，使用独立 Fastify、SQLite、CAS 与合法 local session；不访问正式项目、正式画布或频道。
- `scripts/p46e-chrome-scoped-cancel.py`：必须显式传入 `--live-scoped-cancel`，先确认远端 Comfy 队列为空，启动真实 Chrome 和应用页面、预加载历史与确认弹窗、按用户交互路径点击取消，再查询 SQLite 及远端证据。
- 仅构建两个 64×64 的临时 `EmptyImage/Sleep/PreviewImage` Comfy 工作流：短时占用执行槽的 `blocker`，以及等待执行、由应用 JobCoordinator **按 ID 取消**的 `target`。仅对脚本持有的两个 `prompt_id` 发起 scoped cancel；绝不调用 `/interrupt`、`/queue` 删除或创建大型模型 GPU 作业。
- 运行中的 KJNodes `Sleep` 可能让某些远端 API 查询排队直至任务完成。因此夹具只在提交**之前**校验队列空闲，并使用真实 `POST /prompt` 返回的 ID 冻结绑定；不得在 UI 取消窗口内用阻塞队列读取作为身份绑定依据。若提交回执未知，单次提交栅栏禁止自动重发。
- 测试夹具使用有效的模板 revision 和请求冻结校验；会话认证使用正常 cookie / CSRF / Origin，而非绕过后端鉴权。
- `blocker` 的 ID 只在本轮负责清理，不会将其绑定到正式项目或其他用户 Job。浏览器刷新不能再次提交 `/prompt`。

运行方式（真实本地 ComfyUI，仅限设备空闲时）：

```powershell
cd web
python scripts/p46e-chrome-scoped-cancel.py --live-scoped-cancel
```

## 实机验收

通过日志：`P46E_REAL_CHROME_SCOPED_CANCEL_PASS`，**22 / 22 Chrome 断言通过**。报告：

`H:\Temp\infinite-atelier-p46e-browser-jcsrxspi\p46e-browser-report.json`

已核实以下持久证据：

| 证据 | 实测 |
| --- | --- |
| 点击真实 Canvas 任务历史停止按钮及 AntD 确认弹窗 | 通过 |
| 仅当前项目 Job / 远端 ID 允许取消 | 已由项目级事务/API 回归验证 |
| Comfy scoped cancel 回执 | `cancelled:true` |
| JobCoordinator 返回 | `cancelled:true, remoteCancelled:true` |
| SQLite Job、Lease | `cancelled`，Lease 已释放 |
| `job_remote_cancel_confirmed` 事件 | 恰好 **1** 条 |
| 取消目标的远端运行历史 | **不存在**，证明待执行任务未运行 |
| 浏览器显示 / 刷新恢复 | 「已取消」，停止按钮消失；刷新后仍一致 |
| 重复提交 Comfy `/prompt` | 无；本轮恰好 2 个独立临时工作流 |
| 全局 `/interrupt` | **0 次** |
| 测试结束时远端队列 | `queue_running=0`、`queue_pending=0` |

额外专项回归：项目级取消接口对非授权与跨项目访问拒绝；模拟未获远端确认时 Job 保留 `running`；确认取消后不影响另一项目 Job。React 单测校验按钮显隐和只使用项目级 API。

## 边界与后续

- **P4.6d** 单独证明真实运行中和等待中按 ID 取消均有可靠 Comfy 回执；**P4.6e** 完成的是**等待中的远端 Job**经过真实 Chrome/JobCoordinator/SQLite/刷新恢复的全链闭环。它们相互补充，但不能将 P4.6e 宣称为 MiniMax H3 GPU 内核推理中断或大型模型 GPU 中断耗时验收。
- 夹具测试用工作流是 `EmptyImage/Sleep/PreviewImage`，没有调用模型生成或长视频；实际模型插件可能有自己的不可中断区间。
- 当按钮点击与远端自然完成竞争，明确的 `cancelled:false` 仍属于取消未确认，不能标记 `cancelled`；必须继续依靠任务轮询/历史及人工核对。
- 下一阶段建议从远端取消基础设施转向**真实文本 Provider 的角色、剧情、场景语义一致性验收**；取消机制保留现有安全栅栏。
- 按用户要求继续延期：**费用金额硬上限、长视频、负载测试**。
