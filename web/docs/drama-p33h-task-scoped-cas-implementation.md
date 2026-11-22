# P3.3h：已审批 Agent/Task 的局部 SQLite CAS 事务执行

实施日期：2026-11-22；分支 `custom`；承接 P3.3g 的 `scopeWitness`。本轮**真正接通 Task 的局部写入**：纯内容白名单的批准 Step 可在原 SQLite 事务中对权威 `creative_node_payloads` 使用 JSON1 CAS 更新；`projects.document_json` 保持不变，项目 revision 只前进一次，Task Step、Attempt、事件及可信回执和数据一起提交。**仍然保留完整图规划与审批、完整图来源摘要校验以及执行后对批准的完整图结果摘要校验。**

## 决策与安全边界

现有 `planAssistantCanvasStep` 冻结完整图 `projectGraphDigest`、`actionDigest`、P3.3g 的 `scopeWitness`、Task 来源、Run binding、模型授权／媒体授权、依赖引用和用户审批；`commitAssistantCanvasAttempt` 在一个 `BEGIN IMMEDIATE` 事务里修改整个画布、项目 revision、项目事件及 Task/Attempt 回执。

本轮不提供绕过审批的外部任务执行入口，也**不**拆成多个 P3.3e HTTP batch 请求。只在全部动作都满足下述限定时，改变同一个已验证 Step 的存储写入方式：

- `patch_drama_asset`：资产或单个 variant 的 `name`、`description`；
- `patch_drama_episode`：`title`、`synopsis`、`ending`；
- `patch_storyboard_shot`：`description`、`shotSize`、`camera`、`action`、`dialogue`。

一批最多 16 项，可涉及多个节点，或同一节点的多个**不同父条目**。同一资产／剧集／镜头父条目重复修改、资产 `sourceRefs`、剧集 events／eventItems、镜头角色／道具／场景链接、身份变更、场次拆合、跨节点边、创建删除节点、混合其他 Canvas 操作，一律继续原有完整图事务执行。

**选中优化的额外前提**：节点必须是标准 `creativePayloadRef`，当前草案必须是规范化 JSON，条目索引已建立、索引 ID 唯一、每个冻结条目与权威索引内容一致，并且 `applyFrozenAssistantCanvasPlan` 完整图预览与仅应用本次字段补丁得到的实际最终节点元数据一致。比如旧剧集编辑时需通过 `normalizeEpisodeEvents` 补齐 `eventItems`，就自动回退到原完整图写入，不允许 SQL 跳过原逻辑。

## 新模块及冻结计划

新增 `web/server/backend/assistant-task-scoped-patches.mjs`：

- `freezeAssistantTaskScopedPatches(db,projectId,compact,original,preview,actions)` 在原完整图预览已经验证后计算：每条目标在计划时的条目摘要 `expectedDigest`，以及整个**批准后的完整图摘要** `expectedPostGraphDigest`。冻结描述符仅包括节点 ID、条目 ID、白名单种类、可选 variant ID、摘要，不存储或复制正文；限额 4 KiB，超额就按原完整图方式处理。
- 把冻结描述符 `scopedPatches` 附加到原 `assistant_task_steps.preconditions_json`。不改变已有的 `action_json`、Task plan/version/approvals／Agent binding／完成栅栏；旧 Step 不含此属性继续按原路径执行。
- `applyAssistantTaskScopedPatches` 只能由 `commitAssistantCanvasAttempt` 在其**已有 SQLite 事务内**调用。对每条资产和剧集调用 `applyDramaEntryDraftWithinTransaction`，对镜头调用 `tryPatchIndexedShotDraft(...,{deferProjectCommit:true})`。原 CAS 的当前条目摘要、上游素材引用、同节点全部条目形状和 SQLite JSON1 权威内容匹配检查没有被绕开。
- Task 的**幂等性权威仍然是已经提交的 Step／Attempt 回执**，不创建新的 `drama_scope_batch_operations` 用户操作记录，也不新增模型或媒体任务。

## Task 单事务提交

执行器继续严格检查批准状态、项目 revision、`scopeWitness`、`projectGraphDigest`、冻结动作 SHA、Claim lease、依赖 Step 可信回执、Agent Run 输出签名、故事审阅与视频授权，均通过后才进入局部写入分支。

局部分支在同一个 `BEGIN IMMEDIATE`：

