# P3.4b5 性能 A/B 与 P3 兼容收尾：第一轮工程验收

日期：2026-11-22。当前代码基线：`custom` / `c208219`；旧版对照：`a2b8044`（P3.4b2）。
**验收状态：Blocked / 继续优化，不允许标记 P3.4b 整体完成。** 生产环境缩放 P95 仍超过 ≤18ms 的硬性目标。

## 1. 生产与开发构建真实 A/B

同一套隔离的 Fastify+SQLite/CAS fixture：**200 节点、100 分镜、50 资产、70 图像、15 视频、70 条连线**。Chrome 157 headless-new，Windows 11 / RTX 3080 D3D11，2048×1152 CSS，DPR=1.25，浏览器 blank cadence P95≈6ms。通过真实 CDP 中键鼠输入，不用假 DOM、伪造网络、线上模型或用户数据库。每种构建、每种手势各三轮；各版本使用独立 Git worktree 和独立生产构建，读取相同后端 fixture。

| 版本 / 模式 | 平移 FPS 中位数 | 平移 P95（3轮 ms） | 缩放 FPS 中位数 | 缩放 P95（3轮 ms） | P99 缩放范围 | Long Task 合计 | GC 后 Heap 增长 |
|---|---:|---|---:|---|---|---:|---:|
| a2b8044 开发 | 91.2 | 41.2 / 29.4 / 35.3 | 85.1 | 35.3 / 35.4 / 29.4 | 35.4–47.1 ms | 5 | +4.71 MiB |
| c208219 开发 | 97.7 | 41.2 / 35.2 / 29.4 | 89.4 | 35.3 / 35.3 / 29.5 | 35.3–47.0 ms | 3 | +3.03 MiB |
| a2b8044 生产 | 132.9 | 11.9 / 11.8 / 17.6 | 99.8 | 23.6 / 23.6 / 17.7 | 23.5–35.3 ms | 0 | +2.58 MiB |
| c208219 生产 | 130.5 | 11.9 / 17.6 / 17.6 | 101.5 | 23.6 / 23.6 / 17.7 | 23.5–29.5 ms | 0 | +2.48 MiB |

每个场景严格要求 **FPS≥58，P95≤18ms，P99≤33.4ms，Long Task=0**。四种条件均有失败轮次：开发构建主要受组件构建/调度影响，生产构建平移已接近或满足门槛，缩放 P95 仍有约 23.6ms。单次 3 轮的改进差异不能直接解释为稳定收益，不得宣称 P3.4b3/4 提升了整体画布缩放性能。

网络与内存：两个生产构建均记录 `totalApiRequests=50`、`scopedRequests=25`，可见 DOM 节点最终数均为 48，初始 compact Graph 均为 63,559 bytes、3 个 creative pointer；二者均没有媒体写请求和浏览器异常。此 fixture 只有两张剧集/分镜轻卡，**不足以证明可见卡存在大规模摘要 N+1 性能问题**，暂不新增批量 Summary API。

## 2. 两项优化实验：验证后撤回

曾以 `c208219` 生产版为前测基线试验：① WebGL 网格相同视图帧去重；② 将滚轮几何同步间隔 48ms→64ms，仍保留 >200px 位移或 1.12 倍缩放触发提前同步。每种实验均对平移/缩放各运行 3 轮：

- 仅网格去重：平移 P95 为 17.7/11.8/11.8ms，缩放 P95 为 **29.3/23.6/17.7ms**，仍失败。
- 网格去重 + 64ms 几何提交：平移 P95 为 17.6/11.9/17.7ms，缩放 P95 为 **29.3/23.5/17.7ms**，P99 缩放有 35.2ms，仍失败。
- 与原版生产缩放 23.6/23.6/17.7ms 相比，收益不稳定甚至出现退化；**两项代码修改均已撤回**，没有以牺牲视图追踪/交互延迟换取虚假的达标成绩。

Chrome DevTools `Profiler` 的独立诊断轮次中，开发构建部分 CPU 自样本落在 React `jsxDEV/createElement`，但大量样本属于 idle/(program) 和浏览器内部；采样运行时会引入开销，不纳入未采样的 A/B 数值结论。建议下一轮在**生产构建**获取 DevTools trace（Recalculate Style / Layout / Paint / Composite / Raster / WebGL Grid 的具体耗时），再确定具体热点，避免只靠提升节流阈值猜原因。

