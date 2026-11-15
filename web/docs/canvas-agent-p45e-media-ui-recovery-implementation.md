# P4.5e：AI 助手本地 ComfyUI 媒体链刷新恢复与取消边界

> 2026-11-15，范围：任务面板（React DOM）/ Task 服务端冻结 Step 视图 / 原 `local_comfy_media` 一次入队授权。承接 P4.5d 已通过的真实本地 MiniMax H3 I2V GPU/SQLite/HTTP 验收。**不对用户项目进行第二次真实 GPU 提交。**

## 发现的问题

当客户端已经取得 `mode=local_comfy_media` 授权，并完成上游图片的唯一 CAS 可信落图及 `first_frame` 画布连线后，如果页面在视频 Job 入队前关闭或 HTTP 返回不明，服务端会留下一个持久的 `comfy_workflow` `waiting_approval` Step。Run Sequence 因为该 Step 已冻结，状态是 `waiting_approval`、`next=null`；浏览器的自动续行 Effect 因而正确停止。

但原任务面板的通用“批准并入队”始终发送 `/approval` → `/enqueue`，无法从这个持久断点安全使用原有授权的 `/enqueue-authorized`，刷新后用户只能手动排查 API。

同时，客户端之前没有显式检查 Task 的 `cancelRequestedAt`；虽然服务端的事务已有取消拦截，UI 仍可能在取消状态尚未同步为终态时触发无效的下一步请求。

## 本轮实现

1. **保留冻结身份**：`assistant-tasks.mjs` 的 Step 公开视图现在返回服务端冻结的 `runSequenceId` 和 `runIndex`。仅暴露 ID 与索引，不暴露完整服务端私有预条件；防止浏览器通过标题、节点 ID 或当前顺序状态推测哪个 Grant 可以使用。
2. **严格匹配 Grant**：`matchesActiveMediaGrant` 同时要求 Grant 的 `mode=local_comfy_media`、`active`、未撤销、未过期、余量恰好 1、唯一允许索引、Task 未取消/未只读、当前 Step 是 `comfy_workflow / waiting_approval`，Step 和 Grant 的计划版本/RunSequence/索引完全一致，且 RunSequence 中的冻结目标节点与 Step 目标相符。
3. **显式恢复一次**：刷新后的任务面板显示“使用原授权恢复一次本地 ComfyUI 生成”。仅用户点击时再次 `GET /run-budget` 校验授权，随后使用固定请求 ID 提交 `POST /steps/:id/enqueue-authorized`，交由**原子服务端入队事务**重新核对 Comfy 实例、完整工作流、媒体 SHA、唯一图连线回执及一次额度。**不调用普通 `/approval` / `/enqueue` 来绕过 Budget**。
4. **错误与未知提交不自动重发**：HTTP 错误时停止并显示查询原 Step/Job 的提示；不会根据错误消息猜测是否已经提交或自动重试。恢复按钮是显式用户操作，正常自动续行 Effect 对 `waiting_approval` Step 保持禁止执行。
5. **取消优先**：在客户端自动续行条件与手动恢复入口均检查从服务端读取的 `cancelRequestedAt`。任务已取消/只读/Grant 撤销或变更将不再触发下一次生成。撤销 Grant 不会自动停止已经提交并运行的 Job，停止远程生成仍使用既有 Job 历史操作。

## 验收

- React DOM 测试：持久 Grant 与 Step 刷新恢复，未经点击 **0 POST**，点击一次得到 **1 条 `/enqueue-authorized`**；随后状态与重复 UI 渲染不会再提交。
- 失效边界：授权撤销、过期、跨 Run Sequence、跨 RunIndex、`cancelRequestedAt` 均不显示恢复授权；如果用户点击前服务器已撤销 Grant，二次校验失败且 0 入队 POST。
- 上游图片可信物化 SSE：在原 Task 继续有效、唯一 Grant 尚有额度时，客户端只向现有控制器发出**一次**续行请求；重复 SSE 不会重复触发。
- 后端：在真实 SQLite/Task 步骤检查刷新后的 `runSequenceId/runIndex` 与先前冻结数据一致；原 P4.5b 媒体单次授权、Job 原子入队、多候选/CAS/工作流变更拒绝测试继续通过。
- 已有 P4.5d 实机结果：本地 RTX 3080 / 指定 VAE `minimax_h3_video_vae_int8_convrot.safetensors` 的 Moss 图片 → `first_frame` → MiniMax H3 视频、CAS 落图与未知状态恢复均在上一阶段通过，本轮无须再次产生真实 GPU Job。

## 本轮实际验收结果

- 服务端相关后端联合回归：**293 项通过**（含原子媒体 Grant、Comfy Job、Task Step、CAS、断线恢复和取消保护）。
- 任务面板 React DOM 专项：**51 项通过**，新增刷新等待审批的显式授权恢复、授权失效与跨 Step、重复 SSE 的去重和取消意图测试。
- 前端 Vitest 全量：**169 个文件、1119 项测试通过**。
- TypeScript 严格类型检查 `npm run typecheck` 与 Vite 生产构建 `npm run build` 均通过；构建存在不阻断的打包尺寸与动态导入警告。
- 保留 P4.5d 实机 SQLite/ComfyUI 证据，不重新向真实 GPU 提交相同任务。新浏览器跨进程交互本轮仍未进行，不计入通过。

## 不包含

**本轮没有声称浏览器 Chrome/Edge 真实点击的 E2E 成功**：当前工具环境无预装 Playwright/Selenium，产品前端与后端未启动。React DOM 交互与真实后端 SQLite/HTTP 的各自测试不能替代跨浏览器、跨网络的完整联调。后续应在隔离的真实项目中用浏览器跑“Grant 同意 → 首帧 → 动态连线 → 生成 → 刷新 → 取消”，尤其验证断网与关闭标签页场景。

暂未额外实机验收 10 分钟以上的长视频、Comfy 后端实际取消竞争、未知提交的人工对账；保留已有 `submission_unknown` 禁止重试与单次 Job 授权策略。无数据库 Schema 迁移；本轮不接入在线渠道。
