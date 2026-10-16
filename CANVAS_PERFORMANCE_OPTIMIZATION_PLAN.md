# Infinite Atelier 大规模画布性能优化设计

> 适用项目：H:\WebDev\infinite-atelier  
> 代码基线：本文件设计时的基线为 custom / `dbdd6079`。P0 落地于 custom / `2590f1a`（P0-A/B/C + 组件分层）与 `629a052`（节点回调改用 context）。  
> 性质：代码审查后的实施设计。**P0 已实现并合入；P1/P2 仍是待实施方案。全程未做浏览器性能实测**（见 §7）。  
> 范围：画布节点、连接线、视口、选中/拖拽/框选、媒体、缓存/持久化；不更改生图/视频 API 语义。

## 1. 目标和非目标

**核心目标**：数百至数千节点仍能稳定平移缩放、快速框选及拖动，同时保持节点资源引用、连线、组、撤销/重做、任务运行、项目恢复和自定义插件节点的行为。

目标使用标准化基准场景验收：在固定测试机、Chrome Stable、1440×900 画布、统一 DPR/硬件加速设置下采样，100/500/1000/3000/5000 节点、每节点平均 1.5 条连线、图片/视频/文本/配置/组混合。分别测试一般缩放（能看到约 100-300 个节点）和缩放到总览（可能同时看到数千个节点）。将**目标值与基线结果分开记录**，避免在没有实测时宣称已达标。

初始工程验收目标：1000/3000 节点且可见节点数 ≤300 的平移和缩放 p95 帧时长 < 20ms、尽量达到 60FPS；总览模式采用 LOD，目标中位帧率 ≥50FPS；单节点拖拽 p95 <20ms，框选 p95 <33ms。长期目标根据基线与 CI 测试机调整，不应在低端设备保证相同 FPS。无功能回退是硬门槛。

> ⚠️ 上段全部是**建议验收目标**。截至 P0 合入，没有 baseline、没有采样脚本、没有 Playwright，这些数字一个都没被验证过。任何总结只能陈述复杂度已降低，不得声称帧率/延迟达标。

非目标：第一阶段不迁移到 React Flow / WebGL，不重写生图/视频工作流，不把持久化格式直接换成新 schema。

## 2. P0 前的结构与已存在的问题

> 本节描述 P0 之前的代码基线。原文保留，因为 P1/P2 仍引用这些位置；每条后面补了 P0 之后的状态。

