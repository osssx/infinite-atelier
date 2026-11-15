# P4.6b：真实 Chrome 丢失入队 HTTP 响应后的 Task / Job 恢复验收

> 日期：2026-11-15。只在**隔离临时数据根**验证浏览器与真实 Fastify/SQLite/CAS 的入队一致性；`autoDispatch:false`，不运行新 GPU、不发送 `/prompt`。承接 [P4.5f](./canvas-agent-p45f-real-browser-acceptance.md) 与 [P4.6a](./canvas-agent-p46a-comfy-cancel-reconcile.md)。

## 真正测试的故障时点

在 `web/scripts/p45f-chrome-browser-e2e.py lost-ack` 中，Chrome 157 以 CDP `Fetch.enable` 的 **Response** 阶段拦截唯一的 `POST .../enqueue-authorized`。Fastify 已运行完整服务端入队事务、给出 HTTP 200，Chrome 才通过 `Fetch.failRequest(ConnectionClosed)` 关闭这次请求。它不是在发送之前模拟断网，也不是把服务器正常入队误认为失败。

隔离服务使用原 `p45f-browser-fixture.mjs` 的 `recovery` 冻结媒体链和独立 SQLite/CAS，允许显式 `lost-ack` 场景。前驱是测试用合成 1×1 PNG 与可信 Step/Grant/Materialization 回执，**不是**真实 GPU 生成的图片。整个场景禁用生成调度，防止意外发送本地 Comfy `/prompt`。

## 已验证行为

1. 浏览器真实加载画布和 Task，刷新后发现冻结 `waiting_approval` 视频 Step、有效一次性媒体 Grant，初始只有 1 个前驱 Job，画布修订不变。
2. 用户在 Chrome 点击“使用原授权恢复一次本地 ComfyUI 生成”；后端原子新增 **1 个**下游 Job，消耗 **1 次** Grant。
3. CDP 仅在响应阶段断开已返回 200 的 HTTP 请求；前端如实显示“可凭原 Step 查询已有 Job，不会自动重试”，不根据网络失败猜测 Job 未创建。
4. 刷新后任务面板可实际看到原 `Job ID`；SQLite 总 Job 数保持 **2**、Grant 消耗保持 **1**，浏览器总计只有一次 `enqueue-authorized` POST，没有普通 `enqueue` 或远端 `/prompt`。
5. 浏览器初次加载与两次刷新没有无意义项目保存或修订上升。

`lost-ack` 组 **18 项 Chrome 断言全部通过**。报告：

`H:\\Temp\\infinite-atelier-p45f-browser-lhdco9dt\\p45f-browser-report.json`

同一命令之前的首次验收也成功，但本文件记录的是增加“刷新后 Task UI 实际显示 Job ID”断言后第二次成功的报告。

## 运行方式

在 `web` 目录下：

```powershell
python scripts/p45f-chrome-browser-e2e.py lost-ack
```

脚本沿用原有临时路径、独立浏览器 profile、任务数据隔离和显式 fixture opt-in；执行结束清理子进程，保留 JSON 报告及截图。

## 未覆盖与剩余边界

- 本测试是 **Job 入队 API 的“响应已提交但浏览器未收到”**；不等于 Comfy **`POST /prompt`** 的响应丢失（后者由已有 `submission_unknown` + 人工冻结 Graph/marker 核对的服务端回归覆盖，但浏览器产物恢复尚未全链实机覆盖）。
- 不能用合成测试图取代真实 GPU 媒体质量验证；真实 Moss/MiniMax H3 的 Chrome E2E 已在 P4.5f 独立跑通。
- 未触发运行中的 scoped Comfy 取消或无作用域 `/interrupt`；该部分留给 P4.6c，必须保持不会误取消其他远端 Job 的约束。
