# 画布性能 Baseline 测量方案（评审修订版）

修订日期：2026-10-16  
实际项目：`H:\WebDev\infinite-atelier`  
原计划：`C:\Users\osss\.claude\plans\h-webdev-infinite-atelier-canvas-perfor-eager-minsky.md`

## 1. 目标与范围

补齐 `CANVAS_PERFORMANCE_OPTIMIZATION_PLAN.md` 尚未执行的 baseline：使用相同 fixture、生产构建、浏览器环境和合成事件脚本，比较优化前后的帧节奏、长任务、DOM 规模、项目加载和持久化成本。最终数据写入新建的 `CANVAS_BASELINE.md`。

既有 typecheck、单测和 build 是正确性门槛，不能作为性能提升的证据。原文档中的 p95 帧时长、FPS 等是待验证目标，不是现有结果。

本方案保留原计划已确认的选择：合成事件驱动、真正的 before/after、结果落盘。不新增浏览器自动化依赖，不把合成输入结果解释为真实用户输入延迟或 INP。

## 2. 固定比较对象

不能以不断变化的工作目录代表 after。构建前记录完整 commit SHA、Git diff、依赖 lockfile 校验值和 harness 校验值。

| 组别 | 固定提交 | 作用 |
| --- | --- | --- |
| A：优化前 | `dbdd607` | P0 前的 baseline |
| B：P0 后 | `629a052` | 包含 `2590f1a` 与 `629a052`，用于判断 P0 综合效果 |
| C：后续修复后（可选） | `2de464a` | 另包含 `10c17e9` 节点列表优化和 `2de464a` 滚轮修复 |

核心比较为 A/B。C 必须单列，不能把 A/C 的变化全部归因于 P0，也不能用综合比较推断每项优化的独立贡献。实施时若分支继续前进，仍使用以上固定提交；增加其他比较组时显式记录 SHA 和变更范围。

当前检查确认 A 到 C 的 `web/package.json`、`web/package-lock.json` 和 `use-canvas-store.ts` 没有差异。执行时仍需复核，并在各组执行 `npm ci`。

## 3. 构建与加载边界

使用生产构建 `vite build --mode perf`。开发模式的额外检查和渲染开销不应混入 baseline。

- `web/package.json` 增加 `"build:perf": "vite build --mode perf"`。
- `main.tsx` 仅在 `import.meta.env.MODE === "perf"` 时动态导入引导模块。
- `project.tsx` 的面板渲染也必须受同一个编译期条件保护；面板的静态依赖不能留下通往 harness 的无条件副作用导入路径。
- 不需要 `.env.perf`。所有取数标记和测试存储切换均限制在 perf 模式。
- 普通 build 的产物不得包含 harness 特征串、面板或测试素材；perf build 必须包含对应功能。检查全部产物及 import 路径，不能仅凭某一个 chunk 的名称判断。

## 4. 数据隔离与启动顺序

### 4.1 使用独立测试存储

所有 perf 构建统一将 localforage 的数据库名改为 `infinite-canvas-perf`，localStorage fallback 使用测试专属前缀。隔离应在各 store 初始化及自动 hydrate 之前完成，不能等动态导入的 bootstrap 再修改数据库配置。

在 `web/src/lib/localforage-storage.ts` 增加编译期分支即可覆盖当前共享存储适配器；同时检查媒体存储是否有独立配置，保证 fixture 不写入正式媒体数据库。普通构建保留原行为。

每次浏览器会话仍使用新的 `--user-data-dir`。数据库隔离与新 profile 同时使用：前者保护手动启动流程，后者控制跨会话缓存条件。perf 模式面板明确标识测试环境；不读取、迁移或清空正式项目库。

### 4.2 hydrate 完成后注入

顺序必须为：

```text
启动 perf 构建 → 测试 store hydrate 完成 → 注入 fixture
→ 导航到 /canvas/<perfId> → 项目恢复 → canvas-ready → 视觉与保存稳定
```

`CanvasProjectPage` 的加载 effect 在项目不存在时会跳转，而且仅注入 store 不会使它重跑。fixture 必须在导航前存在。

等待真实 hydrate 完成，设置超时。失败或超时应记录原因并中止该样本，不能手动设置 `hydrated:true` 冒充完成，否则迟到的 hydrate 仍可能覆盖 fixture。localStorage fallback 发生时记录实际后端；不同后端的持久化结果不能混算。

