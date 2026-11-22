# P3.4b：200 元素真实 Chrome 性能、局部分页与内存基线

验收日：2026-11-22。分支 `custom`。本轮定位为 **P3.4b 性能基线已建立、局部读取已验收，但严格帧稳定性未达标**；不把平均 FPS 高于 60 或测试脚本退出码为 0 误报为 60 FPS 无卡顿。

## 测试对象和隔离

新建 `web/scripts/drama-p34b-browser-fixture.mjs` 和 `web/scripts/drama-p34b-chrome-perf.py`，真实调用 Fastify + SQLite + CAS，真实 Chrome CDP 驱动用户层平移和鼠标滚轮缩放。后端服务由临时目录构造，不连接已启动的用户项目，没有 ComfyUI 或任何在线渠道调用、没有自动生成、没有写入用户数据集。测试进程、Chrome profile 与后端都在结束时清理。

- 项目图 **200 节点**：3 个创作节点（资产／剧集／分镜）、97 个文本节点、70 个真实 CAS 图片节点、15 个真实 MP4 视频节点、15 个视频 Config；70 条节点连线。
- 分镜 **100 个镜头**，分布在 **4 集、每集 25 镜头**，每集有 3 个场次；独立资产 **50 个**。媒体由脚本创建、SHA 校验并存入临时 CAS；视频用 FFmpeg 本地编码，Chrome 预览无需网络模型。
- Chrome **157.0.8103.79**，真实 Windows，2048×1152 CSS 视口、`devicePixelRatio=1.25`，相当于 2560×1440 的设备像素负载。无头浏览器 `document.visibilityState=visible`；每轮实际用 CDP `Input.dispatchMouseEvent` 产生鼠标中键平移和 `mouseWheel` 缩放，不通过直接改 React viewport 伪造。
- 同一负载分别运行 `--gpu`（`ANGLE (NVIDIA, GeForce RTX 3080, Direct3D11)`）与禁用 GPU 的对照（`ANGLE (Microsoft, Basic Render Driver, Direct3D11)`）。空白页 rAF 基线只作为环境描述，不用于放宽性能门槛。脚本测量 rAF 帧间隔、Long Task、Chrome Performance 脚本／布局／样式耗时及手动 GC 后 JS 堆内存。- 浏览器加载的是 **Vite 开发服务构建**，不是经压缩优化的正式生产构建；这是 P3 大项目真实功能链路的开发态交互基线，不能据此推断上线包在用户桌面上的实际 FPS。下一轮 GPU 性能剖析应补齐生产构建对照。

## 严格门槛

沿用工程原有 `canvas-perf-review.mjs` 的逐轮门槛：

- 平均 FPS **≥58**
- P95 帧间隔 **≤18 ms**
- P99 帧间隔 **≤33.4 ms**
- **0 项 Long Task**（PerformanceObserver `longtask`，约 50 ms 以上的任务）

任一轮未满足即为 `below-target`。本轮没有使用空白页校正来“算通过”，也不把 FPS 平均值当作低长帧的替代。

## 真实测量结果

| GPU | 场景 | 平均 FPS | P95 ms | P99 ms | Long Tasks | 结果 |
|---|---|---:|---:|---:|---:|---|
| NVIDIA RTX 3080 / D3D11 | 平移 #1 | 96.51 | 37.9 | 44.6 | 1 | 未达标 |
| NVIDIA RTX 3080 / D3D11 | 平移 #2 | 105.67 | 27.4 | 39.0 | 0 | 未达标 |
| NVIDIA RTX 3080 / D3D11 | 缩放 #1 | 90.55 | 32.4 | 44.3 | 2 | 未达标 |
| NVIDIA RTX 3080 / D3D11 | 缩放 #2 | 94.85 | 32.4 | 40.0 | 0 | 未达标 |
| Basic Render Driver / 软件 | 平移 #1 | 24.56 | 66.7 | 66.7 | 2 | 未达标 |
| Basic Render Driver / 软件 | 平移 #2 | 26.80 | 50.0 | 50.1 | 1 | 未达标 |
| Basic Render Driver / 软件 | 缩放 #1 | 42.70 | 50.0 | 50.1 | 2 | 未达标 |
| Basic Render Driver / 软件 | 缩放 #2 | 44.21 | 50.0 | 50.1 | 1 | 未达标 |

同轮空白页 rAF 基线：GPU **152.26 FPS，P95 7.1 ms**；软件渲染 **60.00 FPS，P95 16.8 ms**。因此差异不是直接拿两个不同刷新率的环境 FPS 相减得出“加速倍数”，而是展示两个环境的原始帧时。两者都**没有**达到零长帧严格目标。

