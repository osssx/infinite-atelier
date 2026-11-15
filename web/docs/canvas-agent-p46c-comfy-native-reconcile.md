# P4.6c：本地 ComfyUI 0.45 真实协议的未知提交对账与安全取消

> 日期：2026-11-15。仅覆盖本地 ComfyUI。实现的对账触发必须由用户显式操作；不新增自动 GPU Job，不改 SQLite Schema，不接入费用硬上限，不做长视频或负载测试。

## 只读实机协议检查

在 Windows 本地 ComfyUI `http://127.0.0.1:8188` 运行：

```powershell
cd web
node scripts/p46c-comfy-readonly-preflight.mjs
```

本轮实测输出 `P46C_COMFY_READONLY_PREFLIGHT_PASS`：

- ComfyUI **0.45.0**；运行中、等待中队列分别为 **0 / 0**，这是检查时的瞬时状态。
- 使用 `GET /history?max_items=1` 只读取一份近期历史，确认 `prompt` 为 **五元素原生元组**，而不是旧测试模拟的三元素元组；提交标记在原生 `extra_data` 字典的直接字段中。
- 脚本只输出结构布尔值与队列数量，绝不打印历史的实际 prompt、节点图、提交 marker、ID 或媒体内容；全部请求均为 GET。
- 未发送 `POST /prompt`、`POST /interrupt` 或远端取消请求。本轮未执行实际运行中的 GPU 中断验收。

## 本地 scoped cancel 源码核查（只读）

同一正在运行的 ComfyUI 0.45.0 安装目录 `ComfyUI/server.py` 中，`/api/jobs/{job_id}/cancel` 按特定 ID 返回 `{\"cancelled\": boolean}`，在运行态调用队列的 `interrupt_if_running(prompt_id)`，排队态只删除该 ID。源码还表明 `GET /queue` 的五元素任务元组会保留前五项，刚好包含本轮安全对账所需的 ID、Graph 与 extraData。此为源码验证，不代表已经实际打断一个 GPU Job。

只保留该接口明确回执作为取消成功的证据；无目标或无返回值的全局 `/interrupt` 不能等同于按任务确认取消。

## 已发现及修复的问题

### 1. 真实历史元组与旧对账程序不兼容

之前 `comfy-v2-adapter.mjs` 的 `reconcile` 将 `historyEntry.prompt[1]` 当作工作流图、`[2].extra_data` 当作提交标记。真实 ComfyUI 0.45 的结构是：

```js
[queueNumber, promptId, compiledGraph, extraData, outputsToExecute]
```

旧代码会将 **promptId 误读为工作流图**，即使找到了正确 ID 也无法核实原任务。

本轮改为只接受带完整 ID、冻结 Graph 与随机提交标记的原生元组，复读原有 `job_attempts` 的客户端身份。发现形状、图、marker 或 client 身份不符都不能恢复 Job。旧单测同步使用实际协议形状。

### 2. 运行中的任务尚未进入历史

当 `/history/:prompt_id` 尚未有记录时，新增 `GET /queue`：只有相同 ID 的活动/等待项**同时满足冻结 Graph + 原提交标记 + 客户端身份证据**才可以被认定为 `pending`。队列中没有此项或证据不一致，保持 `submission_unknown`，不得重新发送 `/prompt`。

### 3. 无 prompt_id 的人工发现与恢复

为已有项目级 `POST /api/v1/projects/:id/jobs/:jobId/reconcile` 增加**可选** `remoteTaskId`。明确传入 ID 保留旧行为；提交空 JSON 必须是用户主动点击的只读发现动作：

- 服务端先核对当前 Project 与 Job 的 `submission_unknown`、原始提交栅栏、冻结图、Comfy 适配器和无活跃 Lease。
- 对正确的本地实例执行 `GET /queue` 与有上限的 `GET /history?max_items=16`，只读取远端证据，不自动提交生成。
- **恰好一个**原始身份与冻结内容匹配的远端 ID 才进行第二次 `reconcile` 核验，再以原子 SQLite 事务恢复 `running / collecting / failed`。
- 找不到匹配项返回 `remote_candidates_absent`；多个匹配项返回 `remote_candidates_ambiguous`，都保留未知状态。这些结果不能用来证明原始请求未被执行，且历史窗口只覆盖最近 16 项，可能遗漏较早任务。
- 任务历史 UI 允许留空 prompt_id，显示“只读查找远端并核实”。远端只读；**本地 Job 状态在核对成功后可能更新**。旧输入 ID 的准确核对入口仍保留。

### 4. 旧版取消接口不能宣称远端已停止

旧 ComfyUI `POST /queue` 删除请求返回无目标回执的空 JSON；即使随后的队列和历史都没有该任务，仍有运行/落历史的竞态。

现在这种情况下返回 `comfy_legacy_queue_delete_unconfirmed`，**不将 Job 标记成 `cancelled`**；只在带指定 ID 的 `/api/jobs/:prompt_id/cancel` 返回明确 `cancelled:true` 时继续原先的确认取消事务。始终禁止使用会误伤其他任务的无作用域 `/interrupt`。

## 验收与边界

- `server/backend/comfy-v2-adapter.test.mjs`、`job-coordinator.test.mjs`、`project-job-history.test.mjs`：**51 项后端专项通过**。
- `src/features/backend-sync/canvas-job-history.test.tsx`：**18 项前端专项通过**。
- `npm run typecheck`：通过。
- 新测试包含：三元素旧假证据不再接受、真实五元素身份匹配、队列中进行中的唯一任务、提交结果未知时无 ID 发现、错误 marker 拒绝、多人候选拒绝、未知时不重复生成、旧队列删除不伪造取消、跨 Project/未授权拒绝。
- 这些是实际运行时只读协议探测 + 隔离 Mock/SQLite 事务回归，**不表示在真实 GPU 执行中实际成功取消了一个运行中的 MiniMax H3**。
- `/history?max_items=16` 的扫描有界且仅用于用户显式恢复；远端历史可能已清除、超过窗口或暂时不可达，此时必须保持未知。

## 下一阶段建议

优先使用**与正式用户任务隔离**的本地 ComfyUI 测试队列，验收真实作用域取消的能力与远端并发竞争。只有能证明接口作用域和确认结果时才允许将 Job 标记为已取消；绝不通过全局 `/interrupt` 强行完成验收。之后进入真实文本 Provider 的人物/故事一致性质量验收。

**用户要求延期**：费用金额硬上限、长视频和并发负载测试。