### 4.3 固定 ID 的安全替换

fixture 使用完整的 `CanvasProject` 字面量，包含有效 viewport、`backgroundMode:"lines"`、时间字段、nodes、connections、chatSessions 和 activeChatId 等必填属性。

`replaceProjects` 替换的是整个列表，不能直接传 `[fixture]` 并声称保留其他项目。应从当前列表过滤相同 perf ID 后，将 fixture 与剩余项目一起传入。仅允许在独立测试库中操作，重复运行不得不断追加。

## 5. fixture 与静态素材

在现有 `buildCanvasFixture` 中增加 `mediaMode?: "remote" | "static" | "none"`，默认值为 `remote`，保持既有测试行为。

- `remote`：保留现有 `https://example.test/${id}`，不用于正式性能场景。
- `static`：Image 节点共用本地 SVG URL；Video/Audio 不设置 content。
- `none`：媒体节点均不设置 content，用于补充观察无媒体资源的图和 DOM 压力。

素材放在 `web/src/assets/perf-pixel.svg`，明确使用 `?no-inline` 导入。极小 SVG 普通导入会被 Vite 内联为 data URL，而 `hydrateCanvasImages` 会把 `data:image/` 送入 `uploadImage`，导致大量存储写入。

验收必须检查 perf 构建后的真实 URL：不是 `data:`，可以通过同源 HTTP 获取，加载 fixture 不触发逐图片 uploadImage。不要把“同 URL”直接表述为浏览器必定只解码一次。

所有组使用相同 seed 7、素材、fixture 选项和图结构校验值。记录 N、E、节点类型分布及初始数据摘要。加载路径会执行 `resetInterruptedGeneration`，因此实际运行态可能与原 fixture 的 loading 比例不同；报告实际恢复后的状态分布，不能直接引用生成器比例。

## 6. 文件与插桩

### 新增

- `web/src/lib/canvas/canvas-perf-harness.ts`：不含 JSX，负责 bootstrap、场景驱动、状态机、采样、校验、原始数据和 Markdown 导出。
- `web/src/components/canvas/canvas-perf-panel.tsx`：控制面板，显示组别、场景状态和失败原因。
- `web/src/assets/perf-pixel.svg`：共享测试图像。
- `CANVAS_BASELINE.md`：环境、场景、原始数据链接、结果和局限。

### 修改

- `main.tsx`：perf 专属动态引导。
- `project.tsx`：perf 专属面板和最小必要测试桥，暴露 viewport、节点摘要、selection 及 ready 状态；不得修改交互算法。
- `canvas-fixtures.ts`：媒体模式选项。
- `use-canvas-store.ts`：perf 专属持久化计时及队列状态。
- `localforage-storage.ts`：perf 专属数据库及 fallback 隔离。
- `package.json`：`build:perf`。

同一份 harness 和相同语义的最小插桩应用到各提交。旧提交没有 P0 新组件，不能复制新组件实现替代旧逻辑。保留每组的插桩 diff，检查没有顺带移植优化代码。

## 7. 合成输入与交互有效性

### 7.1 Pointer capture shim

合成 PointerEvent 没有活跃的真实指针，现有 `setPointerCapture` 可能在手势建立前抛错。harness 在 perf 会话中安装同一份 shim，并保存原始方法以便结束或异常时恢复。限制在测试会话，不改动应用手势代码。禁止在脚本运行期间混用人工输入。

### 7.2 事件序列

- 平移：画布空白处 pointerdown，window pointermove，window pointerup。
- 缩放：画布 wheel，显式设置 deltaY、deltaMode 和固定锚点。
- 节点拖拽：可命中的 Image 节点拖拽 body 上 mousedown，window mousemove，window mouseup。
- 框选：空白处 ctrl+pointerdown，window pointermove 且 buttons=1，window mouseup。

MouseEvent/PointerEvent 明确设置 bubbles、cancelable、坐标、button/buttons 及相关修饰键。拖拽不能直接向 `[data-node-id]` 外层派发 mousedown：当前拖拽 handler 绑定在内部 body，派发到外层不会向下传播。

