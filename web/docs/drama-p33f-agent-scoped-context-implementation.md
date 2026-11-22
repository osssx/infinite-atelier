# P3.3f：Agent 只读上下文按范围取数（Schema v43 保持不变）

**状态**：2026-11-22。本轮实现并验证 Agent 只读上下文的紧凑图与索引条目读取。保留旧 Agent/Task 完整图冻结、审批、执行与回执路径。**并不意味着所有 Agent/Task 都已具备仅指针快照，也不代表 P3.3 全部完成。**

## 背景与本轮切入点

此前 P3.3a～e 实现 `creative_node_payloads`、SQLite 派生条目索引、单条／多条 CAS 和批次修订号。然而现有 Agent 只读工具仍在如下路径重复 `hydrateCreativeDocument`：

- `POST /api/v1/projects/:id/assistant/chat` 的 `getProject()` 默认还原**整个画布**；
- `assistant-agent-read-tools.mjs` 的会话创建和每次 `check()` 都扫描／还原所有创作正文；
- `canvas_get_map`、`canvas_get_connections`、`task_read_history` 只需要 ID、标题、连线、Task 事实，但此前仍会隐式加载其他正文；
- `creative_search` 中人物与资料检索只消费本轮授权的普通文本节点，历史实现却还原了所有创作节点。

上述路径在 200 节点、100 镜头、50 资产的画布上会进行不必要的正文 JSON 解析，也可能因某个**未授权且无关**的 payload 损坏导致正常 Agent 读取失败。

## 实现

### 1. Agent 只读 HTTP 起点使用紧凑图

在 `app.mjs` 中只针对 `agentReadTools===true` 的请求执行 `getProject(db,id,{compact:true})`，保留请求开始时的存在性校验和 revision。其他普通聊天、编辑、Task plan/execute、Skill、媒体生成路径继续按既有方式处理。不存在向模型自动扩展任何节点范围的行为。

`assistant-agent-read-tools.mjs` 中 `scoped()` 只读取并解析 `projects.document_json` 的紧凑图。保留服务端已冻结的 Task `contextPolicy`、当前用户 turn ID、项目 revision、Task owner、调用次数／字节预算、回放限制和事件审计；每次调用前重新确认项目 revision 与本轮冻结权限，不相信浏览器传入的节点 ID。

### 2. Agent 索引条目直读

仅当 `contextPolicy.scope==='selection'` 且请求选中**一个精确授权**的 `drama:assets`、`drama:episodes` 或 `drama:storyboard` 节点，并且请求含 `asset_id`、`episode_id` 或 `shot_id` 时，进入 `tryReadIndexedAgentEntry`：

1. 先校验已授权节点 ID、指针 `creativePayloadRef` 与请求字段组合，不接受伪造／越权 ID；
2. 根据当前草案或确认版本定位 v42 索引，用 `readPagedDramaScope(...,{entryId,limit:1,includeReferenceChoices:false})` 只取目标条目及摘要；
3. 仍由原来的 `canvasDramaAssetFields`、`redactDramaFields`、`safe`、`pageNodeBody` 进行脱敏与严格结果大小预算；不返回原始媒体存储键或未授权正文；
4. 镜头的 `shotNumber` 根据同一集内 `order` 和原 ordinal 排序计算，保持旧工具的 1-based 语义，允许按 `shot_id` 读取第 13、第 75 镜头而不获取前面的镜头文本；
5. `version:'confirmed'` 使用已有已确认历史版本索引，仍支持旧的可见确认稿来源；
6. 索引缺失或旧式内联内容回退到**仅被请求的授权节点**的原始读取器；`shot_number` 等原有复杂选择器也使用这一兼容路径。

`readPagedDramaScope` 新增可选 `includeReferenceChoices`（默认 `true`，旧页面和 API 行为不变）。只读 Agent 不需要编辑器候选资产列表，因此本轮按 ID 的镜头读取关闭该扩展查询。

### 3. 其他只读入口

