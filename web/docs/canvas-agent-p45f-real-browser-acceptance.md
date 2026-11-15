# P4.5f：真实 Chrome 浏览器与本地 ComfyUI 媒体链验收

> 2026-11-15；只覆盖本地 ComfyUI。承接 P4.5d 的真实 GPU/SQLite/CAS/MiniMax H3 实测和 P4.5e 的任务面板刷新恢复。**不在正常浏览器回归中自动发起新的 GPU Job。**

## 两组真实浏览器测试

测试运行于 Windows / Chrome 157 / 真实 Vite React 画布 / 原 Fastify、SQLite 与 CAS 服务端。独立 Chrome 用户目录、临时端口和数据集，不访问或改写正式画布项目。使用 Chrome DevTools Protocol 执行真实浏览器 DOM 事件和 HTTP 网络观测，而非 happy-dom/React mock。

| 组别 | 脚本 | 实际覆盖 | 结果 |
| --- | --- | --- | --- |
| A · 用户授权、断网、撤销与取消 | `scripts/p45f-chrome-browser-e2e.py` + `scripts/p45f-browser-fixture.mjs` | 打开真实画布/助手、勾选单次媒体授权、刷新后读回 Grant、离线撤销报错、恢复联网不自动重试、明确撤销、取消 Task、刷新后保持取消与零 Job | **17 项断言通过** |
| B · 真实媒体产物在 Chrome 中回放 | `scripts/p45f-chrome-media-replay.py` + `scripts/p45f-real-media-replay-fixture.mjs` | 从 P4.5d 已成功的临时 GPU 验收根目录复制 SQLite/CAS；验证上游图→first_frame→下游视频连线、任务/Job/物化状态；Chrome 实际获取图片与视频流并核对 SHA-256、点击原画布视频播放封面、解码 448 × 448 MP4；刷新后比对整个 Job/Graph/Step 状态无变化 | **13 项断言通过** |

**合计 30 项 Chrome 浏览器断言通过；这两组测试期间新增 GPU Job：0。** 真实 GPU 媒体产物来自已完成的 P4.5d，两项 ComfyUI Job（Moss → MiniMax H3 I2V）均是先前已验证的 `succeeded`。本轮没有重新提交同一生成任务。

## 执行方式

在 `web` 目录，已安装 Node 依赖并具备 Python `websocket-client` 与本地 Chrome：

```powershell
python scripts/p45f-chrome-browser-e2e.py
python scripts/p45f-chrome-media-replay.py --source "H:\Temp\infinite-atelier-minimax-p3c2-1794739044806-dPCVAf"
```

第二个命令的 `--source` 必须指向已有 P4.5d 完整且可信的**隔离验收数据根目录**，包含 `minimax-p45c-recovery-result.json`。该临时目录可能在系统清理后消失；因此第二组需要先保留或重新取得一份真实媒体验收数据，不能假设它永久可用。

本轮实际成功日志：

- A：`P45F_REAL_CHROME_BROWSER_PASS`，报告 `H:\Temp\infinite-atelier-p45f-browser-1pd182kx\p45f-browser-report.json`
- B：`P45F_REAL_CHROME_MEDIA_REPLAY_PASS`，报告 `H:\Temp\infinite-atelier-p45f-replay-qiam2rct\p45f-media-replay-report.json`
- B 的已验证视频 SHA-256：`07675944fef9d9ee64230ab19e309b87dfc22b2926685b09c6fab02f5cb1ca4f`，字节数 98,822；原视频 448 × 448。浏览器从实际 `/api/v1/blobs/<sha>` 取得字节后使用 Web Crypto 独立计算摘要，并验证 MP4 `ftyp` 文件签名；原画布视频封面点击后读取到实际解码的视频尺寸。
- 两组均保存报告和 Chrome 截图到**对应临时根目录**，不污染仓库。

## 在实测中校正的测试夹具

1. P4.5d 原数据集自带 `atelier-dataset-identity.json`，不能直接复制并重新打开为另一个活动数据集（`dataset_identity_location_mismatch` 正确阻止了它）。B 组复制时**排除原激活标识**，让一次性临时数据集自行生成新身份；不改动产品的主动数据集排他和激活保护。
2. P4.5d API 级别验收没有创建浏览器 chat session，因此 Chrome 初次进入助手显示“未关联任务”。B 组仅在临时数据副本里以原 Task 的 `chatSessionId/rootMessageId` 恢复浏览器聊天会话，不更改原 SQLite。
3. 画布视频节点的 `<video>` 默认**不附加 src**，这是按需播放的设计，不能把空 src 误报为媒体加载失败。B 组点击真实封面按钮，才核查解码信息。

## 安全与未覆盖范围

- A 组 `autoDispatch:false`，模板仅用作授权 UI Fixture；不会触发 Comfy `/prompt`。B 组同样 `autoDispatch:false`，只读回放已成功的 CAS Blob、Task 与 Job 数据。两组脚本均使用显式测试环境标记、新的临时目录和独立 Chromium 配置。
- P4.5d 的真实本地 ComfyUI GPU 生成和原子 Grant 消费由**此前**真实服务端验收证明；P4.5f 新增的是**真实浏览器用户授权路径及已生成媒体的展示/刷新路径**。不能拼接两个测试而宣称“本次浏览器按钮发起了全新的 Comfy GPU Job”。
- 尚未实机覆盖：浏览器确认后直接生成一条**全新的** Moss → MiniMax H3 I2V、浏览器在入队 HTTP 响应丢失后通过原授权恢复、真实远程取消竞争、长时视频/并发压力。后续如进行新的 GPU 点击验收，应使用单独的显式 opt-in、独立临时数据库和一次性授权，禁止未知提交自动重试。
- 无生产 Schema 迁移、在线渠道改造或用户正式数据修改。
