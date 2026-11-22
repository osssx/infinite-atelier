# P3.3a · 独立创作正文的 SQLite 范围分页与画布懒加载

日期：2026-11-22。实施阶段：P3.3 第一部分。严格区分「服务端范围分页已上线」与「全链路仅指针写入完成」。

## 现状与本轮工程改动

原有数据库 `creative_node_payloads` 与项目存储 Trigger 已把四种创作节点正文从画布图中迁出。画布保留 `metadata.creativePayloadRef`；前端已有 `ensureCreativeNodesLoaded` 逐节点懒加载，编辑/Agent/任务提交仍可按需恢复整份上下文。历史 `canvas_text_versions`、`drama_runs`、CAS 引用、ZIP 导入导出与旧版字段保持双读写；不改变 SQLite Schema 版本（当前 v41）。

**发现问题**：旧 `readDramaRevisionScope` 内部调用 `readNode`，其中会 `hydrateCreativeDocument` **所有**创作节点；随后完整 JSON 反序列化，最后才做 JS `filter/slice`。虽然 HTTP 返回范围有限，后端仍为查看少量镜头读取整份结构。

**本轮实现**：

- 新增 `server/backend/drama-scoped-storage.mjs`：仅通过 SQLite `json_each` 找到目标节点、按 `projectId + nodeId` 取对应存储正文或独立历史版本；在 SQLite JSON1 中按剧集、场次、offset/limit 筛选，最终只将请求页条目反序列化为 JavaScript 对象。兼容旧项目内联 `dramaDraft/dramaConfirmed`、旧版带 Markdown 代码围栏 JSON、确认版本 ID 和最新草案。
- `readDramaRevisionScope` 保留原 API 与返回结构，但分镜、剧集、资产走新的 SQLite 范围路径；故事原文段落暂保留旧文本路径，不改动自动对齐/段落替代链。
- 返回完整索引摘要 `groups`（每集镜头总数及场次列表）、`total`、一页 `entries`、一页 `entryDigests` 和按需关联资产选项。summaryOnly 不再加载资产详情；全体条目 ID 唯一性在 SQL 中检测，防止分页外的冲突被遗漏。错误指针 fail-closed，缺失版本返回 404。
- 逐镜编辑继续通过 `PATCH .../shot-draft` 与 `expectedDigest` 乐观校验；该写入路径尚未改为直接更新单个 SQLite 条目，以保留当前完整的资产与剧集引用验证、事务回滚和历史保护。
- 新增 `src/features/canvas-assistant/drama-creative-scope-browser.tsx`：资产和剧集紧凑节点显示按需浏览按钮；折叠时不请求任何创作正文；展开时一页 10 条，支持切换已确认版本/当前草案。仍可单独点击「打开创作内容」恢复编辑器；分镜节点继续复用原有 `DramaRevisionBrowser` 的按集/场/页浏览。布局和主题使用已有节点风格。

**不能夸大**：SQLite JSON1 仍需扫描存储的 JSON 数组，Node 进程仍取得一份创作字符串并传入 SQL，尚非独立每镜头行索引/随机访问；该优化主要避免前端全量传输和后端 JS 全量对象恢复。画布持久化的摘要除指针外尚未具备单独的 materialized index；完整编辑器、Agent 生成输入、自动保存和历史 ZIP 仍需要经过旧全正文兼容路径，因此**没有开启仅指针编辑写入**。

## 验证与防回归

在 `web/` 执行：

    npm run test:drama-p33
    npm run test:drama-p1-browser
    npm run test:drama-p1
    npm run test:drama-p2
    npm run test:drama-p3
    npm run typecheck
    npm run build

新增测试 `drama-scoped-storage.test.mjs`：

1. 200 节点 / 100 镜头 / 50 资产：按集、场及 offset 精确读取 5 个镜头，完整 `groups` 正确，返回体小于原 JSON 十分之一；画布持久图仍只有指针。
2. 冻结的确认版本不被新草案污染；在另一集编辑一个镜头后，其余镜头、历史版本和冲突检测保持不变。
3. 资产/剧集的单独分页、按 ID 选择、历史版本 404。
4. 兼容旧版内联正文和代码围栏 JSON；无效指针拒绝；分页外的重复镜头 ID 拒绝。
5. 真 Fastify 授权接口：无权限 401，正常响应只包含选中页。
6. 既有 `canvas-text-versions.test.mjs`、P1/P2/P3、真实 Chrome+ZIP 验证不回退。Chrome 新增对两类紧凑节点的实际「按需浏览」操作及独立内容计数验证，验证在打开完整编辑器前即可使用。

## 后续 P3.3b 的实施门槛

1. **单条目持久化与轻量摘要**：独立镜头/场次/资产行或等价索引，存储 `scope + id + revision + digest`；节点存轻量摘要，读单场不要先拷贝整份 JSON 字符串。必须在一致的事务里更新草案、确认版本、摘要及依赖快照，并保留旧 JSON 迁移/回退。
2. **编辑器与 Agent 切换**：逐集/场分页的编辑工作流、批量和跨场事务，Agent 上下文只在需要时按 scope 冻结完整输入；在无需全量正文时，不触发整节点 `ensureCreativeNodesLoaded`。每条入口纳入 CAS/Job 快照、同集人工冲突、复制恢复、ZIP、旧版指针兼容回归。
3. **仅指针写入**：在新旧双路径输出及哈希对照通过后，在项目保存链路启用 `only-pointer`。绝不允许画布上两份不同的草案或因压缩省略而丢数据。
4. **容量/性能与运营排查**：200 节点、100 镜头、50 资产下滚动、平移、缩放、4 MiB 上限及 ZIP 限制，P3.4 独立验收。真实 ComfyUI 首尾帧、接续尾帧、跨重启批量任务仍待运行环境验证。

本轮不发起模型或 GPU 视频任务，不重启正在运行的用户后端，保留原有未提交文件。
