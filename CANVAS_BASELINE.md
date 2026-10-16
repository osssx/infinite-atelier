# 画布性能基准

> **状态：A/B/C 三组对比已完成，每组 3 个独立会话。本文档是这次对比的结果记录。**
>
> **未达标项如实记录**——见 §7。P0 在拖拽、平移、框选三条路径上有明确且一致的正向效果；
> **缩放路径没有改善**。四条验收目标中，A、B 两组各只有一条达标，C 组两条。

## 1. 被测对象

| 组 | 提交 | 相对上一组多出的改动 |
| --- | --- | --- |
| **A** | `dbdd6079af15e9abd105e6c7c7407ded33084d13` | 优化前基线 |
| **B** | `629a052aba137a43faa93547f33c493c70ad5bf9` | P0（含 `2590f1a`） |
| **C** | `2de464aa6fa261e5a81fee50a60c37dcca47b701` | `10c17e9` 侧边栏行 memo、`2de464a` 滚轮修复 |

提交顺序为 `…→629a052→10c17e9→2de464a`（已用 `git merge-base --is-ancestor` 核实）。**滚轮修复
只在 C**，所以 `zoom-burst` 在 A 和 B 都被拒是**正确的**。

| 项 | 值 |
| --- | --- |
| harness | `canvas-perf-harness.ts` sha256 前 16 位 `fc4a685b7f04c08e`，**三棵树逐字节相同** |
| fixture | `canvas-fixtures.ts` sha256 前 16 位 `2fecb74ea7059610` |
| 依赖 | 三棵树**实际安装版本一致**：`react@19.2.5 vite@7.3.6 typescript@5.9.3 antd@6.4.2` |
| 安装方式 | `npm ci --legacy-peer-deps`（该项目存在既有 peer 冲突，见 §8.3） |

## 2. 环境

| 项 | 值 |
| --- | --- |
| 浏览器 | Edge 155（Chromium 155），九次会话同一个二进制 |
| 窗口 | 1912×914 @1x |
| **画布** | **1631×914，九次会话完全一致** |
| 逻辑核心 | 16 |
| 空闲帧时长 | 16.70 ms（60Hz），九次会话一致 |
| jank 阈值 | 25.05 ms = 1.5 × 空闲中位，在任何交互场景之前固定 |
| 启动参数 | 每次全新 `--user-data-dir`、`--no-first-run`、`--no-default-browser-check`、`--disable-background-timer-throttling`、`--disable-renderer-backgrounding`、`--disable-backgrounding-occluded-windows` |
| 存储 | perf 模式独立库 `infinite-canvas-perf`，不触碰正式库 |

## 3. 场景与协议

采样集 6 个：`idle-baseline` / `zoom-general` / `zoom-burst` / `pan-general` / `drag-single` /
`marquee`。每场景 **1 轮预热丢弃 + 3 轮正式**；每轮完整复位（导航离开 → 确认卸载 → 重新注入
fixture → 导航回来 → 等就绪 → 等静默 1200ms → 设初始视口 → 采样 180 帧，每帧一个事件 → 断言）。

九次会话交错并平衡：**A-1 → B-1 → B-2 → A-2 → A-3 → B-3 → C-1 → C-2 → C-3**。
（C 组在 A/B 之后单独跑，见 §8.1 的说明。）

有效样本：每组 54 轮。无效样本：A 9 个、B 9 个（全部是 `zoom-burst`），
**C 0 个**。

## 4. 三组结果

### 4.1 帧时长（每会话报中位数；表为跨会话中位数与范围）

| 场景 | A p50 中位 [范围] | B p50 中位 [范围] | C p50 中位 [范围] | B→C |
| --- | --- | --- | --- | --- |
| `idle-baseline` | 16.70 [16.70–16.70] | 16.70 [16.70–16.70] | 16.70 [16.70–16.70] | 0% |
| `pan-general` | 38.70 [38.40–41.80] | 27.90 [27.70–28.60] | **16.70** [16.60–16.70] | **−40%** |
| `marquee` | 38.80 [37.60–38.80] | 25.60 [25.50–26.20] | **16.70** [16.70–16.70] | **−35%** |
| `drag-single` | 89.50 [88.70–99.40] | 41.40 [40.90–42.90] | **28.80** [28.20–29.90] | **−30%** |
| `zoom-general` | 242.40 [239.60–265.20] | 240.50 [231.50–241.40] | 226.80 [219.00–234.30] | −6% |