- web/package.json：React 19、Zustand 5、React DOM、Vite；画布不是 React Flow。**（未变）**
- web/src/components/canvas/atelier-canvas.tsx:21-35,148-190,210-253：DOM transform 实现视口，平移已按 requestAnimationFrame 合并更新，背景网格随缩放变化。**（平移与滚轮缩放均已合帧；滚轮缩放另修掉了批次内事件互相覆盖的问题，见 §7）**
- web/src/pages/canvas/project.tsx:701-712：基于 nodes.filter 的可见节点裁剪，安全边距 280 世界坐标单位；每次 pan/zoom 仍 O(N) 遍历。**（仍是 O(N)，但 memo 体内那次强制布局读取已去掉，改用 ResizeObserver 维护的 size）**
- web/src/pages/canvas/project.tsx:3059-3088：所有连接线全量创建 ConnectionPath（不裁剪）；每条 SVG 路径带透明点击路径。**（已修复：P0-B 按视口裁剪 + 逐边 memo）**
- web/src/components/canvas/canvas-node.tsx:77-113,284-294：React.memo + contain: layout style 已存在，应保留。**（保留）**
- web/src/pages/canvas/project.tsx:1234-1263：拖拽时每次鼠标事件先全表创建 previewNodes，再进行 group target 查询，下一帧再次全表更新 nodes；两处通过 initialPositions.find 查找，潜在 O(N×M)，M 为拖拽节点数。**（已修复：P0-C）**
- web/src/pages/canvas/project.tsx:1276-1304：框选每次 pointermove 全表遍历节点，并同步 setSelectionBox + setSelectedNodeIds；缺少帧合并。**（已修复：P0-C，rAF 合帧 + 集合变更判断）**
- web/src/pages/canvas/project.tsx:755-767 + web/src/lib/canvas/canvas-resource-references.ts:21-23,53-81：每次 nodes/connections 变化，针对所有节点重建 mentionReferences；内部又对 nodes 和 connections 线性查找/过滤，具有 O(N×(N+E)) 量级的风险。**（已修复：P0-A 改为邻接索引 + 按需计算）**
- web/src/pages/canvas/project.tsx:755-762：所有 Config 节点重建 generation inputs，也进行连接查询。**（已修复：P0-A）**
- web/src/pages/canvas/project.tsx:701-767,2947-3016：这些派生 Map 的变化令 renderPanel、renderNodeContentPanel 引用失稳，可能使可见 memoized nodes 额外渲染。**（已修复：两张表与两个 render 回调都已删除，面板改为自行按节点取数）**
- web/src/components/canvas/canvas-mini-map.tsx:15-48,115-132：每次节点更新重算边界；每节点渲染一个 div。**（仍存在，属 P1-C）**
- web/src/pages/canvas/project.tsx:530-549 + web/src/stores/canvas/use-canvas-store.ts:39-68,127-139：持久化已延迟写入（400ms），viewport 更新另以 500ms 合并；仍需观察大对象序列化和主线程占用。**（未改，属 P1-D）**
- web/src/lib/canvas/canvas-generation-helpers.ts:45-58：项目打开时 hydrateCanvasImages 会遍历所有节点并解析媒体 URL；web/src/services/image-storage.ts:18-38 缓存 object URL；媒体解码及内存预算需要单独管理。**（未改，属 P1-C）**
- web/src/components/canvas/canvas-node.tsx:605-615,637-694：可视节点直接挂载 video/img，没有预览资源的分辨率预算或 video preload 策略。**（未改，属 P1-C）**
- web/src/components/canvas/canvas-connections.tsx:9-88：连接线是 SVG Bézier 曲线，选中线段有 foreignObject 断开按钮，切换渲染器需要保留交互行为。**（交互保留；组件已 memo，回调改为传 id 以便 memo 生效）**
- web/src/types/canvas.ts:22-23,90-104：节点类型是开放字符串，可由插件扩展，必须保留插件节点完整 DOM 渲染能力。**（保留）**
- **（P0 审查时新增发现，原文未列）** web/src/components/canvas/canvas-side-panel.tsx:52：`CanvasSidePanel` 未 memo 且直接接收整个 `nodes` 数组。**（已由 `10c17e9` 修复；实测影响远大于当时的估计——见 §7「侧边栏：被低估的一项」）**

## 3. 分阶段实施

### P0（低风险高回报）：消除高复杂度热路径

**P0-A：一次性建立图索引，按变化局部更新。**

新增 web/src/lib/canvas/canvas-graph-index.ts（建议）：
- nodesById: Map<id,node>
- inbound/outbound: Map<id, connection[]>，以及 edgeById、groupChildren。
- 由现有 nodes/connections 在项目载入时构建；结构更新时增量更新，初始版也可一次重建索引但确保仅 O(N+E)，禁止针对每个节点重复全图扫描。
- getMentionReferences(nodeId) 与 getGenerationInputs(nodeId) 使用 adjacency + Map 获取邻居，并按连接原始顺序保留引用标签和选择优先级（尤其 Config 节点的输入/回退规则）。
- 大多数 UI 场景中仅为**已挂载节点**或已打开面板计算引用；输入变更时仅失效自身及有依赖的后继节点。
- renderNodePanel/renderNodeContentPanel 不得因为未关联节点的 metadata 变化而全量失稳；使用单节点订阅/稳定回调或独立面板组件。