GPU 真实交互期间，Chrome Performance 的 ScriptDuration 平移约 **0.88–1.08 s/轮**、缩放约 **1.20–1.24 s/轮**；对应 LayoutDuration 只有 **0.014–0.024 s/轮**、RecalcStyleDuration **0.015–0.031 s/轮**。这是**阶段性定位线索**：当前脚本执行负担比布局/样式耗时更明显；尚不能仅据此归因到一个函数或证明 React、网格绘制、合成中的单一瓶颈。下一轮应在 RTX 3080、相同工况下采 JS CPU profile/Timeline，定位具体热点再做最小改动及 A/B 复测。

## P3.3 局部读取、分页与内存

实际浏览器仅加载 `GET /api/v1/projects/:id?creative=summary`：响应 **63,559 字节**，恰好 200 节点、3 个 creativePayloadRef，**没有内联 `dramaDraft`／`dramaConfirmed`**。前端未点击“打开创作内容”；此按钮会加载完整编辑器，不能混进按需浏览基准。初始 DOM 只渲染约 56 个可见节点，结束时约 48 个（视区剔除正常）。

- 资产节点通过真实 UI 点“按需浏览”：**10/50 项，6,184 B**；点“下一页”请求 `offset=10` 并展示 **11–20**。
- 剧集节点通过真实 UI 点“按需浏览”：**4/4 项，2,869 B**。
- 分镜节点保持按需浏览，使用实际下拉框进行 **15 次跨集切换**，分镜数据来自 `revision-scope`，最后选中 `ep-3`；测试最终见到 **23 次 scoped GET**，0 次 POST/PATCH/DELETE，0 浏览器运行异常。
- GC 后 JS Heap（GPU）：首次加载 **57,607,660 B**，按集切换后 **61,934,136 B**，完成平移缩放后 **61,940,792 B**，相对首次加载增加 **4,333,132 B≈4.13 MiB**。软件渲染结果为增加约 **5.23 MiB**。这只说明本次有限操作的堆增长，**不能视为长期无泄漏证明**。

## 可复现命令与机器数据

```powershell
cd web
npm run benchmark:drama-p34b
npm run benchmark:drama-p34b:strict
# 第二条严格检查，只要任一轮未达到帧时门槛，就返回非零。
# 软件渲染对照：
python scripts/drama-p34b-chrome-perf.py
# 生成独立机器报告：
python scripts/drama-p34b-chrome-perf.py --gpu --output E:/Temp/p34b-perf.json
```

本次实际证据（含每轮完整 rAF/Performance 摘要、Chrome 渲染器、堆内存、API 统计）保存在：

- `web/docs/drama-p34b-gpu-baseline-2026-11-22.json`
- `web/docs/drama-p34b-software-baseline-2026-11-22.json`

脚本的普通运行退出码 0 只说明测试完整执行、数据和功能约束通过；最终结果仍为 `below-target`。启用 `--enforce-targets` 才将性能达标作为 CI 退出码条件，避免悄悄放宽标准。

## 回归测试

- `npm run test:drama-p1`：**35 Node + 11 Vitest PASS**。
- `npm run test:drama-p2`：**74/74 PASS**。
- `npm run test:drama-p3`（`ATELIER_TEST_LOCAL_COMFY=1`）：**15 Node + 16 Vitest PASS，0 SKIP**，含 3 项真实 ComfyUI 测试。
- `npm run test:drama-p33`：**142/142 PASS**。
- `npm run typecheck` 和 `npm run build`：PASS。
- `npm run test:drama-p1-browser`：**真实 Chrome 64/64 PASS**，远程模型请求 0；这项既有回归与性能测量分开执行，避免同时运行造成帧率误测。

## 结论、工程风险及后续

**P3.4b 尚未通过严格性能验收。** P3.3 的局部数据传输和可见节点剔除在真实浏览器表现正常，JS 堆没有出现本次操作的异常激增；但启用真实 RTX 3080 后，平均 FPS 达到 90–106，P95 仍有 27–38 ms 长帧。下一轮建议从 **P3.4b1：交互 JavaScript CPU profile／合成热点归因** 入手，针对最重的单一热点进行最小优化，在相同 fixture、相同 GPU/视口进行 A/B 对照，通过后再推进 P3.4c 容量、ZIP 与诊断兼容性最终验收。

本轮修改仅涉及隔离测试 fixture、真实 Chrome 测量器、benchmark npm 命令和此报告，**不修改生产画布逻辑或任何既有用户 13 项 dirty 文件**。准确区分已完成“可复现基线与分页验收”与仍未完成“无卡顿验收”。