| 场景 | A p95 | B p95 | C p95 |
| --- | --- | --- | --- |
| `pan-general` | 48.10 | 33.20 | **20.20** |
| `marquee` | 44.40 | 29.30 | **18.60** |
| `drag-single` | 110.70 | 46.70 | **34.30** |
| `zoom-general` | 430.60 | 429.50 | 416.40 |

**C 的 `pan-general` 与 `marquee` 的 p50 = 16.70 ms，恰好一个 vsync 周期。** 也就是说这两条路径
**已经撞到 60Hz 上限**，真实计算开销可能更低但测不出来。因此 **B→C 的 −40% / −35% 是下界**，
不得当作精确幅度。

### 4.2 长任务（每会话中位数）

| 场景 | A（会话 1/2/3） | B | C |
| --- | --- | --- | --- |
| `drag-single` | **178 / 179 / 179** | 2 / 2 / 2 | 1 / 1 / 1 |
| `zoom-general` | 63 / 65 / **166** | 0 / 0 / 0 | 0 / 0 / 0 |
| `marquee` | 1 / 1 / 1 | 0 / 0 / 0 | 0 / 0 / 1 |
| `pan-general` | 2 / 4 / 5 | 2 / 2 / 2 | 2 / 2 / 2 |

`drag-single` 的 179 → 2 比帧时长更不易受机器漂移影响，是 P0 拖拽优化最直接的证据。
`zoom-general` 在 B/C **零长任务**却有约 230ms 的帧——主线程没被占住，帧就是没被调度。

### 4.3 `zoom-burst`：可判别的三方结果

| 组 | 含滚轮修复？ | 结果 |
| --- | --- | --- |
| A | 否 | **被拒 ×9**，`got 0.4998` |
| B | 否 | **被拒 ×9**，`got 0.4998` |
| C | **是** | **通过 ×3**，`k → 2.2968` |

`0.4998 = 0.3414 × (1.1^0.2)^20`——即每帧 5 个 wheel 事件**只有最后 1 个存活**；期望值
`2.2968 = 0.3414 × 1.1^20`。**修复前后给出可预测、可区分、且跨会话完全一致的不同数值。**

这是本次最干净的一个结果，也证明了当初「必须单独加 `zoom-burst`」的判断：`zoom-general` 在
三组**全部通过**（每帧一个事件时修复前后行为本就相同），单靠它测不出这个 bug。

### 4.4 确定性检查：这些列必须完全一致

`seed 7` + 固定画布尺寸 + 确定性视口求解 ⇒ 以下列在所有会话中必须逐位相同。它们同时充当
「服务是否串了」的组身份标记：

| 场景 | A edges / dom | B edges / dom | C edges / dom |
| --- | --- | --- | --- |
| `idle-baseline` | **1500** / 6332 | 627 / 3713 | **627 / 3713** |
| `pan-general` | **1500** / 9682 | 889 / 7849 | **889 / 7849** |
| `drag-single` | **1500** / 9859 | 842 / 7885 | **842 / 7885** |
| `marquee` | **1500** / 10033 | 842 / 8059 | **842 / 8059** |

`1500 = 1000 × 1.5` 正是 fixture 的全量连线数——**A 全量渲染，B 与 C 裁剪后完全相同**，说明
C 的两处改动不涉及裁剪。二十七次会话记录全部吻合，无一次例外。

## 5. 归因

### 5.1 P0（A→B）

连线裁剪生效（edges 1500 → 约 850），拖拽的复杂度问题被消除（长任务 179 → 2，p50 −54%），
平移 −28%、框选 −34%。**缩放几乎没动**（−0.8%）。

### 5.2 `10c17e9`（B→C，侧边栏行 memo）：本次最大的单项收益