> **落地情况**：已实现。`canvas-graph-index.ts` 导出 `buildCanvasGraphIndex`（单趟 O(N+E)，邻接表保持 `connections` 原顺序）+ `nodeById` / `connectionsById` / `inboundByNodeId` / `outboundByNodeId` / `groupChildrenByGroupId` / `groupChildCountById` / `neighborsById`。
> `canvas-resource-references.ts` 增加索引版查找（`getMentionResourceNodesFromIndex` / `getGenerationResourceNodesFromIndex` / `buildNodeMentionReferencesFromIndex`），三层回退与 Config「取第一条匹配出边」语义逐字保留；旧 `(nodeId, nodes, connections)` 签名保留为薄包装，供一次性调用方使用。
> 引用与生成输入改为按需计算：新增 `canvas-graph-context.tsx` 提供 `useNodeMentionReferences(nodeId, enabled)` / `useNodeGenerationInputs(nodeId)`，由面板组件（`canvas-node-prompt-panel` / `canvas-config-composer` / `canvas-config-node-panel`）自己调用；文本节点的引用只在**编辑态**才计算（抽出的 `EditableTextContent`）。`project.tsx` 里两张全节点 Map 与两个 render 回调已删除。
> **偏差**：索引是每次 `nodes`/`connections` 变化**整份重建**，没有做增量更新。理由是原文档也允许「初始版一次重建，确保仅 O(N+E)」；增量更新留给 P1-A 的空间索引一起做。

**P0-B：连接线裁剪**。
- 建立可见 edge 列表，而不是 JSX 中 connections.map 全量输出。
- 不可仅判断两个端点是否在视口：两端都在视口外的 Bézier 可能横穿屏幕。
- 利用控制点构建 Bézier 凸包 AABB 与 worldViewRect 做**保守**相交测试（不得漏绘），可先 O(E) 查询，后续接入空间索引；可见边加 viewport margin 防闪烁。
- 确保选中、hover、连接中 preview 的线段可见且点击/删除交互正常；选中线段 foreignObject 保留。
- 评估移除固定 SVG 10000×10000 和强制 translateZ(0) 的 GPU 合成成本；该改动应独立 A/B 检测，不要盲改坐标系统。

> **落地情况**：已实现。`canvas-connection-culling.ts` 提供 `connectionControlHull`（四个控制点的 AABB；y 方向恰为两端点跨度，x 方向必须取四点的 min/max，否则回环连线漏绘）、`worldViewRect`、`cullConnections`。
> 接入点：`canvas-connection-layer.tsx` 的 `ConnectionLayer`，margin 取 64 CSS px ÷ `viewport.k`，选中边通过 `keepIds` 始终保留。
> `ConnectionPath` 已 memo，回调签名改为传 connectionId（`onSelect(id)` / `onContextMenu(event, id)` / `onDelete(id)`），父级用 `useCallback([])` 提供，否则 memo 无效。
> **已实测（原为「本轮未做」）**：`CANVAS_BASELINE.md` §6.1 用输出不变的因果实验把这一项拆开测了——
> **移除固定 `10000×10000` 盒子：无收益**（−0.4%）；**移除 `translateZ(0)`：实测 −28.6%**
> （`zoom-general` p50 226.80 → 162.00，p95 −47%），且 pan/marquee/drag/idle 全部无回退。**`translateZ(0)` 已移除；盒子保留。**
> 未采纳的还有 `vector-effect="non-scaling-stroke"`（实测约 3.7%，在噪声内）。剩余唯一杠杆是视口裁剪，
> 仍需先设计坐标系统改动。

**P0-C：拖拽/框选热路径**。
- 将 initialSelectedNodes 改为 Map<id, originalPos>，使查找 O(1)，不再在循环内 .find。
- 拖拽状态在 pointer/mousemove 仅记录最新指针坐标，保证同一时刻最多一个待执行 rAF（取消再排队可能在高频输入下挤压绘制）；一帧最多更新一次。
- 组目标的预览检索只扫描预先索引的组候选，避免为每次鼠标事件构造整个 previewNodes。
- 同理框选以 rAF 合并 pointermove；无变化则不 setSelectedNodeIds；按需查询相交集合。
- 第一轮保留现有 setNodes 及 React 渲染提交方式，建立等价行为测试后再做 P1 拖拽 overlay/临时状态隔离。

