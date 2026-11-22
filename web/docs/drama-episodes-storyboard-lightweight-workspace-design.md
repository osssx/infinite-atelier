# 剧集规划与分镜配置：轻量画布节点 + 按需最大化编辑器设计（v1）

状态：设计待实施，2026-11-22。作用域先限 `drama:episodes`、`drama:storyboard`；保持 `drama:assets` 既有行为，后续可复用容器。项目 `custom` 分支，设计基于当前源代码而非重写创作流水线。

## 1. 决策

**画布节点只承担识别、进度、有限浏览、单条轻量编辑与打开完整工作区；最大化面板才允许全量编辑、候选生成/采用、确认发布、分镜视频配置与镜头组操作。**

并非在现有 `DramaPipelineNodePanel` 上对大 DOM 设置 `display:none` 或只修改 `expanded` 布尔值：两者无法阻止组件挂载、上游解析、运行轮询与 React 闭包重建。

### 当前实现与热点（已查源代码）

- `web/src/pages/canvas/project.tsx` 的 `renderNodeContentPanel`（约 4424 行）：如果节点有 `creativePayloadRef` 则挂载 `LazyCreativeNode`；否则在画布节点内部挂载完整 `DramaPipelineNodePanel`。同文件 `renderNodePanel`（约 4196 行）为完整面板构造上游依赖、已确认分镜和图像/配置映射。
- `web/src/features/canvas-assistant/drama-pipeline-node-panel.tsx`（约 100–210 行）持有全部草案和确认态解析、上游素材列表、候选、版本、视频、影响检测等状态。剧集/分镜即使未点开最大化也有 **每 3 秒一次 `/drama-pipeline/runs` 轮询**（约 128–144 行）。
- 同文件约 221–240、327–385、720–732 行：已存在最大化按钮和 Ant Design Modal，但 Modal 归节点内组件所有，编辑器仍是相同 React 子树；`drama-episode-fields.tsx` 的非 expanded 模式仍生成剧情概要、事件、结尾、场次及引用字段，`drama-storyboard-fields.tsx` 的非 expanded 模式仍生成整套镜头字段。**现有“紧凑”只是布局紧凑，不是轻量渲染边界。**
- `web/src/stores/canvas/use-canvas-sqlite-store.ts`：项目初始 `GET ?creative=summary`，后端用 `creativePayloadRef` 挂载独立创作正文；`ensureCreativeNodesLoaded(projectId,nodeIds)` 会沿上游连线**递归加载祖先正文并写回整个 Canvas Store**（约 70–95 行）。这不适合作为每次打开卡片/只查看摘要的通用路径。
- 现有 `web/server/backend/creative-scope-reads.mjs` + `creative_scope_entry_index` 有按节点/剧集/场次/条目索引、`summaryOnly`、`entryDigests`、独立 Draft/Confirmed 和不可变历史。前端 `DramaCreativeScopeBrowser` 与 `DramaRevisionBrowser` 已有真实分页读取、按条 CAS 修改功能；应复用而非建立平行创作源。
- P3.4b 真实 Chrome 基线：200 节点/100 镜头/50 资产，RTX 3080 下平均约 91–106 FPS，但 P95 为 27–38 ms、未达严格标准；只拿这次拆分作为**优化假说**，必须通过 A/B 测量证明。

## 2. 交互形态

### 2.1 剧集规划节点（画布内推荐宽 340–420 px，高约 200–280 px，不随正文长度增长）

```text
┌ 剧集规划                    [草案] [↗ 最大化] ┐
│ 目标 12 集   已规划 10 集  待确认 2 集       │
│ 第 03 集 · 风暴前夜                         │
│  3 场 · 剧情概要前 2 行…                     │
│ [上一集] [第 03 集 ▼] [下一集]              │
│ [修改标题/概要]           [打开完整编辑器]   │
└────────────────────────────────────────────┘
```

- 默认只显示整体数量、确认/待处理状态，以及当前选择剧集的标题、场次数、摘要两行；无内容则显示引导文案。
- 节点内允许 *明确开启轻量编辑*：只编辑**当前集标题、剧情概要**；保存与取消分开，不能边输入边不断替换 `dramaDraft` 整个 JSON；**目标集数可在轻量区单独设置**但必须使用现有 meta 参数与冲突防护。
- 剧情事件、稳定 ID、场次拆分/合并、引用、目标时长、候选生成与采用、确认版本、依赖影响、历史版本，全部在最大化面板。
- 当前集选择是 UI 状态而非项目图语义；不把一行下拉操作算成图修订。选中集显示深链接：最大化时直接定位该集。