`CanvasSidePanel` 没有 memo，而控制器每帧重渲染时它也跟着重渲染，于是**每帧重建 1000 个行的
元素**；修复前每个行还会重渲染自己的 DOM 子树。实测把它移除后：

| | B | C | 变化 |
| --- | --- | --- | --- |
| `pan-general` p50 | 27.90 | 16.70 | **−40%（下界）** |
| `marquee` p50 | 25.60 | 16.70 | **−35%（下界）** |
| `drag-single` p50 | 41.40 | 28.80 | −30% |

**这推翻了我此前的判断。** 我在 P0-D 的落地记录里把侧边栏写成「P0-D 未覆盖的遗留热点」，
并猜测它主要影响拖拽；实测是**影响平移和框选最重**，且是 P0 之后的最大单项成本。归因是确定的：
C 相对 B 只多两处改动，而滚轮修复只动 `handleWheel` 与 ref 管线，**不可能**加速平移（它甚至让
同步 effect 在平移时每帧都跑，是**更多**工作）。

### 5.3 `2de464a`（滚轮修复）

只体现在 `zoom-burst` 的判别上。缩放路径的帧时长几乎没变（240.50 → 226.80），符合预期——
该修复解决的是**批次内事件互相覆盖**，而不是每帧的合成成本。

## 6. 未解释项

### 6.1 缩放为什么慢（有证据的推断，非定论）

B/C 的 `zoom-general` 帧时长与 A 接近（约 227–242ms），但 **A 有约 64 个长任务、B/C 是 0**。
说明 P0 的裁剪**确实消掉了缩放中的主线程 JS 开销**，而 230ms/帧依然存在——**剩下的是主线程之外
的成本**。最可能指向变换层里那个固定 `10000×10000`、`overflow-visible`、带 `translateZ(0)` 的
SVG：每次 `scale` 变化都要求整体重栅格化，而 `translate` 不需要。

**要证实必须单独跑一次 Chrome Performance trace**（计划 §12 也要求 trace 独立于主成绩）。
**本轮没有做。**

### 6.2 平移与缩放的代价会反转

低密度下缩放慢约 14 倍（227ms vs 17ms，挂载还更少）；全量挂载时平移反而更慢
（**冒烟数据，非本次对比**：1973ms vs 568ms）。单个机制解释不了这个交叉。

### 6.3 `zoom-general` 偶发少一个缩放步

同一份代码同一会话内，不同轮次会给出 `-> 0.3414`（精确往返）或 `-> 0.3334`
（= `0.3414 / 1.0241`，**恰少一个放大步**）。伴随可核对的证据：落在 `0.3334` 的那一轮
`mounted` 最大值是 210 而非 200、`dom` 是 8285 而非 7883（k 略低则视野略大）。

九次会话里 **A 和 B 从未出现，C 出现 4/9 轮**。往返容差已放宽到 3%（它要防的真 bug 会丢超过
一半的 delta），所以轮次都通过。

场景里的「生效步数」计数**不可信**（靠比较相邻帧的 `k`，慢帧下多个生效步会被观察成一次变化，
只会少计）；可靠判据只有往返是否精确抵消。**机制未查明**，候选是 flush 里
`if (!anchor) return` 在重置累积因子之后返回、可能丢弃一次累积，但没能构造出触发路径。

### 6.4 `marquee` 的 `selected` 抖动

A-2 第 2 轮选中 41 个（其余轮次均为 88），该轮 p50 因此从 38.8 降到 16.8。
**此后 24 轮未再复现。**

### 6.5 A-3 与 C 会话间的漂移

A-3 的交互场景比 A-1/A-2 高 9–11%，`zoom-general` 长任务从 63 跳到 166，而 `idle-baseline`
仍是精确的 16.70。最可能是热降频或后台占用。**A/B 的差距远大于这 10%**，故结论不受影响，
但汇总必须以「每会话值 + 跨会话范围」呈现。

## 7. 与计划 §1 验收目标的对照

计划设定：1000/3000 节点且可见节点数 ≤300 时，平移与缩放 p95 < 20ms、约 60FPS；单节点拖拽
p95 < 20ms；框选 p95 < 33ms。