- `canvas_get_map` 和 `canvas_get_connections` 只使用紧凑图、已授权节点集合及连接；概览模式不公开正文；
- `canvas_search_nodes` 仅对明确授权的节点搜索，创作正文关键字通过 SQLite 直接查询该节点的 `content`，无需把全部内容读到 JavaScript；未授权节点不会参与 SQL 搜索；
- `canvas_get_generation_settings` 只按需还原指定的授权节点，其余画布仍是紧凑连接信息；
- `assistant-creative-context.mjs`、`assistant-creative-materials.mjs` 只处理授权的普通文本节点，不再为整理人物／故事素材加载无关创作 payload。

**不会改动** `planAssistantCanvasStep`、`commitAssistantCanvasAttempt`、`assistant-task-step-gate` 的全图 `projectGraphDigest`、`actionDigest`、审批标记、模型绑定、Task 完成栅栏、单事务执行与可信 Step 回执。P3.3e 批量 CAS 也没有成为 Agent 的隐式未审批写入口。

## 兼容性、恢复与隐私边界

- 本轮不增减 Schema 表，也不迁移已有数据，沿用 v43。
- 每个 Agent read session 都绑定项目修订号；本轮后续 CAS 或用户编辑推进修订后，旧 session 在下一次工具调用前报 `assistant_agent_read_source_changed`。
- 已确认快照独立于可编辑草案；旧索引缺失时仅所请求节点回退，不会为修复资料而扩展授权范围。
- 隐藏节点即使缺失 `creative_node_payloads` 行，也不会阻断节点目录、授权条目、Task 历史和模拟 HTTP Agent 工具调用。
- 日志只保存工具名、引用 ID、摘要、大小与 revision 等事件元信息；模型输出不直接用于 Task 完成或媒体提交。
- 单轮最多 6 次只读调用、每次至多 4000 字节、单轮至多 12 KiB 的原限制不变；镜头大正文按 offset 分页而非截断成不完整 JSON。
- HTTP 测试使用 `createAssistantChatService` 的本地 mock，**不会请求真实在线模型**。

## 验收

`web/`：

```bash
npm run test:drama-p33
node --test server/backend/assistant-task-canvas-executor.test.mjs
npm run test:drama-p1
npm run test:drama-p2
npm run test:drama-p3
npm run test:drama-p1-browser
npm run typecheck
npm run build
```

新增 `assistant-agent-scoped-reads.test.mjs` **9 项**，并将其及原有 `assistant-agent-read-tools.test.mjs` 纳入 `test:drama-p33`：

- 200 节点、100 镜头、50 资产；未授权节点的 payload 被故意删除后，授权 manifest、连接、资产／剧集／镜头按 ID 的读取仍成功；
- 按 ID 读取目标镜头而不恢复前 74 镜头，保持正确的 episode、排序号、描述，以及大段正文分页、确认历史；
- 隐藏节点拒绝、overview 无正文、缺失索引仅选中节点回退、素材搜索不读取无关正文；
- CAS 修改后旧会话失效，无法使用旧冻结修订继续获取模型上下文；
- 完整 HTTP mock Provider：先调用 `canvas_read_nodes`，再返回最终回复，授权资产可见、隐藏资料不出现在任何模型请求中，Task Step 和媒体 Job 均未提交。

回归：`test:drama-p33` **95/95**、Agent/Task 冻结写事务 **18/18**、P1 **46/46**、P2 **74/74**、P3 **21 通过、1 个真实 ComfyUI 用例按既有配置跳过**，真实 Chrome **63/63**；TypeScript 和生产构建通过。

## 后续建议（P3.3g）

优先研究 Agent **冻结可验证的范围摘要 witness**：以授权节点、索引条目版本与依赖关系构建可验证的只读 scope digest，并与旧的 `projectGraphDigest`、Task actionDigest、审批及确认版本共存。**不得**简单以局部摘要替换现有全图校验：创建／删改节点、连接、资产 ID 采用、场次拆合、跨节点生成依赖仍需完整冲突判断与一次性提交。先增加「同一冻结 Step 多动作、多节点、被隐藏来源修改、跨重启对账」的真实回归，确认等价后再逐步缩小 `planAssistantCanvasStep` 的正文恢复工作量。

本轮未做 60 FPS 帧率基准，也未运行真实 GPU／ComfyUI 视频链。原 13 项用户工作树文件仍保持原状，不纳入本轮提交。
