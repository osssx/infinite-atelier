# P3.3i：Agent Task 完整图校验重复读取消除与基线

日期：2026-11-22。前置 P3 真实 ComfyUI 验收：`web/docs/drama-p3-local-comfyui-live-acceptance-2026-11-22.md`，完整 P3 **6+16 项全部通过，0 跳过**。

## 问题与改动边界

P3.3h 已通过 SQLite JSON1 CAS 只更新已审批的安全创作字段，且不重写整个 `projects.document_json`。但原 `commitAssistantCanvasAttempt` 在同一 `BEGIN IMMEDIATE` 中先调用 `verifyAssistantTaskClaim`（完整图恢复 + SHA256 冻结校验 + Scope Witness 校验），随后又对同一个项目调用一次 `hydrateCreativeDocument`、重新计算 SHA256 并重复验证 witness。因此多做一次重复的完整图装载与校验。

本轮只对**同一事务内部的已验证图**进行复用，不移除任何必须的完整图审批栅栏：

- `verifyAssistantTaskClaim(...,{includeVerifiedGraph:true})` 在**有效 Claim lease、Step 原始 actionDigest、已审批冻结 Attempt、项目修订、`scopeWitness`、完整 `projectGraphDigest` 通过以后**，可选择性返回本次校验的 `verifiedGraph:{compact,document}`。普通调用默认不返回它，不能作为任意后续事务的可缓存授权。
- `commitAssistantCanvasAttempt` 在同一 `writeTransaction`／`BEGIN IMMEDIATE` 中显式请求该图，确认 Step 的 `preconditions_json` 与 Attempt 的 `frozenSnapshot.preconditions` SHA 一致后，再直接复用已验证完整图。若 Step 条件在 Claim 后被篡改，拒绝为 `assistant_step_action_changed`，**不执行局部 CAS、无 Project revision 和可信回执**。
- 此优化减少最终提交阶段**一次完整图恢复 + 一次完整图 SHA256 + 一次 Scope Witness 计算**，不会改变项目规划、显式审批、Claim、最终 Commit 以及跨重启恢复各阶段独立所需的完整图校验。跨事务不可复用已验证图。
- P3.3h 的 JSON1 局部提交后，**仍然从持久化 SQLite 恢复提交后的完整图，并与冻结的 `expectedPostGraphDigest` 对比**；故障时仍在同一事务回滚。

## 可重复本机 200 节点／100 镜头基准

新增 `web/scripts/drama-p33i-task-benchmark.mjs`：

```bash
cd web
node --expose-gc scripts/drama-p33i-task-benchmark.mjs 12
```

测试每轮都在独立磁盘 SQLite 中建立项目，200 节点／50 资产／4 剧集／100 镜头、3 个已批准动作（资产、剧集、分镜），分别计时项目创建、冻结规划、审批、Claim、Task 单事务 CAS、关闭重开 SQLite 并运行启动恢复。自测后删除临时文件；没有 ComfyUI/GPU/在线模型调用。输出分阶段中位数、P95、min/max、以及**各阶段结束时采样的** RSS/heap 上限（不等于同步峰值内存，也不代表画布渲染帧率）。

### 本轮两次 12 轮实测

| 阶段 | 修改前中位数 | 修改后中位数 |
|---|---:|---:|
| 初始化+项目建立 | 454.460 ms | 434.920 ms |
| 规划冻结 | 132.855 ms | 141.494 ms |
| 审批 | 119.970 ms | 122.106 ms |
| Claim | 124.722 ms | 129.851 ms |
| 单事务 Commit | 141.954 ms | 146.385 ms |
| SQLite 重开+恢复 | 2.136 ms | 2.059 ms |

**审慎结论：代码上已消除重复完整图校验，但本次磁盘 SQLite 12 轮结果波动覆盖了这项优化，在整个 Task Commit 的耗时上尚未测到稳定的可量化收益。** 不把这两次测量宣称为加速百分比或 P95 SLA。观测到的最大阶段结束 RSS 约 98–99 MiB，但并非内存峰值。CPU/GPU 并行任务、Windows 文件缓存与 SQLite 写盘会改变结果。

## 正确性回归

在 `assistant-task-scoped-patches.test.mjs` 新增：

- 默认 `verifyAssistantTaskClaim` **不返回**完整图；显式选项只在正确冻结 Attempt、Claim lease、完整图 digest 和 Witness 通过后返回真实的 200 节点图；伪造租约失败。
- 真实 prepared Claim 之后直接修改 Step 的 `preconditions_json`，最终提交不能借用先前验证的图来冒用新冻结条件；异常不提升项目 revision，不改变资产草案，无可信 receipt。
- 先前 P3.3g/h 测试继续覆盖 200 节点跨任务 CAS、来源变化、审批篡改、重启、回执异常全回滚、全局 digest 与镜头组素材隔离。

**本轮实际回归：** `npm run test:drama-p33` **142/142**，Task Claim/lease **11/11**，P1 **35 项 Node + 11 项 Vitest**，P2 **74/74**，真实 ComfyUI 打开开关的完整 P3 **6 项 Node + 16 项 Vitest，0 项跳过**，真实 Chrome **64/64**（在线模型 POST 为 0），`npm run typecheck` 和 `npm run build` 均通过。Vite 仍有已知的大 chunk 与静态/动态导入冲突警告，不影响成功。

没有 Schema 迁移，继续 v43；保留用户原有 13 项未提交改动。剩余工作是更大样本且环境隔离的 CPU/IO 火焰图、200 节点画布 60 FPS 测试，以及真正的 MiniMax H3 权重推理验收；不能将 P3 EmptyImage 视频测试替代该模型验收。