通过 elementFromPoint 验证起点的实际命中对象。节点起点必须属于目标节点且命中允许拖动的区域，避开工具栏、resize handle、连接点和编辑控件。随机 fixture 可能高度重叠；找不到有效目标或空白点时，场景失败，不静默换成另一种输入语义。

### 7.3 前后置断言

每个场景必须证明交互生效：

- pan：viewport x/y 发生预期变化。
- zoom：实际 k 和锚点变换符合脚本，并报告触及缩放边界的帧比例。
- drag：指定节点最终坐标符合屏幕位移除以 k 的换算；未拖错节点，未遗留手势状态。
- marquee：selectionBox 确实出现并结束，最终选择集合与当前实现的相交规则一致。

不能只以“事件已派发”“有 FPS 数字”判定成功。失效、断言失败、页面隐藏或 reset/idle 超时的样本标为 invalid，保留原因，不进入中位数。

## 8. 每轮复位与场景状态机

每次预热、每次正式重复和每次切换场景都执行相同协议：

```text
结束上一手势并停采样 → 等待保存完成 → 导航离开项目并确认卸载
→ 用原始 fixture 替换测试项目 → 导航回来并确认新一轮 ready
→ 设置初始 viewport → 验证结构/坐标/selection/history
→ 等待媒体与保存稳定 → 开始采样和输入 → 验证结果 → 收尾
```

仅设置 store 中的 fixture、仅恢复 viewport 或重复 navigate 到相同 URL 都不能替代 remount。ready 信号携带 run ID，避免使用上一轮面板或 recorder 的旧信号。

每轮恢复节点位置、connections、viewport、selection、history 和手势状态。先冻结初始数据摘要，再运行脚本；摘要不一致立即失败。预热产生的节点位移和保存不能进入正式轮次。

## 9. 场景定义

以 rAF 帧数定义输入序列，每帧一个事件；保证的是输入序列一致，不能保证输出逐帧一致。把应用可能延后执行的最后一帧更新纳入结束检查，不能派发最后一个事件后立即结束采样并遗漏其工作。

| 场景 | 总节点数 | 初始视口与动作 | 输入帧数 |
| --- | --- | --- | --- |
| load | 1000 | 预先生成 fixture，量导航到本轮 canvas-ready | — |
| zoom-general | 1000 | 约 150–300 挂载节点；固定锚点，在合法缩放区间先放后缩 | 180 |
| pan-general | 1000 | 约 150–300 挂载节点；空白处拖动，每帧 2px | 180 |
| drag-single | 1000 | 同上；单个 Image 节点，每帧 3px | 180 |
| marquee | 1000 | 同上；ctrl+框选，限定轨迹在有效画布区域内 | 180 |
| overview-pan | 3000 | 根据全图边界求居中视口；拖动并验证挂载规模 | 180 |
| overview-zoom（补充） | 3000 | 从高于下限的 k 开始，缩至下限；报告有效缩放阶段 | 120 |
| overview-pan-5000（可选） | 5000 | 根据全图边界求视口 | 180 |

补充在 pan-general 上扫描 100/500/1000/3000/5000 总节点数；不足以达到目标挂载数时报告实际数量，不能强凑 150–300。

视口求解必须包含 x/y/k，并固定中心和实际画布 rect。可以在固定中心下二分 k 来寻找目标挂载数量，但目标不可达时明确报告。overview 不能仅设置 k=0.05 就声称全可见：由全图 AABB 求居中和 fit scale，考虑应用最小 k=0.05。受下限或尺寸约束无法全显时，标注实际覆盖范围。

zoom 脚本先明确 deltaY/deltaMode，并由初始 k 计算轨迹；避免将“每档”当作未定义输入。缩放上下限为 0.05–5，不得从 0.05 开始连续缩小并把它当作缩放性能。边界空操作压力可另设独立场景，不混入有效缩放成绩。

## 10. 指标与测量开销

### 帧节奏与长任务

- rAF 帧间隔：count、mean、p50、p95、p99、max；FPS 使用总采样间隔计算，不平均瞬时 FPS。
- 固定并记录显示刷新率，另测空闲 rAF 基线。jank 使用预先固定的空闲刷新周期阈值，例如 delta > 1.5 × idle median；不能按每个场景自身中位数改变门槛，把持续低帧率掩盖掉。
- PerformanceObserver 收集 longtask，按场景起止时间归属，结束时 drain，避免跨场景错算。
- 主表保留完整手势窗口。若补充稳态窗口，固定剔除帧数并同时保留完整结果；不能凭观察结果选择性删掉慢帧。