### 2.2 分镜配置节点（画布内推荐宽 360–440 px，高约 220–300 px）

```text
┌ 分镜配置                    [已确认] [↗ 最大化] ┐
│ 4 集 · 100 镜头 · 3 项待核对                   │
│ 第 02 集  [场次 ▼]       镜头 26/100          │
│ 中景 · 5 秒 · 客厅/日间                        │
│ 画面：主角推门进入客厅…（最多两行）            │
│ [前一镜] [后一镜]          [完整分镜 / 视频配置] │
└──────────────────────────────────────────────┘
```

- 默认使用确认版本；若存在未确认草案，应显式标出版本来源（**当前查看：已确认 / 草案**），绝不把草案伪装成已发布。
- 节点只显示选中集、场、镜头的场景/景别/时长/画面前 2 行，计数与待核对提示；不展开全部镜头列表，不渲染 100 个 `<details>`、原文引用矩阵或视频配置卡片。
- 轻量模式可以编辑**选中镜头画面描述和时长（可选景别）**，要以 `shot-draft`、`expectedDigest`、`operationId` 走**单镜 CAS**；场次迁移、场景绑定、角色、道具、运镜、对白、视频 Config、批量镜头组和生成候选只在大面板操作。
- 若用户希望更纯粹的节点，轻量编辑可由 `允许快速编辑` 全局配置关闭；第一阶段推荐只做只读摘要 + 打开面板，第二阶段才开放受控 CAS 轻量修改。

### 2.3 最大化面板

- 以页面级单一宿主（`CreativeWorkspaceHost`）渲染，在根 Canvas 视图之上，不挂在某个 `CanvasNode` 的 React 子树里；避免视区剔除时 Modal 卸载、React 多节点重复更新。
- 用接近全屏的抽屉或 Modal（桌面默认 `calc(100vw - 32px)` × `calc(100dvh - 32px)`，可选择中等宽度；支持 Esc 关闭、返回画布、自动焦点恢复），不让节点本身被临时重排。
- **剧集编辑工作区**：左侧集数/集列表与查找，中间当前集的标题/概要/事件/场次/引用，右侧版本/上游变化/候选结果及验证；不混入画布节点本体。
- **分镜编辑工作区**：顶部剧集/场次选择与确认状态；左侧按页虚拟化镜头列表，中间仅选中镜头表单，右侧参考资产与视频配置；`分镜表 / 视频配置 / 生成候选 / 影响和历史` 分 Tab。打开“视频配置”时再加载对应 chunk 和实际配置信息。
- 打开时默认聚焦节点中已选择的 `episodeId/sequenceId/shotId`；关闭后摘要刷新并保留同一选择，无需重新布局画布。
- 用户随时可以在大面板中保留草案。关闭前若**有本地未提交修改**提示“保存草案 / 放弃 / 继续编辑”；已完成 CAS 或已持久化的改动不得误报为未保存。候选生成或确认发布必须显式触发并保留现有门禁，关闭面板不得自动生成/确认。

## 3. React/数据架构

```text
Canvas Project Page
 ├─ NodeLayer -> Memo(EpisodeSummaryCard / StoryboardSummaryCard)
 │                 └─ Only small summary + selected page/entry, no editor imports
 └─ CreativeWorkspaceHost (one instance, page root)
       └─ React.lazy(() => import CreativeWorkspace)
            ├─ EpisodeWorkspace -> scoped pages + full editor on demand
            ├─ StoryboardWorkspace -> episode/sequence pages + selected shot
            └─ lazy tabs -> video configs / runs / history / dependencies
```

**入口及状态**：

```ts
type CreativeWorkspaceRoute = {
  projectId: string;
  nodeId: string;
  kind: "episodes" | "storyboard";
  episodeId?: string;
  sequenceId?: string;
  entryId?: string;        // episodeId or shotId
  tab?: "outline" | "shots" | "video" | "runs" | "history";
};
// In AtelierCanvasPage: state route or null; open/close via stable callbacks.
// Keep view selection separate from graph and from persisted creative draft.
```

**应调整的具体模块**：