1. 依照冻结动作顺序调用 JSON1 CAS 修改目标草案条目，v42 索引触发器同步更新，每个被修改的创作节点 payload revision 设置为即将生效的项目 revision；
2. **只更新 `projects.revision`**；不 UPDATE `projects.document_json`，保持未选中图节点、连接、手工 Config、视频产物和历史确认独立不变；
3. 从该紧凑图按原有映射恢复**写入后的完整图**，再次 `validateProjectDocument`，并与规划阶段冻结的 `expectedPostGraphDigest` 严格比较。若存在任何 JSON 序列化、事件修正、身份或引用语义不一致，则**整笔数据库事务同步回滚**，不会产生成功回执；
4. 仅在验证成功后生成**一次项目变更事件**，写入原 Task Step receipt、Attempt succeeded、Task 状态与完成日志；新回执可选附加 `executionPath:'scoped_cas'` 供审计。原 `scopeWitnessDigest` 和 `projectGraphDigest` 仍保留。

不符合白名单的 Step 依旧通过 `applyFrozenAssistantCanvasPlan` 完整图写入。现有 `recoverAssistantCanvasTasksAtStartup` 不改动，准备状态下的 Step 在重启后重新通过 scopeWitness／完整图保护再执行。跨重启重复 HTTP／Task 执行仍只会读取已提交可信回执，不能二次修改草案。

## 测试与验收

新增 `web/server/backend/assistant-task-scoped-patches.test.mjs`，加入 `npm run test:drama-p33`。测试采用本地 SQLite 与 200 节点、50 资产、4 剧集、100 镜头的数据：

- 三节点、三种合法字段修改，单次审批、单事务，`projects.document_json` 字节不变、revision 仅加一、单事件、单可信 Step receipt、一次 Attempt；其他 49 项资产、3 集剧集、99 镜头全部保持；
- 同一个资产或分镜节点的不同父条目可一次提交；重复父条目必须走旧路径；
- **安装 SQLite `BEFORE UPDATE OF document_json` 的拒绝触发器**后，已批准 CAS Task 仍成功，直接验证优化确实没有写入整图；
- 旧格式、缺失索引、需补齐 eventItem、`sourceRefs` 或其他画布混合操作都走完整图分支；
- 冻结后的 `expectedPostGraphDigest` 或一个条目摘要被篡改会整笔回滚，无半提交、无虚假回执；
- 手动在回执写入前抛错，项目、节点 payload、索引与事件一起回滚；
- SQLite 实际文件重启、prepared Claim 释放、再执行一次、重复请求返回已有回执；
- ZIP 导出导入后保留局部草案、已确认的旧镜头版本、独立 Config 和 Task 历史记录；不复制不存在的业务授权。

验收命令：

```bash
cd web
npm run test:drama-p33
npm run test:drama-p1
npm run test:drama-p2
npm run test:drama-p3
npm run test:drama-p1-browser
npm run typecheck
npm run build
```

测试均采用本地模拟和隔离数据库，真实 Chrome 不向在线 Provider 发请求；真实本地 ComfyUI 跨重启生成验收在没有工作实例时仍按既有配置跳过。未改 Schema（沿用 v43），不改旧 ZIP 格式、不触碰现有 13 项用户未提交文件。

**本轮实际结果：** `npm run test:drama-p33` **140/140**；P1 35 项 Node＋11 项 Vitest 通过；P2 **74/74**；P3 5 项 Node＋16 项 Vitest 通过，1 项真实 ComfyUI 因未启用实例而跳过；真实 Chrome **64/64**，模拟模型 `onlineProviderPosts=0`；`npm run typecheck` 与 `npm run build` 均通过。生产构建仍有原有 chunk 较大及动态导入无法独立拆包的警告，未影响成功。未执行 200 节点 60 FPS 基准和真实 GPU 视频生产。

## 后续建议 P3.3i

当前**读取侧**已经可按需查询，**已审批纯内容写入侧**已经不再重新保存整个图；但安全审查还要求在规划和最终来源栅栏阶段还原完整图。下一轮可以通过有界的增量摘要索引和来源校验证据研究降低该部分 CPU/内存成本，同时对实际 200 节点／100 镜头的冻结规划、审批、CAS 提交和冷启动建立可重复的耗时与峰值内存基线。不可凭局部 SHA 一致就提前撤掉 `projectGraphDigest`，也不得把复杂的资产合并、场次拆合和媒体参考图编辑迁入这一白名单。

不宣称已完成真实 ComfyUI 生成，或已验证 200 节点 60FPS。
