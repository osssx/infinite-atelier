# P3.2f：镜头组异常恢复、显式重试与前镜成片冻结

实施日期：2026-11-22。项目：Infinite Atelier，`custom` 分支。P3.2f 聚焦既有 Shot Group 的真实故障与恢复，不另建模型任务状态机，也不修改在线渠道。

## 审查发现的真实阻断

`shot-groups.mjs` 原 `resume` 仅接受 `status="blocked"`、且**没有 `jobId`** 的批次项；真实 Job `failed` 或 `cancelled` 后，原始批次项保留 `jobId` 和创建时的 `queued` 快照，`list()` 虽可从权威 `jobs` 表显示失败，但 `resume` 永远跳过该前镜。原浏览器 `changeShotBatch("resume")` 同样只选择无 Job 的 blocked 项。因此**前镜故障无法从原批次直接重试**，连续后镜只能持续暂停。

原 `shot-${sha256(batchId,shotId)}` 幂等键对每镜永久固定；若直接移除 `jobId` 再提交，会读到原失败 Job 的不可变回执或产生 request fingerprint 冲突，不能解决故障。把所有错误都当可重试同样危险：`submission_unknown` 可能已经成功提交到远程 Comfy，自动重放会产生重复计费或占用 GPU。

另一个保护缺口：当用户改变前镜在画布上选定的 `shot.take` 时，未提交的连续镜头如果没有显式绑定 `item.take`，此前仅验证镜头顺序、绑定结构，没有冻结前驱成片选择摘要；会沿用旧 Job 输出。

## 修改范围与正确性

更新 `web/server/backend/shot-groups.mjs`：

1. **显式终态重试**：`POST /api/v1/projects/:id/shot-batches/:batchId/actions`、`action="resume"` 在单 SQLite 写事务里复核权威 Job 终态，只允许原 Job 为 `failed` 或 `cancelled` 时重新创建。没有 Job 的 blocked 下游只恢复为 waiting，不触发不需要的 GPU Job。无用户请求时不会自动重试。
2. **不确定结果绝不重放**：`submission_unknown`、`queued`、`submitting`、`running`、`collecting`、`blocked_credential` 不被重试。历史已成功镜头、其产物、Job ID 和旧 request key 全部保持原样。
3. **每次重试新的幂等键**：首次提交继续复用原 `sha256(batchId,shotId)` 算法；只有确定失败后，使用包含服务端 `retryCount` 的新请求键（最多 20 次明确重试）。服务端严格控制 `retryCount`、`retryFromJobId`，拒绝客户端伪造状态／Job ID／尾帧／重试历史；重新进行 Project revision、source fingerprint、Comfy 节点和组结构校验。
4. **不可变来源证据**：每个已重试 Job 的 frozen `snapshot_json.localShotRetry` 包含 `batchId`、`shotId`、`retryCount` 和 `retryFromJobId`；原 Job 保留，审计可沿 Job 快照追溯，不复写旧 Comfy 回执。
5. **前驱选定成片变化保护**：首次创建 waiting/choose 镜头时冻结 `predecessorTakeDigest`；下一次真正提交前验证。前镜用户换成片会把相应未提交的下游转 blocked（`shot_group_changed`），只有用户重新检查后才会根据新的前镜选择重新冻结并尝试提交。已经提交或完成的独立镜头不倒回。
6. **前端恢复入口**：`canvas-shot-panel.tsx` 允许失败或已取消的镜头显示「重新检查并继续」，显示重试次数及上一 Job ID；`project.tsx` 预检范围包括安全终态失败原镜和 downstream blocked，排除 `submission_unknown` 前镜作为有效可接续来源，避免无意义重试循环。

所有重试都由原 `submitJobInTransaction` 在现有数据库事务中完成；SQLite 锁和全局 Job 活动栅栏不变。未添加任何自动远程 `/prompt` 重提行为。

## 单元回归

`web/server/backend/shot-groups.test.mjs` 补充：

- 前镜注入明确失败，独立镜头标记成功，连续分支阻断：显式恢复只创建一个新前镜 Job，旧失败 Job 和独立成功 Job 均不变；重复点击重试不会新增 Job；前镜物化成功后提取对应实际尾帧并只创建一个下游 Job。
- 对 `submission_unknown`／`queued`／`running`／`collecting`／`blocked_credential` 逐项验证不能通过 resume 创建第二个 Job。
- 用户请求中的 `retryCount=99`、假 Job ID、伪造尾帧和 completed 状态不能改变服务端审计；新 Job 快照持久记录真正的上轮 Job。
- 修改前镜在组内选定的成片后，未提交的连续后镜因冻结证据变化暂停；手动 resume 才能采用当前成片继续生成。