## 3. 真实工作区 Tab 压测

在生产构建同一个 200/100/50 fixture 中，先完成所有手势测量再打开页面级分镜 Modal：
- 首次打开完整编辑 Tab：422ms；
- 视频配置 Tab：203ms，DOM 节点约 1962；
- 生成候选 Tab：188ms，DOM 约 1900；
- 影响与历史 Tab：203ms，DOM 约 1902；
- 关闭后子树完全卸载，观察超过一轮 3s interval，`/runs` 新请求数 **0**；
- Tab 全程 API 请求增加 12 次、写请求 **0**，无模型/ComfyUI 提交；关闭后采集 GC Heap。

**注意：** 本项测试验证的是真实浏览器 UI 的模块挂载、索引读取与轮询生命周期；fixture 未配置在线模型或真实 ComfyUI 视频生成。真实 P3 媒体工作流仍须独立的联机验收，不等同于 Tab 压测通过。

## 4. 回归验收

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run test:drama-p1-browser`：**102/102 PASS**，真实 Chrome + deterministic mock，含 P3.4b4 两字段 CAS 并发冲突、完整工作区切换、候选生成与采用、版本确认、镜头组和 ZIP 还原；在线 Provider POST 为 0。
- `npm run test:drama-p2`：**74/74 PASS**；`npm run test:drama-p33`：**142/142 PASS**；`npm run test:drama-p3`：**12/15 Node PASS（3 项本地 ComfyUI SKIP）+ 29/29 Vitest PASS**。P2、细粒度 Indexed CAS 与 P3 契约回归完成，但被跳过的真实媒体生成不能宣称通过。

## 5. 可复测工具与环境隔离

新增/升级：
- `web/scripts/drama-p34b-chrome-perf.py` 支持 `--mode development|production`、`--rounds 3`（最少 3）、`--frontend-root <BASELINE_WEB_DIR>`、`--label <REVISION>`、`--cpu-profile`、`--workspace-tabs`、`--output <ABSOLUTE_JSON>`、`--enforce-targets`。记录 FPS、P50/95/99、Long Task、脚本/Layout/样式耗时、网络、GC Heap、WebGL Renderer 和空白页基准，严格失败时返回非零。
- `web/scripts/drama-p34b-static-frontend.mjs` 只监听 loopback，提供生产构建 `dist` 的静态资源并将同源 `/api/v1` 转发至本次临时 fixture；禁止任意外网代理。开发模式仍使用独立 Vite 代理。
- `web/package.json` 增加 `benchmark:drama-p34b:production` 与 `benchmark:drama-p34b:production:strict`，明确要求先运行 `npm run build`；原有开发版脚本现在每种手势默认 3 轮。
- 旧版本由 `git worktree add --detach <TEMP_WORKTREE> a2b8044` 获取；在旧版 `web` 中以 Windows junction 指向**当前工程相同版本**的 `node_modules` 后构建 `dist`；把该 `web` 路径传给 `--frontend-root`。永远不要 checkout/重置用户的 dirty `custom` 分支来做对照。
- 示例：`python scripts/drama-p34b-chrome-perf.py --gpu --mode production --rounds 3 --workspace-tabs --label current --output <ABSOLUTE_JSON>`；开发对照去掉 `--workspace-tabs` 并改为 `--mode development`。
- 用户已有的 13 项未提交文件不参与测试修改、提交或清理。

## 6. 后续阻塞项

1. 必须进一步诊断生产构建**缩放 P95 23.6ms / 偶发 P99>33.4ms**的来源并针对性修复，而不是放宽验收目标。
2. 生产版与开发版至少各 3 轮的 A/B 已完成第一轮，但下一轮优化后仍要复跑并确认稳定收益；保留失败 evidence。
3. 在可用的本地 ComfyUI/已有媒体工作流环境补跑视频首帧、首尾帧、参考图、镜头组等真实执行测试；本轮隔离 fixture 不触发真实付费模型/媒体任务。

**判定：本轮完成 P3.4b5 的基准平台、第一轮 A/B、Tab 压力与兼容验收工作；严格性能门槛未通过，P3.4b5 不能标记全部完成。**
