# P4.5f：真实 Chrome 浏览器本地媒体授权与刷新恢复验收

日期：2026-11-15。Chrome 157 / Vite / Fastify / SQLite/CAS。本轮只验收本地 ComfyUI 授权流程，不接入在线渠道、不向真实 ComfyUI 重新发送 `/prompt`；真实 GPU I2V 结果见之前 P4.5d 的实机记录。

## 可重复运行

在 `web` 目录执行：

```powershell
python scripts/p45f-chrome-browser-e2e.py grant
python scripts/p45f-chrome-browser-e2e.py recovery
```

- `scripts/p45f-browser-fixture.mjs`：显式 `ATELIER_P45F_BROWSER_E2E=1` 才允许启动，只接受系统临时目录 `infinite-atelier-p45f-browser-*` 作为数据根。创建全新项目、聊天、Task、Run Sequence 和测试本地 Comfy 模板。`autoDispatch=false` 禁止真实 GPU 推理。
- `scripts/p45f-chrome-browser-e2e.py`：启动独立 Fastify/Vite/Chrome headless，使用真实 `/canvas/:id` 产品页面与实际浏览器点击；通过 Chrome DevTools 捕获 HTTP 请求，读取隔离 SQLite 状态并截屏。测试完成后清理浏览器/服务器子进程，保留临时报告。

## Chrome 场景 A：授权、刷新、断网、撤销、结束记录

浏览器打开实际 AI 助手面板，勾选“确认本地媒体链自动绑定与生成”，点击“批准唯一媒体连线及一次 ComfyUI 生成”。SQLite 确认一个 `local_comfy_media` Grant、零 Job。刷新页面后，持久授权状态仍可见。

DevTools 模拟断网并点击“撤销剩余自动入队授权”；HTTP 失败，数据库不写入撤销事件。恢复网络后系统不会自动重发失败的 POST；用户再次明确点击撤销才成功。最后点击“结束记录”，Task 转为 `cancelled`，刷新后取消状态仍持久，始终 **0 Job / 0 Comfy GPU 提交**。

已通过报告及真实浏览器截图：

`H:\Temp\infinite-atelier-p45f-browser-a3w45mfv\p45f-browser-report.json`

`grant-approved.png`、`grant-revoked.png` 保存在同目录。

## Chrome 场景 B：用户点击恢复原冻结视频 Step

为了不重复推理，隔离后端以**合成 1×1 PNG** 作为测试素材，通过真实 Task / Job / Artifact / CAS / Materialization / Canvas Step 的服务端事务预置一个已完成的上游 Job、服务器可信的 `first_frame` 连线，以及一个原媒体 Grant 绑定的 `waiting_approval` 下游 Comfy Step。**合成图不代表真实 GPU 生成。**

真实 Chrome 验证：

1. 第一次打开和刷新时只存在 1 个前驱 Job；授权仍有一次额度，浏览器不会自动入队视频。
2. 刷新后显示“使用原授权恢复一次本地 ComfyUI 生成”。
3. 用户明确点击一次，浏览器发送单条 `POST /enqueue-authorized`，Fastify/SQLite 只创建 1 个下游 Job（总数 2）、消耗 Grant 恰好 1 次。
4. 再次刷新后 Job 总数和授权消耗数量不增加；`autoDispatch=false`，所以没有生成服务 `/prompt` 调用和 GPU 提交屏障。
5. 页面加载与两次刷新都不会无端改变冻结时的 Project revision。

已通过报告及真实截图：

`H:\Temp\infinite-atelier-p45f-browser-g6acwmkx\p45f-browser-report.json`

`recovery-before-refresh.png`、`recovery-authorized-enqueue.png` 保存在同目录。

## 实机发现与修复：首次画布恢复无变更 PATCH 导致原媒体授权失效

首次测试发现：浏览器加载画布后，即使节点与连线内容未变，React 恢复节点数组的引用变化也触发了不必要的 `updateProject` 和自动保存，Project revision 从 **3** 增加为 **5**。原 Comfy 任务快照固定 `canvasRevision=3`，后端正确拒绝不匹配的入队，但客户端出现 `internal_error`，使原本合法的刷新恢复路径不可用。

修改 `src/pages/canvas/project.tsx`，以一次性恢复帧快照抑制**内容确实未变**的首次自动保存；另新增 `src/features/backend-sync/canvas-initial-hydration.ts` 和测试，判断上一次的节点重置/连线修复是否存在真正的图变化。真实重置中断生成、真实连线修复和后续用户编辑仍正常持久化。该比较只在项目加载时发生，不进入拖拽渲染热路径。

修复后，真实浏览器已证明：三个页面加载检查点 Project revision 不变，原冻结 Step + Grant 可成功入队一次，后端 Comfy/媒体/权限校验逻辑**没有放松**。

## 最终测试结果

- 真实 Chrome 157 `grant` 场景、`recovery` 场景均实际成功，报告和截图路径如上；零意外 Comfy 远端提交。
- 前端 Vitest 全量：**170 个测试文件，1122 项通过**；新增首次恢复是否需要保存图的 3 项测试。
- 后端相关联合回归：**293 项通过**（包含 Task/Grant、ComfyUI、JobCoordinator、CAS Materializer、取消与恢复）。
- TypeScript `npm run typecheck` 通过，Vite `npm run build` 通过。仅有已有的打包拆分/体积提示。
- 无 SQLite Schema 迁移，正式用户资产、原有用户工作区与已存在的 GPU Job 均未改变。

## 剩余范围

本轮是真实 Chrome 产品界面、Task/授权/SQLite/Job 创建和刷新恢复的验收；仍未测试长时间真实 GPU 视频、ComfyUI 远端中断取消竞争、真实断电时未知提交对账。注意“结束记录”和“撤销未来授权”都不会自动取消已经运行的 GPU Job。下一阶段应优先测试真实本地 ComfyUI `/interrupt` 与运行时断线恢复，禁止结果不明的自动重发。

无数据库 Schema 迁移、无在线渠道改造、无正式资产修改。