| 目标 | A | B | C |
| --- | --- | --- | --- |
| 平移 p95 < 20ms | ✗ 48.10 | ✗ 33.20 | ✗ **20.20**（差 0.2ms） |
| 拖拽 p95 < 20ms | ✗ 110.70 | ✗ 46.70 | ✗ 34.30 |
| 框选 p95 < 33ms | ✗ 44.40 | ✓ 29.30 | ✓ **18.60** |
| 缩放 p95 < 20ms | ✗ 430.60 | ✗ 429.50 | ✗ 416.40 |

**A、B 两组各只有一条达标，C 组两条。** 三条路径的复杂度确实被降下来了（28–54% 的实测改善），
但**没有一条达到目标**，尤其缩放路径三轮改动都没碰过，仍是最严重的短板。

## 8. 方法边界与过程教训

### 8.1 这套 harness 测不到什么

- **合成事件不等于真实输入**：无 OS 级事件合并、无 `getCoalescedEvents`、无触控板惯性、无多指
  缩放，pointer capture 被 stub。**输入延迟没有被测量**，也不能称其为下界或 INP。绝对值只能在同一
  套 harness 内部横向比较。
- **rAF 反映主线程调度节奏**，不等于合成器呈现流畅度。`longtasks` 只覆盖主线程。
- **撞到 vsync 上限的场景（C 的 pan/marquee）只能给出改善的下界。**
- **「媒体解码器数量」没有 Web API**：表中的「媒体」是已挂载且带 `src` 的媒体元素数。
- **JS 堆未采集**（`performance.memory` 是量化的且不含 DOM/媒体/GPU 内存）。
- **`JSON.stringify` 与 `setItem` 耗时未分别计量**（计划 §11 要求分开）。
- **fixture 的负载不等于真实负载**：含 `plugin:fixture`（渲染为占位）、15% `status:"loading"`、
  8% 极端尺寸、40% 带 `groupId`。
- **`marquee` 的起手是降级的**：fixture 在任何密度下都没有空白像素（密度降低时节点变少但变大），
  起始按压派发到容器而非真正空的像素。应用的判定
  `target.closest("[data-node-id],[data-connection-id]")` 对容器与对空像素结果相同，所以框选算法
  确实跑了；**但「用户能在那里起手框选」不成立**。

### 8.2 `overview-*` 两个场景**没有任何 A/B/C 对比数据**

它们被刻意移出采样集（约 2s/帧时三组都远超可用范围，改动不可能在那里体现差异），所以
**「全量挂载时约 2 秒/帧」这个结论只有早期冒烟数据支撑，不得引用为对比结果**。若需要，三组各补
一轮即可，但要知道它回答不了「P0 有没有改善」。

### 8.3 过程教训（不记下来就会重犯）

1. **`npm ci` 在本项目本来就装不上**：`@ant-design/pro-components@3.0.0-beta.3` 要求
   `antd@^5.11.2`，项目用 `antd@6.4.2`。三组必须统一用 `npm ci --legacy-peer-deps`；
   **换任何 flag 都是换依赖树，会让对比失效**。
2. **`vite preview --port X` 在 X 被占时会静默换端口**，一路向后试。曾因此让 C 组服务漂到 3016，
   而用户被指向的 3003 上蹲着另一个陈旧服务。**必须加 `--strictPort`**，并核对服务输出里实际
   绑定的端口。
3. **`TaskStop` 不会杀掉 npm 下的 vite 子进程**，孤儿会继续占端口，累积后引发上面第 2 条。
4. **端口校验不能靠标记文件**：我给主树和 C 树的 `dist/whichtree.txt` 都写成
   `C-tree(2de464a)`（主树确实在 `2de464a`），于是「服务的是 C 树」对两者同时成立、区分不出来。
   **决定性做法是比对产物哈希**（`index.html` 引用的 bundle 名），启动前校验、不一致就拒绝启动。