> **落地情况**：已实现。`dragRef.initialPositions` 改为 `Map<string, {x,y}>`，拖拽开始时一次性快照 `movedNodes` / `reversedCandidateGroups`。
> 新增 `canvas-node-geometry.ts` → `findGroupDropTargetFromDelta`（用初始中心 + delta 直接判定，替代每帧构造整份 previewNodes 再跑 `findGroupDropTarget`），语义与原函数逐条对齐并有对拍测试。`handleNodeMouseDown` 里 O(N²) 的组内子节点扫描改用索引的 `groupChildrenByGroupId`。
> rAF 改用**合并**写法（`if (rafRef.current) return` + 最新 delta 存 ref），不再 cancel-再-排队；`finishNodeDrag` 仍会取消待执行帧并提交最终位置。`setDropTargetGroupId` 移入帧内并加变更判断。
> 框选同样 rAF 合帧，且仅在集合成员真正变化时才 `setSelectedNodeIds`。
> `getConnectionDropTarget` 改为倒序索引遍历（不再分配反转副本）+ `normalizeConnectionFromIndex`，优先级判定不变。
> **偏差**：`finishNodeDrag` 里拖拽结束那一次仍用原 `findGroupDropTarget` / `findContainingGroupId`（一次性 O(N×M)），没有一并改成索引版——每次手势只跑一次，不在热路径上。同理 `buildNodeGenerationContext` 里还留着一处 `nodes.find`。另外顺手修了两处原文档未列的问题：`currentProject` 选择器返回整个项目对象导致每个拖拽帧整页重渲染两次；`directorPanelNode` 每次渲染全表 `nodes.find`。

**P0-D：memo 和组件边界**。
- React.memo 不是单独的保证：只变化 viewport.k 或面板闭包时，不应重建全部可见重组件。
- 拆分 ViewportSurface（视口变换/背景）、NodeLayer、ConnectionLayer、SelectionOverlay、CanvasOverlays 和 CanvasProjectController。
- 将频繁变化的 hover/selection/pointer 状态局部化；保持拖拽回调稳定引用；配置面板与临时工具条从常规节点 DOM 中拆出并只挂载激活者。
- 不建议无测量地将所有状态一律转入 Zustand：应使用稳定 selector + 局部 state/refs，避免全局广播。

> **落地情况**：部分实现，且有偏差。
> 已抽出并 memo：`ConnectionLayer` / `ActiveConnectionOverlay`（后者的存在是为了让连接拖拽每 pointermove 的 `mouseWorld` 不再拖动整条边列表）、`NodeLayer`、`SelectionOverlay`。
> `CanvasActions` context（`canvas-actions.tsx`）用 `latestRef` 门面做成**永久稳定**的值，`CanvasNode` 的 props 从 33 个收敛到 14 个——原先 `onRetry` / `onGenerateImage` / 批量那几个依赖 `effectiveConfig` / `t` / `message` 的回调会在配置或语言变化时刷掉所有可见节点。
> `CanvasNode` 的 `hidePanel` 判断移入组件内部（它本就持有 `definition`）。
> **偏差 1**：没有单独建 `ViewportSurface`。`atelier-canvas.tsx` 的 `CanvasGrid` + transform div 已经就是这个结构，再拆一层无可测收益；该处真正的杠杆是把 `viewport` 移出 controller（未做，见下）。
> **偏差 2**：没有建 `CanvasScene` 包装层。四个层各自 memo 后，controller 重渲染只是重建 4 个元素、memo 直接 bail，再包一层零 props 组件没有额外收益。
> **偏差 3（经你确认后放弃）**：没有把 viewport / 交互状态搬进作用域 store。做完上述改动后，指针级状态已被层 memo 挡住、回调也不可能再破坏 memo，store 剩下的唯一收益是省掉 controller 自身那次重渲染；而那次重渲染里所有 `useMemo`（`visibleNodes` / `graphIndex` / `visibleConnections` / `relatedHighlight`）都会 bail。按原文档「不建议无测量地将所有状态一律转入 Zustand」的意见，本轮不做。
> **偏差 4**：hover/selection 状态仍留在 controller，未「局部化」。hover 派生出跨节点的 `relatedHighlight`，必须改写成按节点/按边的派生 selector 才能真正局部化，而那需要 P1-A 的邻居索引配合；当前成本为 hover 时 O(E) + O(可见数) 的 prop 比较，判定为可接受。
> **偏差 5**：只拆了画布内部。左侧 `CanvasSidePanel` 仍在外面每帧重渲染（见 §7）。