### 节点、DOM 与媒体

- `[data-node-id]` 数量叫“已挂载节点数”，包含裁剪 padding，不能称为真实可见节点数。
- “视口相交节点数”由节点 AABB 与不带 padding 的 world viewport 计算；它也不代表节点未被遮挡。
- 两种数量分别报告 min/median/max，挂载边数、svg path 和总元素数单列。连线可能多 path，不能把 path 数当边数。
- 帧内统计优先采用已挂载集合的增删维护和纯数据计算。总元素数、媒体数等重型 querySelectorAll 快照在采样窗口外执行；避免每帧扫描整个 DOM 或调用全量 getBoundingClientRect。
- MutationObserver 仅作为可选诊断，明确观察选项并称为“DOM mutation records”，不能冒充 React commit 或 DOM 改动节点总数。
- 面板在采样期间冻结展示，只在轮次结束更新；面板布局流之外仍可能遮挡 elementFromPoint，因此采样时隐藏交互层或让其不参与命中，并验证输入点。
- 先比较轻量 recorder 与附加 DOM 诊断模式的开销；若附加观察明显影响帧时长，拆成独立诊断轮次，主结果使用轻量模式。
- 媒体指标报告已挂载且带 src 的 img/video/audio 数，不声称为真实解码器数量。

### 加载和内存

load 定义为 fixture 已生成并注入后，从导航开始到对应 run ID 的项目数据恢复并挂载完成；不包含启动、store hydrate 或 fixture 生成，不代表完整冷启动时间。图片就绪可另记 media-ready，不能与 canvas-ready 混称。

分别标注首次导航样本和同会话重复样本的缓存条件。新 profile 只保证会话起点隔离，不代表其中每次 load 都是冷缓存。冷会话 load 与预热后的 load 不混算。

可选 JS heap 使用 performance.memory，并标注近似、采样点和浏览器参数。它不涵盖 DOM、媒体和 GPU 等全部内存，不用它推断整体内存收益。

## 11. 持久化计时和 idle 协议

`flushCanvasStorePersistence` 中分别记录：

1. JSON.stringify 开始到完成的同步耗时。
2. `localForageStorage.setItem` 开始到 Promise 完成的异步耗时。

为每次写入分配序号，记录字节数、后端、成功/失败和时间范围。若使用 performance mark/measure，及时导出并清理；所有标记仅存在于 perf 构建。不能把调用 setItem 前后的一对同步 mark 当作 IndexedDB 完成时间。

额外暴露 perf 专用只读状态：store debounce 是否 pending、是否有 in-flight writes，以及项目侧 viewport/history timer 是否 pending。保持应用原有调度，不为测量提前强制 flush，然后将结果当成原行为。

手势停止后的典型保存链为：500ms viewport timer → updateProject → 400ms store debounce → 异步写入。因此 quietMs=500 不足以证明完成，DOM 安静也不等于存储完成。

waitForIdle 应同时满足：本轮最终交互更新已应用、无待执行交互 rAF、项目保存/历史 timer 已结束、store 无 pending debounce 且无 in-flight writes、相关媒体已达到场景规定状态，再连续稳定若干帧。可加 1000ms 安静窗口作为辅助，不能用固定睡眠替代上述状态检查。

超时建议 10s，可配置并记录；超时样本 invalid。若旧提交的状态桥无法可靠暴露这些条件，先完成等价的最小插桩，不能以手动设置 hydrated 或忽略 pending 写入作为降级路径。

## 12. 运行纪律与统计

