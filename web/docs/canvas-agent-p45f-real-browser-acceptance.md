# P4.5f：真实 Chrome 浏览器与本地 ComfyUI 媒体链验收

> 2026-11-15；只覆盖本地 ComfyUI。承接 P4.5d 的真实 GPU/SQLite/CAS/MiniMax H3 实测和 P4.5e 的任务面板刷新恢复。默认 A/B 浏览器回归不触发 GPU；独立 C 组必须显式 `--live-gpu`，才会在新建隔离数据集中真实生成一次 Moss + MiniMax H3。

## 三组真实浏览器测试

测试运行于 Windows / Chrome 157 / 真实 Vite React 画布 / 原 Fastify、SQLite 与 CAS 服务端。独立 Chrome 用户目录、临时端口和数据集，不访问或改写正式画布项目。使用 Chrome DevTools Protocol 执行真实浏览器 DOM 事件和 HTTP 网络观测，而非 happy-dom/React mock。

| 组别 | 脚本 | 实际覆盖 | 结果 |
| --- | --- | --- | --- |
| A · 用户授权、断网、撤销与取消 | `scripts/p45f-chrome-browser-e2e.py` + `scripts/p45f-browser-fixture.mjs` | 打开真实画布/助手、勾选单次媒体授权、刷新后读回 Grant、离线撤销报错、恢复联网不自动重试、明确撤销、取消 Task、刷新后保持取消与零 Job | **17 项断言通过** |
| B · 真实媒体产物在 Chrome 中回放 | `scripts/p45f-chrome-media-replay.py` + `scripts/p45f-real-media-replay-fixture.mjs` | 从 P4.5d 已成功的临时 GPU 验收根目录复制 SQLite/CAS；验证上游图→first_frame→下游视频连线、任务/Job/物化状态；Chrome 实际获取图片与视频流并核对 SHA-256、点击原画布视频播放封面、解码 448 × 448 MP4；刷新后比对整个 Job/Graph/Step 状态无变化 | **13 项断言通过** |
| C · Chrome 实际授权并触发真实本地 GPU 媒体链 | `scripts/p45f-chrome-live-gpu.py --live-gpu` + `scripts/minimax-p3c2-live-acceptance.mjs` 的 opt-in 浏览器闸门 | Chrome 点击授权→真实 Moss 图片→CAS 落图→`first_frame` 原子连线→刷新后 Chrome 点击“使用原授权恢复一次本地 ComfyUI 生成”→MiniMax H3 新视频 Job→CAS/Task 完成→Chrome 点击新视频封面并独立核对 SHA→刷新不得生成额外 Job | **18 项断言通过（含服务端成功退出验证）** |

**合计 48 项 Chrome 浏览器断言通过（A 17 + B 13 + C 18）。** A/B 各自零新增 GPU Job；C 组在**全新隔离 SQLite/CAS 根目录**真实新增 Moss 图片和 MiniMax H3 视频共 **2 个成功 Job**，消耗 **1 个**媒体 Grant、形成 **2 项**可信物化，刷新不重复生成。C 组与 P4.5d 先前成功的服务端验收为独立运行，不修改正式画布或重复消费其授权。

## 执行方式

在 `web` 目录，已安装 Node 依赖并具备 Python `websocket-client` 与本地 Chrome：

```powershell
python scripts/p45f-chrome-browser-e2e.py
python scripts/p45f-chrome-media-replay.py --source "H:\Temp\infinite-atelier-minimax-p3c2-1794739044806-dPCVAf"
# 仅明确允许本地真实 GPU 任务时，单独执行 C 组：
python scripts/p45f-chrome-live-gpu.py --live-gpu
```

第二个命令的 `--source` 必须指向已有 P4.5d 完整且可信的**隔离验收数据根目录**，包含 `minimax-p45c-recovery-result.json`。该临时目录可能在系统清理后消失；因此第二组需要先保留或重新取得一份真实媒体验收数据，不能假设它永久可用。

本轮实际成功日志：

- A：`P45F_REAL_CHROME_BROWSER_PASS`，报告 `H:\Temp\infinite-atelier-p45f-browser-1pd182kx\p45f-browser-report.json`
- B：`P45F_REAL_CHROME_MEDIA_REPLAY_PASS`，报告 `H:\Temp\infinite-atelier-p45f-replay-qiam2rct\p45f-media-replay-report.json`
- C：`P45F_CHROME_REAL_GPU_MEDIA_CHAIN_PASS`，报告 `H:\Temp\infinite-atelier-p45f-live-x5klrwta\p45f-chrome-live-gpu-report.json`；真实 GPU 数据目录 `H:\Temp\infinite-atelier-minimax-p3c2-1794749879548-3pk2Eq`。C 组报告 JSON 最终有 **18** 项断言（`PASS` 行中的计数在最后一项服务端退出验证之前打印，显示 17），无浏览器 JS 异常，真实图、视频各 1 个 `succeeded` Job。
- B 的已验证视频 SHA-256：`07675944fef9d9ee64230ab19e309b87dfc22b2926685b09c6fab02f5cb1ca4f`，字节数 98,822；原视频 448 × 448。浏览器从实际 `/api/v1/blobs/<sha>` 取得字节后使用 Web Crypto 独立计算摘要，并验证 MP4 `ftyp` 文件签名；原画布视频封面点击后读取到实际解码的视频尺寸。
- 三组均保存报告和 Chrome 截图到**对应临时根目录**，不污染仓库。C 组默认拒绝无 `--live-gpu` 的运行，且两次浏览器点击分别产生 1 次 Grant 与唯一视频 Job；原始脚本在浏览器放行前保持冻结。

## 在实测中校正的测试夹具

1. P4.5d 原数据集自带 `atelier-dataset-identity.json`，不能直接复制并重新打开为另一个活动数据集（`dataset_identity_location_mismatch` 正确阻止了它）。B 组复制时**排除原激活标识**，让一次性临时数据集自行生成新身份；不改动产品的主动数据集排他和激活保护。
2. P4.5d API 级别验收没有创建浏览器 chat session，因此 Chrome 初次进入助手显示“未关联任务”。B 组仅在临时数据副本里以原 Task 的 `chatSessionId/rootMessageId` 恢复浏览器聊天会话，不更改原 SQLite。
3. 画布视频节点的 `<video>` 默认**不附加 src**，这是按需播放的设计，不能把空 src 误报为媒体加载失败。B 组点击真实封面按钮，才核查解码信息。

## 安全与未覆盖范围

- A 组 `autoDispatch:false`，模板仅用作授权 UI Fixture；不会触发 Comfy `/prompt`。B 组同样 `autoDispatch:false`，只读回放已成功的 CAS Blob、Task 与 Job 数据。两组脚本均使用显式测试环境标记、新的临时目录和独立 Chromium 配置。
- C 组是独立真实 Chrome 按钮发起的新 GPU E2E，而不是将 P4.5d 服务端结果与 A/B 浏览器结果拼接。C 组的 Node 验收服务仍复用 P4.5d 原子 Comfy/Task/Materializer 路径，浏览器只在**真实 UI 显式点击** Grant 与 `/enqueue-authorized`；不创建另一套后门提交器。
- 尚未实机覆盖：浏览器**HTTP 入队响应确实丢失**时的人工对账（C 组测试的是等待审批的正常页面刷新后恢复，不是网络提交结果未知）、Comfy 远程取消竞争、10 分钟以上长视频/并发压力及非 Chrome 内核。遇未知提交仍禁止自动重试；不应将成功的正常刷新等同于未知提交对账。
- 无生产 Schema 迁移、在线渠道改造或用户正式数据修改。