### P1（结构级优化）：真正的可扩展视口/交互系统

**P1-A：动态空间索引**，新增 web/src/lib/canvas/canvas-spatial-index.ts：
- AABB 空间网格或 R-tree；先 benchmark 与实现复杂度后定最终结构。支持 insert/update/remove/search(rect)，含宽高很大的 Group；不能只按中心点索引。
- 载入时构建，新增/删除/移动/resize 后按差量更新；拖拽时用临时坐标覆盖索引或仅查询移动对象，避免每帧全量重建。
- 供 visible nodes、marquee、连接吸附、组 drop target 共用。屏幕 padding 按 CSS 像素转换成世界坐标，并用滞回机制降低虚拟化边界反复 mount/unmount。
- 全局节点数据保持完整，**只裁剪渲染和命中测试**；不会将屏幕外节点误判为不存在。

**P1-B：Transient interaction / commit on end**：
- 拖拽期间以 ref/临时轻量 Store 保存 delta，按帧只刷新被拖动的节点 transform、相邻连线；mouseup 才原子性写入持久 nodes、更新索引、推入一条 Undo。
- 对多节点/组拖动设置一次批处理；避免每帧写入完整 nodes 数组、更新全文引用。
- 如果使用直接修改 DOM transform，必须与 React 渲染和 offscreen unmount 正确同步；可选专用 DragLayer/EdgeOverlay，结束后再交还 DOM 状态。
- 保证 Escape/blur/cancel 恢复、吸附目标、组 children、负坐标、不同 zoom 的 delta，以及同一帧线端点对齐。

**P1-C：小地图和媒体资源**：
- 小地图的节点矩形迁至单个 2D canvas（Retained data + rAF repaint），视口框与交互可以 DOM overlay；只在节点/主题/范围变化时重画节点，pan 时只更新视口框。
- 图片预览使用按目标显示尺寸限制的缩略图，原图由 storageKey 保留供查看/生成/导出；加入有上限 LRU、并发解码限制与释放策略。
- video 默认 poster/缩略图加 preload=none；仅用户开始播放时挂载并加载真实 video，离屏时暂停与释放（保持正在播放或受保护节点）。audio 类似懒加载。
- 不随意 revoke 仍被 UI 使用的 objectURL；防止 ObjectURL 生命周期、历史快照和图片清理互相冲突。
- 项目恢复先 hydrate 结构和视口附近媒体，其他资源按需解析，避免 Promise.all 对数千资源并发打开。

**P1-D：持久化/历史隔离**：
- 保留现有 projects 格式，先将 canvas 运行时 viewport/selection/drag 与持久 nodes 数据进一步解耦，降低无意义 store 通知。
- Undo/Redo 以用户操作为事务边界；高频拖拽只提交一次；批量动作可用带修改集的历史记录替代过量全图快照（在确认正确性后引入）。
- 持久化 JSON.stringify 与 IndexedDB setItem 的耗时分别计量；如 p95 长任务不达标，采用 idle/worker 序列化或分片持久化，必须确保 pagehide/刷新不丢最新提交数据。
- 图片/视频仍存 Blob，不通过画布结构 JSON 持久化大型 dataURL。