- Chrome 有头、前台、单测量标签页；记录浏览器完整版本、系统、CPU/GPU、内存、电源模式、DPR、刷新率及真实画布 rect。
- 使用新的独立 user-data-dir，并记录启动参数；可加 disable-background-timer-throttling、disable-renderer-backgrounding、disable-backgrounding-occluded-windows。heap 测量需要时加 enable-precise-memory-info。
- 通过 visibilityState 和 focus 检查运行条件，失焦或隐藏时使当前样本失效。相同机器、相同画布尺寸、侧栏状态、主题、浏览器缩放和资源模式。
- 每个交互场景先跑一遍预热并丢弃，再独立复位后正式跑三遍，保留逐轮数据，汇总每轮 p95 等指标的中位数和范围。load 按冷/暖定义分别执行，不套用混合预热规则。
- 会话顺序交错并平衡，例如 A/B、B/A、A/B，各组至少三个独立会话。每个会话内部的三次重复是重复测量，不能当成三个独立浏览器会话。
- 报告每会话汇总及跨会话中位数/范围。差异与波动接近时写“证据不足”，不凭单次最佳值宣称提升。
- 不打开 DevTools 录制主成绩。需要 trace 时单独跑诊断轮次。

## 13. 实施步骤与验证门槛

1. 建立固定 A/B detached worktree，保留当前工作目录；确认无未授权覆盖和依赖差异。
2. 实现测试存储隔离、媒体 no-inline、bootstrap 和最小状态桥。
3. 先实现 reset → ready → 单个 pan → 断言 → idle 的闭环，确认失败能停止并显示原因。
4. 扩展各场景及有效性断言，再实现轻量 recorder 和导出。
5. 将相同 harness 和等价插桩应用到 A/B，核对文件 hash 和各组 diff。
6. 各组执行 typecheck、现有测试和普通/perf build；保留既有测试全部通过，不把固定的历史用例数当作永久门槛。
7. 增加必要的专项校验：fixture 默认行为、静态 URL 非 data、替换保留其他项目、复位摘要一致、失败样本不汇总、持久化等待涵盖异步完成。
8. 验证普通构建不含测试代码/素材，正式存储命名和行为不变；perf 手动启动也不会接触正式项目数据。
9. 每场景先检查实际状态变化、节点数量和缩放轨迹；故意制造错误目标、隐藏页面和 idle 超时，确认样本被拒绝。
10. 按交错会话完成采样，保存原始 JSON 和 Markdown 报表，再填写 CANVAS_BASELINE.md。

worktree 示例：

```powershell
git worktree add --detach H:\WebDev\ia-before dbdd607
git worktree add --detach H:\WebDev\ia-p0-after 629a052
```

每个 worktree 独立安装和构建。服务可依次使用相同端口，也可固定独立端口并记录；不要在不同组间共享浏览器 profile。各组唯一允许的额外代码差异是本方案明确列出的等价测试插桩，不得额外修改画布实现。

## 14. 报告结构与完成条件

`CANVAS_BASELINE.md` 至少包含：

- 环境、完整提交 SHA、lockfile/harness/fixture 校验值、插桩 diff 和运行命令。
- 场景参数、初始 viewport、真实画布尺寸、总 N/E、挂载数量及视口相交数量。
- 冷/暖加载定义、存储后端、每会话和每轮原始 JSON、有效/无效样本数量及原因。
- 帧间隔统计、FPS、固定阈值 jank、长任务、DOM/媒体快照和可选 heap。
- JSON.stringify 与存储完成时间分别统计；注明样本数，少量写入时直接列明原始耗时，不夸大 p95 的代表性。
- A/B 的绝对值、变化比例和波动范围；C 若执行则单列，不混淆归因。
- 未测项、fixture 的代表性限制、合成输入与 rAF 指标局限。

完成条件：各组正确性检查通过，所有核心场景通过有效性校验，有可复核的多会话 before/after 数据，普通构建与正式数据隔离验收通过。未达性能目标也如实记录；不能将目标写成测得结果。

## 15. 结果解释的边界

合成事件没有完整的 OS 输入调度、真实 pointer capture、触控板惯性和事件合并。当前脚本不测真实交互延迟；即使以后增加合成事件响应计时，也不能自动称其为真实延迟的下界或 INP。

rAF 反映主线程调度节奏，不能直接等同于合成器呈现流畅度。每帧一个事件也无法覆盖高频输入突发；若以后评估滚轮合帧，应增加独立、固定事件数的 burst 场景。

共享 SVG、空视频/音频和缺失插件占位压测的是图数据、DOM、裁剪与交互，不能代表真实媒体解码、复杂插件和生成任务负载。总节点数与挂载节点数都要观察：离屏节点仍可能参与全图扫描、索引和持久化，不能仅凭挂载数断言总量无影响。