## 真实 ComfyUI 故障恢复端到端

运行时本机 `http://127.0.0.1:8188` 使用真实 `EmptyImage → CreateVideo → SaveVideo`（64×64，3 帧，8 FPS），由真实后端 Comfy adapter／SQLite／CAS／物化器／FFmpeg 完成视频与尾帧处理。无需权重推理和在线模型请求。

测试 **`P3.2f real local Comfy: pre-submit failed predecessor resumes after two backend restarts; independent Job never repeats`** 的实际步骤：

1. 用不启动 Worker 的 Atelier 后端、一个有本地 Comfy 的同配置镜头批次，先在 SQLite 中预置 `a` 和独立 `c` 的 Job，`b` 等待 `a`。**只对尚未提交远程 `/prompt` 的 `a` 注入确定性 `failed`**；旧 `upstream_task_id` 必须为 NULL。关闭并打开 SQLite。
2. 第一次以真实自动 Worker 启动后端：独立 `c` 真实提交到 ComfyUI，生成视频并物化；`b` 只因前镜失败进入 blocked；证据为两个原始 Job，没有重提 `a`。
3. 停止 Worker，调用真实本地带会话与 CSRF 的 `POST /actions`，显式恢复 `a,b`；确认 `a` 获得新的 Job ID 和新幂等键、`b` 仅恢复 waiting、`c` 保留原 ID。此时共 3 个 Job。
4. 第二次关闭并打开后端：真实 ComfyUI 完成新的 `a` 和下游 `b`，由实际 FFmpeg 取得尾帧 PNG。断言全部三个镜头 completed、原失败 `a` 从未有远程任务 ID、数据库严格为 4 个 Job（旧失败＋新 `a`＋`b`＋`c`）、真实视频产物至少三条、下游 Job 的冻结 `externalInputs[0].assetId` 等于提取的尾帧 Blob ID。
5. 新旧请求键唯一，两个后端重启都没有重复发送独立 `c`，所有测试隔离 SQLite／CAS／临时目录按测试清理。

**界限：这是真实 ComfyUI 调度、编码、物化、末帧与后端重启的验收，但失败发生在首次 ComfyUI 提交前，通过本地 Job 状态故障注入实现。未伪称在真实 GPU 权重推理过程中制造失败；远程结果不确定时依旧禁止自动重放。** 已建立更难的故障场景：明确失败后的正确分支恢复、持久化幂等与归档审计。

**本轮最终验收结果**（`custom`，2026-11-22）：

- **真实 ComfyUI 的完整 P3：12/12 Node PASS、16/16 Vitest PASS，0 SKIP**。新加入的 P3.2f 双重重启故障恢复真实用例 **8,094.55 ms**，原真实三镜头连续生成测试 **8,398.34 ms**；均用真实 `http://127.0.0.1:8188` 服务，无网络付费模型调用。
- 额外回归：P1 **35 Node + 11 Vitest 通过**，P2 **74/74**，P3.3/Agent Task **142/142**，真实 Chrome **64/64**（在线 Provider 调用 0）；`npm run typecheck`、`npm run build` 成功。P3 测试仍会打印开发服务器 `localhost:3000 ECONNREFUSED` 的可忽略 stderr，但退出码为 0，所有测试通过。
- 新建批次收到伪造 `retryCount`／`retryFromJobId`／`predecessorTakeDigest` 时会忽略这些字段；仅在原服务端确认失败后才分配新尝试次数。独立镜头成功结果在单元和真实 Comfy 流程中均保留。

## 执行命令

```powershell
cd web
$env:ATELIER_TEST_LOCAL_COMFY='1'
npm run test:drama-p3
# 此命令必须 0 SKIP，包含两条真实 Comfy 测试
```

同时回归 `npm run test:drama-p1`、`test:drama-p2`、`test:drama-p33`、`test:drama-p1-browser`、`typecheck`、`build`。与用户原有的 13 项 dirty 文件互不影响。后续 P3.4a 仍需首帧、首尾帧及多参考图真实输入模式验收；不把本轮 Comfy `EmptyImage` 误作 MiniMax 权重推理。