1. 新增 `drama-node-summary-card.tsx`：只渲染摘要与按需页面选择，`React.memo`；不引用 `DramaPipelineNodePanel`、`DramaEpisodeFields`、`DramaStoryboardFields`、`DramaVideoConfigFields`，也不静态导入对应重型包。
2. 新增 `creative-workspace-host.tsx` 和按需 `creative-workspace.tsx`：页面级一例；最大化时才 `import()` 编辑器，销毁隐藏后的重型组件（先 flush/abort，再卸载）。避免“点击最大化之前就计算全体 `videoInputs`、`images`、`runPreviews`”。
3. `project.tsx` 的 `renderNodeContentPanel`：先对 `drama:episodes|drama:storyboard` 返回轻量 Summary Card，不再按 `creativePayloadRef` 分流到重量不同的两套 UI；完整 `renderNodePanel` 的计算回调仅在 Workspace 真正打开时运行，旧节点类型保持兼容。
4. `drama-pipeline-node-panel.tsx`：保留旧复杂工作流功能，但仅作为 Workspace 内部的完整编辑业务容器；更理想地后续拆为 `EpisodeEditor` / `StoryboardEditor` / `RunAndProductionTabs`。特别是 **运行记录每 3 秒轮询必须受 `workspaceOpen && tab==='runs'`（或存在 active run）门控**，取消隐藏节点的计时器与请求。
5. 取消把“查看一条摘要”映射为 `ensureCreativeNodesLoaded`。该方法会递归加载上游正文并合并到全局 Store；Modal 更合适使用请求级数据（局部 scope + 选定编辑正文），必要时再加载当前节点的完整 payload，且不把所有内容扩散到常驻节点 props。
6. 旧版导入/旧 `dramaDraft` 内联节点应有兼容回退；摘要服务端可在低频迁移/初次读取时解析旧数据，但不能在每次 React Render 中全量 JSON.parse。禁止仅为了显示摘要修改确认版本 ID 或覆盖历史。

**后端数据契约（优先扩展既有接口）**：

- 首选 `GET /api/v1/projects/:id/drama-pipeline/revision-scope?nodeId=...&draft=...&summaryOnly=true`：计数／分镜集场分组；读取当前选中剧集或镜头使用现有按页 `limit=1`、`entryId` 与 `episodeId`。
- 现有 `summaryOnly` 不包含剧集标题/分镜文字预览；如要一次请求填充多个画布摘要，建议增加**批量投影** `GET /api/v1/projects/:id/drama-pipeline/card-summaries?nodeIds=...`，只从 `creative_scope_entry_index` 和 `creative_scope_index_state` 读取 `COUNT`、`json_extract(entry_json,'$.title'/'$.synopsis'/'$.description')` 等固定截断字段，不把完整 `entry_json` 返回前端。批量限制、验权、独立项目范围、旧数据 fallback、`ETag`/版本戳按项目修订及草案/确认修订设缓存键。
- 提交轻编辑复用现有 `PATCH .../entry-draft`、`PATCH .../shot-draft`：严格 `expectedDigest`、`operationId`、主观测项目修订与原子事务；冲突时明确让用户重新加载此条，**绝不能用整个旧 `dramaDraft` 覆盖较新修改**。
- 大面板需要编辑整集事件/场次与确认时可暂时复用 `payload` 和 `confirmDramaVersion`，但在内存里只保留当前打开的编辑器数据；后续改造成局部剧集条目 CAS 更稳健。确认后的版本仍是不可变快照，需更新摘要和其他依赖见证。
- SSE `project` 事件或原有写入回调只做**摘要缓存失效**，不要强制从服务端重新取得所有正文。请求与关闭通过 `AbortController`/请求代次避免串页回写。

**轻量数据与状态模型**：

```ts
type CreativeCardSummary = {
  nodeId: string;
  kind: "episodes"|"storyboard";
  revision: number;
  draftCount: number;
  confirmedCount: number;
  current?: {id:string; episodeId?:string; title?:string; preview?:string;
             sequenceCount?:number; durationSec?:number; shotSize?:string};
  view: "draft"|"confirmed";
  status: "empty"|"draft"|"confirmed"|"stale"|"error";
  // No entire episodes, shots, references, video inputs, or run candidates.
};
```

`status` 必须来源于可信的已发布/草案版本及既有依赖检查，不要仅凭 `draft===confirmed`、前端展示数量推断上游一致性。对于尚未做依赖检查的情况展示“未检查”而非“已同步”。

## 4. 加载/渲染生命周期