5. **C 组第一次会话因此作废重跑**：它跑在主树的构建上（应用代码同为 `2de464a`，但 harness 是更早
   的 8 场景版本，文件 hash 与 A/B 不符）。功能上可论证无影响，但**记录里会出现「文档声称一致、
   实际不一致」的裂缝**——多花 7 分钟换掉这个星号是值得的。

### 8.4 拒收路径已验证（计划 §13 第 9 步）

三条路径已受控验证（临时注入故障，跑完撤销）：交互派发但未生效 → `pan-had-no-effect`；
等静默超时压到 1ms → `idle-timeout`；**真实切标签页** → `page-not-visible`（三轮全拒）。
第一条最关键：事件全部派出去了，只检查「有没有派发事件」的 harness 会通过该轮并报出正常的
16.7ms。

## 9. 复现方式

```bash
git worktree add --detach H:/WebDev/ia-before    dbdd607   # A
git worktree add --detach H:/WebDev/ia-p0-after  629a052   # B
git worktree add --detach H:/WebDev/ia-c         2de464a   # C
```

**每棵树都要打同一份插桩。** 插桩本身不提交到那些提交上（它们是 detached HEAD），全部可从主树
`746c99e` 复制——所以 worktree 可以随时删除再重建，不会丢东西：

```bash
SRC=H:/WebDev/infinite-atelier/web        # 主树，已含 harness 与插桩后的 project.tsx
T=H:/WebDev/ia-c/web
mkdir -p "$T/src/assets" "$T/src/types" "$T/src/lib/canvas" "$T/src/components/canvas"

# 1) 12 个共享文件整份复制（其中 4 个在 A/B/C 三提交间本来就与主树逐字节相同）
for f in src/lib/perf-mode.ts src/types/assets.d.ts src/assets/perf-pixel.svg \
         src/lib/canvas/canvas-perf-bridge-state.ts src/lib/canvas/canvas-perf-harness.ts \
         src/lib/canvas/canvas-fixtures.ts \
         src/components/canvas/canvas-perf-bridge.tsx src/components/canvas/canvas-perf-panel.tsx \
         src/main.tsx package.json src/lib/localforage-storage.ts src/services/image-storage.ts; do
  cp "$SRC/$f" "$T/$f"
done

# 2) 在 project.tsx 插两行（锚点行在 A/B/C 三提交间逐字节相同，所以是确定性插入）
#    import 行插在  import { CanvasNodeContextMenu } …  之前
#    渲染行插在  <main className="flex h-full min-h-0 overflow-hidden" …>  之后
```

插桩后的各组 diff 应恰好是：`package.json` +1、`localforage-storage.ts` +15/−4、`main.tsx` +7、
**`project.tsx` +2**、`image-storage.ts` +3/−1，外加 `canvas-fixtures.ts`（A 树为新文件、B/C 为
+23/−2）与 7 个新文件。**`project.tsx` 只有 +2 行**是「未顺带移植优化代码」的判据。

然后安装与构建：

```bash
for d in ia-before ia-p0-after ia-c; do
  (cd H:/WebDev/$d/web && npm ci --legacy-peer-deps && npm run build:perf)
done

# --strictPort 必须加：端口被占时宁可失败，也不要静默漂移到别的端口
H:/WebDev/ia-before/web/node_modules/.bin/vite   preview --strictPort --port 3001
H:/WebDev/ia-p0-after/web/node_modules/.bin/vite preview --strictPort --port 3002
H:/WebDev/ia-c/web/node_modules/.bin/vite        preview --strictPort --port 3003
```

每次会话用全新 `--user-data-dir`（见 §2 完整参数），面板里填会话标签，点 Run session，
**跑完前不要切换标签页或窗口**。交错顺序见 §3。

**每次会话必须核对**：`canvas` 为 `1631x914`；`edges` 与 §4.4 相符；启动前用产物哈希确认端口
服务的确实是目标那棵树。任一不符即该会话作废。

## 10. 配套文档

- `CANVAS_BASELINE_MEASUREMENT_PLAN.md` —— 测量方案（权威）
- `CANVAS_PERFORMANCE_OPTIMIZATION_PLAN.md` —— P0/P1/P2 实施设计，§7 记录了 P0 的落地情况