### P2（万级及全部可见）：按缩放级别 LOD / 混合渲染

- 当 zoom 很小、一次可见 >300-600 节点（**阈值由性能实测调参**），用批量 Canvas2D 画节点简图/色块和连接线；带选中/hover/编辑/媒体播放的少量节点保持完整 DOM overlay。
- 中等 zoom：简化阴影、动画、工具栏和内容；正常 zoom：保持当前完整 JSX 节点。
- LOD 切换使用迟滞防闪烁；默认不改变数据、命中测试、键盘快捷键和组合行为。可见 5000 节点不可能仅靠离屏裁剪保证流畅，所以需要 P2。
- 优先 Canvas2D；只有实测证明 Canvas2D 无法达到目标，才考虑 OffscreenCanvas+Worker/WebGL。自定义插件仍能声明预览绘制策略，未实现的插件节点按兼容降级渲染。
- 远距离缩放时不展示复杂编辑器；选择/聚焦后无缝升级成完整 DOM。

## 4. 基准、Instrumentation 和回归

建议新增：
- web/src/lib/canvas/canvas-performance.ts：开发环境 PerformanceObserver、rAF 采样、React Profiler commit 计数、p50/p95 帧时长、DOM/SVG 数量、节点筛选/引用计算耗时与数据统计；发布构建关闭详细跟踪。**（未实现）**
- web/src/lib/canvas/canvas-fixtures.ts：可复现随机种子的 N/E 比例测试数据，包含 Groups、跨视口长连线、图片与视频、负坐标、极端尺寸、生成中节点和插件节点。**（已实现）**
- web/src/lib/canvas/*.test.ts：索引查询与旧逻辑对拍（随机、移动、resize、删除、组边界，连线 Bézier 视口相交），资源引用标签顺序、配置节点 fallback、剪裁选中与取消。**（部分实现：`canvas-graph-index.test.ts` 索引对拍 + 标签顺序 + Config 回退；`canvas-connection-culling.test.ts` 凸包包含性 + 不漏绘；`canvas-node-geometry.test.ts` 组目标判定对拍。移动/resize/删除/剪裁取消尚未覆盖。）**
- 用 Playwright 或既有自动化环境在同一台机器跑真实浏览器测试；无浏览器测试环境时先做 Chrome Performance 手动 baseline 再引入依赖。**（未做，未引入依赖）**

统一采集：FPS / p95 frame(ms) / long tasks / interaction latency / React commits / JS heap / DOM node count / SVG path count / 媒体 decoder 数 / 项目载入时间 / 持久化耗时。表格应记录原始分数、优化后分数、回归与硬件。指标必须分开观察“场景总节点数”和“当前可见节点数”。**（表格尚未建立，无任何数据）**

**必须回归**：节点选择/多选/框选/复制粘贴/撤销重做、框选边界、线段点击删除和选中突出显示、连接拖拽及创建菜单、组与组内孩子拖拽和吸附、鼠标双击创建、拖拽文件导入、图片查看和批量图片展开、视频/音频播放、配置节点资源输入、Seedance 多参考输入、异步生成任务完成更新、项目导出导入、刷新后媒体恢复、自定义插件节点交互。

> P0 落地的每一步都由人工按本清单走查过（分 5a / 5b 两批），未发现回退。但这是人工点检，不是自动化回归。

## 5. 推荐落地顺序 / 完成条件

1. **Baseline**：固定 fixture、浏览器测量脚本和手动可比记录；保留变更前报告。**（未做——这是与本文档最大的偏离）**
2. **P0-A 引用图索引**：独立测试资源引用/Config 输入完全等价，并观察拖拽时 CPU。**（已完成，等价性有对拍测试；CPU 未观察）**
3. **P0-B SVG 连线裁剪**：大量边界测试，验证屏幕外路径不会漏掉穿过画面的连接线。**（已完成，有保守性测试）**
4. **P0-C 鼠标热路径 / 框选**：rAF 合帧 + Map；保证结束状态和 Undo 正确。**（已完成，Undo 由人工走查）**
5. **P0-D 组件边界**：React Profiler 验证 pan/zoom 不触发不必要节点提交。**（实现完成，但 Profiler 验证未做）**
6. **P1-A/P1-B 动态索引 + interaction commit**：处理视口、命中和多拖状态生命周期。
7. **P1-C/P1-D 媒体和持久化**：控制内存峰值与载入时间，端到端验证真实生成工作流。
8. **P2 混合 LOD**：总览数千节点可见时仍可导航，并且被选中项完整可操作。

**每阶段完成门槛**：类型检查、现有单测、专项回归通过；有统一测试机实测前后对比；未提升则复盘并可关闭 feature flag 回退。先记录基线，再设具体阈值和默认参数，不要将上述目标误报成现有性能。

> P0 实际执行顺序与上述不同：先做了与 P0-A 无关的两个廉价修复（`scale`、`currentProject`），再按 B → A → C → D 推进。原因见 §7「执行顺序」。

## 6. 关键风险与优先防护

- 可视化裁剪导致离屏节点仍用于引用、生成或组逻辑：严格区分完整数据与可见节点。**（P0-B 已按此实现：只裁剪渲染，`connections` 仍是引用/生成/组逻辑的唯一来源）**
- 曲线只以两个端点判断导致跨视口曲线消失：改为 Bézier 控制点包围盒保守剔除。**（已实现并测试）**
- 虚拟化卸载编辑控件造成输入丢失：激活编辑器采用浮层/受保护节点。**（P0 未引入虚拟化，不适用）**
- 快速拖动导致线上连接点滞后：同一 rAF 绘制更新节点及关联线，结束时一次提交。**（P0-C 已合帧；拖拽期间仍每帧写完整 nodes 数组，彻底方案属 P1-B）**
- 组节点跨度极大导致网格索引爆炸：对超大边界单独链表或采用 R-tree。**（属 P1-A）**
- 浏览器内存因 blob URL、图片解码和视频缓冲持续上升：资源缓存明确所有权、预算和释放时机。**（属 P1-C）**
- 资源引用排序/标签变化影响多参考输入：图索引必须保留原 connections 顺序及目前 Config 输入 fallback 规则。**（P0-A 已按此实现，并有专门测试）**
- 历史行为与自动保存冲突：操作事务与持久化提交独立，覆盖异常中断恢复。**（P0 未改历史与持久化；仅确认 `historyPausedRef` 原本就会在拖拽期间暂停持久化）**

## 7. 本轮状态（P0 收尾）

**P0（P0-A / P0-B / P0-C / P0-D）已实现并合入 `custom` 分支**，拆成两个提交：

- `2590f1a` `perf(canvas): 优化画布渲染与图遍历性能` —— P0-A / P0-B / P0-C，加上 P0-D 的组件分层（ConnectionLayer / ActiveConnectionOverlay / NodeLayer / SelectionOverlay）。
- `629a052` `refactor(canvas): use context for node callbacks` —— P0-D 的 `CanvasActions` context 与 `CanvasNode` props 收敛。

### 已消失的复杂度

| 路径 | 之前 | 之后 |
| --- | --- | --- |
| 引用 / 生成输入重建 | O(N×(N+E))，每帧 | 每节点 O(deg)，且只算挂载中的面板与正在编辑的文本节点 |
| 连线渲染 | 全量 E 条，且未 memo | 按视口裁剪，逐边 memo |
| 拖拽每帧 | O(N×M) 查找 + 整份 previewNodes + 全表组目标扫描 | O(N) 单趟 + O(1) 查表，组目标只在预筛候选上判定 |
| 框选每帧 | 每 pointermove 全表遍历 + 两次 setState | 每帧一次 + 集合变更判断 |
| 缩放 | 每个可见节点都重渲染（`scale` 是渲染期死参数） | 不重渲染 |
| 拖拽 | 每帧第二次整页重渲染（`currentProject` 选择器） | 不重渲染 |
| 节点的回调 props | 19 个，其中 6 个身份不稳 | 0 个（context，值永久稳定） |

### 执行顺序与原文档的差异

原文档 §5 把 Baseline 列为第 1 步、P0 按 A→B→C→D。实际执行：先做两个与 P0-A 无关的廉价修复（`scale` 删除、`currentProject` 选择器），再 B → A → C → D。**Baseline 始终没做**——这是本轮最大的偏离，也是下面「未验证」一节的根源。另有一处硬依赖是原文档没说清的：P0-D 的面板改造**必须在 P0-A 之后**，否则把引用计算下沉到面板会变成 O(P·deg·N)，比改造前更差。

### 明确未做

- **Baseline 与一切实测**：没有 `canvas-performance.ts`，没有 Playwright，没有 fps / p95 / long task / heap 采样，没有前后对比表。
- 移除固定 10000×10000 SVG 与 `translateZ(0)`（原文档要求独立 A/B 实测）。
- P0-D 的作用域 store（经确认后放弃，理由见 §3 P0-D 偏差 3）。
- P1 全部、P2 全部。

### 未验证项（重要）

`npm run typecheck`、`vitest run src`（88 个用例）、`vite build` 均为通过，但**这三项只证明正确性，不证明性能**。§1 的 p95 < 20ms / ≥50FPS / 框选 p95 < 33ms 等目标**至今没有任何实测支撑**，不得作为结果引用。要谈性能结论，必须先补 §5 第 1 步的 baseline。

### 遗留热点（P0 未覆盖）

1. ~~**`canvas-side-panel.tsx:52` 的 `CanvasSidePanel` 未 memo，且接收整个 `nodes` 数组**~~ **（已修，且实测是 P0 之后最大的一项——见下方）**
2. **`canvas-mini-map.tsx`** 每次 viewport 变化都重建每节点 div（属 P1-C）。
3. ~~**滚轮缩放未合帧**~~ **（已修）** —— `handleWheel` 原本每个 wheel 事件同步 `setViewport`，且从 props 读 `viewport`，同一批次内多个事件会互相覆盖（后一个丢弃前一个的缩放增量，表现为快速滚轮/触控板缩放跳变）。现改为累积缩放因子 + 单帧 flush，并从 ref 读最新 viewport；同时平移里的 `k` 也改从 ref 读取，修掉了「平移中途缩放会跳」的问题。
4. **controller 自身每 rAF 帧重渲染** —— 平移时 `viewport` 是 controller 状态。层 memo 已把影响挡住，但 controller 实体（数百个 hook + JSX 重建）仍在跑。这正是被放弃的 5c 想解决的。
5. **拖拽仍每帧写完整 `nodes` 数组** —— 彻底方案是 P1-B 的 transient interaction。

### 侧边栏：被低估的一项（已由实测更正）

上表第 1 条当初的估计是「节点上千时这条比 P0 修掉的任何一条都不轻，因为它完全在画布分层之外」，
并猜测它主要影响**拖拽**。`CANVAS_BASELINE.md` §5.2 的实测数据表明**两项都要更正**：

- 它是 **P0 之后最大的单项成本**，修复后（`10c17e9`）平移 p50 27.9 → **16.7ms（−40%，下界）**、
  框选 25.6 → **16.7ms（−35%，下界）**、拖拽 41.4 → 28.8ms（−30%）。
- 影响最大的是**平移和框选**，不是拖拽。原因是 `CanvasSidePanel` 未 memo，控制器每帧重渲染时它
  也跟着重渲染，于是**每帧重建 1000 个行的元素**；这与「拖拽才写 `nodes`」无关。

教训：**「画布分层之外」的组件被控制器每帧重渲染这件事，当初只被当作拖拽路径的问题，实际是所有
改变 `viewport` 的路径的问题。** 判断一个组件是否会每帧重渲染，要看它在不在 controller 的重渲染
子树里，而不是看它依赖什么数据。