| 时刻 | 允许加载/渲染 | 明确禁止 |
|---|---|---|
| 首次打开 200 节点画布 | compact graph + 可见摘要卡 / 少量合并 summary 请求 | 全量 100 镜头正文、编辑器 Chunk、全量候选和定时轮询 |
| 悬浮/移动/缩放 | 复用已有摘要、CSS transform/LOD、少量选择态 | 自动 hydrate 上游、每帧 JSON.parse/更新摘要、每帧拉取 |
| 切换选中集/镜头 | 只按 ID 请求 1 条（或 10 条列表页），取消过期请求 | 向全局 Canvas Store 写入整个分镜正文 |
| 点击最大化 | 创建页面级 Modal；动态导入编辑模块；逐需加载选定正文 | 先创建重型编辑 DOM 再移动到 Portal |
| 打开生成/视频配置 Tab | 加载对应代码和数据，启动该 Tab 必需的状态监测 | 未打开 Tab 也刷新所有镜头视频/运行信息 |
| 关闭最大化 | 确认本地草案安全，终止轮询/过期请求，销毁完整编辑器 | 自动确认、自动模型调用、在画布里遗留隐藏编辑 DOM |

## 5. 分阶段实施

- **P3.4b2 / P0 —— 纯摘要替换**：先改 `episodes` 与 `storyboard` 画布内容分流，创建不引入重型模块的摘要卡、标题/状态/计数、最大化入口；当前 UI 只读，不改数据写路径。保证卡片恒定高度与可见节点剔除。更新旧浏览器 E2E 中原本直接点击节点内“打开创作内容”的步骤。
- **P3.4b3 / P0 —— 页面级完整工作区**：把已有编辑器和历史/候选/视频功能移到页面级大面板，按需 `import()`，预设深链 selection；保存、草案、确认、重跑等走原来的 API/栅栏；关闭必须卸载高负载树。逐步解除 `DramaPipelineNodePanel` 与 CanvasNode 的直接依赖。
- **P3.4b4 / P1 —— 细粒度编辑与缓存**：在卡片增加仅两字段轻编辑；用 Indexed CAS + expectedDigest / operationId 做单条保存，完善编辑草案、并发冲突、版本切换/刷新；若实际证据表明摘要多请求过多，再加批量 Summary API。
- **P3.4b5 / P1 —— 性能 A/B & P3 兼容收尾**：同一 200/100/50 fixture、RTX 3080、2048×1152、DPR 1.25，分别记录旧版本和新版本的**生产构建**与开发构建，至少 3 次完整平移/缩放。添加 max 2–3 个真实模态工作流 Tab 压力场景；严格目标依然 `FPS>=58, P95<=18ms, P99<=33.4ms, longtask=0`。若达不到，不标记完成，使用 DevTools Performance/JS CPU profile 定位剩余热点。

## 6. 不可回归的行为与验收

- 内容：当前集标题/梗概、当前镜头画面/时长准确；未确认草案和确认版本严格区分；切到 A 集快速再切 B 集不发生旧响应覆盖 B。
- 编辑：单镜 CAS 只改被选中的 `shotId`，未选镜头、历史快照、媒体 Job/选中 Take 不变；独立编辑并发与过期 expectedDigest 均显式失败。保持生成前提示/权限/人工审核，不因新的简化按钮旁路。
- UI：画布 200 节点只出现可见的轻卡，不自动加载重型字段 DOM；至少验证缩放中重型组件实例数为 **0**，隐藏的大面板不残留监听器、轮询、编辑器 DOM；Esc、失焦、项目切换行为可预期。
- 业务：剧集目标集数、候选、场次拆分/合并与引用迁移；分镜确认、按集/镜生成、视频配置与镜头组依旧可用；版本历史、恢复、ZIP 兼容原有 P1/P2/P3 断言。
- 网络：首次载入保持 compact graph；仅展开卡片查看时不得触发 `payload` 全量请求；批量可见卡请求数受控；大面板关闭后停止 runs polling（不影响后台 Job 自有状态机）。
- 性能：从 `web/docs/drama-p34b-real-browser-performance-baseline.md` 的 RTX 3080 基准（P95 27–38 ms，GPU 平均 91–106 FPS）做可重复对比。展示组件/请求数量、网络传输量、GC 后堆内存、每轮 rAF 和长任务；收益未达到目标必须诚实记录。

## 7. 推荐实施优先级与边界

**推荐先做 P3.4b2 + P3.4b3（只读轻卡和真正按需挂载的完整编辑器），第二批再加入轻量编辑。** 因为直接在轻卡上加完整事件、场次字段，容易重现原有多项 React state 与滚轮阻断，抵消拆分的性能价值。生产版并不需要为此迁移 SQLite Schema；现有索引和 API 可先承载核心流程，若实测存在批量摘要 N+1 再新增最小聚合读接口。

本文件是设计，不代表代码已实施、FPS 已达标或任何线上模型已经验收。实施时必须保留原仓库里既有用户未提交更改。
