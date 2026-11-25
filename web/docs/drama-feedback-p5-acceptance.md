# 创作工作区信息反馈 P5 · 真实环境验收

基线：custom / 9982cb1（P4）。本轮验收针对 P1–P4 的信息反馈改造；现有画布全局性能、媒体执行链路作为兼容性门槛单独记录，不能用组件测试替代真实环境验证。

## 1. 结果与复测入口

| 项目 | 结果 | 复测入口（web 目录） |
| --- | --- | --- |
| 前端 drama 回归 | 28 文件、215/215 PASS | npm exec -- vitest run src/features/canvas-assistant/drama- |
| TypeScript | PASS | npm run typecheck |
| 生产构建 | PASS（11.18s） | npm run build |
| 三节点真实 Chrome 反馈 | 35/35 PASS，0 browser exceptions | npm run test:drama-feedback-browser |
| 200 节点 / 200 镜头真实工作区 | PASS，0 browser exceptions | npm run test:drama-storyboard-p5-browser |
| 真实在线文本候选 | PASS，1 次真实 POST | node scripts/drama-p1-isolated-live.mjs --ack-cost |
| 生产画布三轮平移、三轮缩放 | P5.2 默认无 Trace 复测 5/6，首次缩放未达标 | npm run benchmark:drama-p34b:production:strict |
| 真实 ComfyUI 后端集成 | P5.1 修复后串行 16/16 PASS（含新增预检回归），0 SKIP；带计时及默认传输各通过一次 | 见下文 |

Python Chrome CDP 依赖 websocket-client；本机缺少时仅安装至系统临时目录，通过 sys.path/PYTHONPATH 注入，没有修改全局 Python 环境。测试夹具后端、SQLite/CAS、Chrome profile 均独立于用户正式数据，不修改模型渠道或凭据，不主动重启既有服务。生产构建文件不进入版本库。

## 2. 专项真实浏览器

新增 scripts/drama-feedback-chrome-e2e.py，使用真实 Chrome、Vite、Fastify 与确定性文本模型夹具（真实在线 Provider POST=0）。三类节点均验证：
- 当前节点进入完整工作区，无上一节点遗留提示。
- 生成中状态；成功 Toast 使用工作区主题、在容器边界内且采用绝对定位；自动切换至生成候选。
- 资产候选实际可见，剧集及分镜最新运行记录自动展开并显示候选；不自动采用。
- 关闭后 Toast、持久错误、任务状态与工作区卸载；观察超过 3 秒，新增候选轮询请求为 0。

原 test:drama-p1-browser 的历史断言在第一个已移除的资产内联分页入口超时，已保存失败结论；不将旧脚本算作 PASS。新增独立反馈验收入口而非放宽旧断言。夹具仅在 ATELIER_DRAMA_FEEDBACK_E2E=1 下根据阶段及目标集数返回候选并有短延时，旧 P1 夹具默认行为保持不变。

现有 scripts/drama-storyboard-p5-chrome-e2e.py 扩展 Toast 边界及主题、取消不提示成功、关闭和重开隔离断言。实测 200 节点、200 镜头、50 资产、4 剧集，15 行分页；全选 200 镜跨页保留、定位镜头、真实 CAS 图片选择、未提交草案保护、保存成功提示与实际落库、取消无写入、真实视频 Config 创建不提交 Job 均通过。

| 开发构建指标 | 深色 | 浅色 |
| --- | ---: | ---: |
| 完整编辑器打开 | 2187 ms（冷启动） | 438 ms |
| 批量配置打开并选择全部剧集 | 532 ms | 78 ms |
| 翻页 | 47 ms | 47 ms |
| 批量页 GC 后 JS Heap | 32.9 MiB | 35.1 MiB |

重开完整编辑器 281 ms。数值仅为当轮真实浏览器观测，不将冷/热缓存及不同主题的差值解释为主题性能差异。

## 3. 真实在线文本模型

实际已配置 openai_compatible / DeepSeek V4.1 Flash 渠道，只读源数据库、DPAPI 凭据，临时项目。上游 POST 1 次（硬上限 2，自动网络重试 0），HTTP 200，耗时 9560 ms；候选 ready，4 个有效镜头，采用 HTTP 200，第一集和原视频配置及连接保留，第二集替换，确认版本 board-v2（2 条），ZIP 29551 bytes、恢复 PASS。仅证明实际文本模型闭环；浏览器的失败/取消/重试使用确定性测试，不把真实服务上的单次成功解释为实时取消/重试通过。

## 4. 生产画布压力

Chrome 158，RTX 4070 SUPER / D3D11，2048×1152 CSS，DPR 1.25，空白页约 60 FPS。200 节点、100 镜头、50 资产，70 图像、15 视频、70 连线，生产构建。三轮每种手势，严格阈值 FPS≥58、P95≤18ms、P99≤33.4ms、LongTask=0。

| 场景 | FPS | P95 / P99 ms | 结论 |
| --- | ---: | ---: | --- |
| 平移1 | 60.01 | 16.7 / 16.8 | PASS |
| 平移2 | 59.36 | 16.8 / 16.8 | PASS |
| 平移3 | 60.01 | 16.8 / 16.8 | PASS |
| 缩放1 | 54.73 | 16.9 / 16.9 | FAIL（单帧 266.6ms） |
| 缩放2 | 59.62 | 16.9 / 16.9 | PASS |
| 缩放3 | 60.00 | 16.9 / 17.0 | PASS |

LongTask 全部为 0。GC 后 Heap 增长 2.44 MiB；请求 51 次（27 次 scoped），无写入、无浏览器异常。初始 compact 图 63559 bytes。完整工作区 editor/video/runs/history 打开耗时 438/203/203/250 ms，关闭完全卸载且新增 runs 请求 0，工作区 Tab 测试新增 API 17 次、写入 0。不同硬件与刷新率不能直接与旧 RTX 3080 测试做 A/B；首次缩放掉帧仍是独立全局性能风险，未放宽阈值。

## 5. 真实 ComfyUI

本机 /system_stats HTTP 200，0.45.0；/queue 初始 running=0,pending=0。使用 ATELIER_TEST_LOCAL_COMFY=1 在临时 SQLite/CAS 上复测真实服务（轻量视频模板，不涉及扩散权重推理）。首轮同时运行两个测试文件，13 PASS / 2 FAIL / 0 SKIP，三视频跨重启与尾帧提取通过，首/尾/参考图真实测试的 inspect 返回 ready=false/reason=20，失败前驱重试用例未在期限内完成。不能直接归因于反馈 UI；先串行复测排除服务竞争，不扩大运行时超时阈值。

串行复测入口（PowerShell）：
```powershell
$env:ATELIER_TEST_LOCAL_COMFY='1'
node --test --test-concurrency=1 server/backend/drama-p34a-comfy-inputs.test.mjs server/backend/shot-groups.test.mjs
```

串行复测：14 PASS / 1 FAIL / 0 SKIP，总耗时 199.05s。P3.2f 前驱失败后的两次重启恢复通过（30.88s），三镜头跨重启与尾帧提取通过（57.09s）。P3.4a 三种输入模式用例在 109.97s 结束时，首帧与首尾帧 Job 均 succeeded 且 materialized；三参考图 Job 仍 preparing、upstream_task_id=null，尚无 preparation 记录，worker running=true/active=true/lastError=null。尚不能确定具体阻塞请求，不宣称三参考图通过。下一步需隔离跟踪 preparing 阶段的 Comfy 实例探测、模板/object_info 检查与 CAS 上传耗时，确认是否为服务响应或准备阶段阻塞；不要扩大超时掩盖问题。

### P5.1 根因定位与修复（基线 b474fe4）

在相同本地 ComfyUI 0.45.0 服务，队列空闲且测试数据隔离的条件下，直接测量真实 HTTP：完整 /object_info 返回 3066 个节点描述、JSON 5617936 bytes，8918ms；LoadImage/ImageBatch/CreateVideo/SaveVideo 的单类查询分别 9/1/1/2ms。启用 ATELIER_TEST_COMFY_TRACE=1 的修复前用例复现同一失败：12 次完整目录读取，每次 8825–9370ms；图片上传 13–53ms，/prompt 11–14ms。第 3 个 Job 在等待窗口结束时仍 preparing；随后关闭后端等待已在途的请求结束，第三个 Job 实际完成准备并提交。因此根因是反复获取全量节点定义造成的准备阶段延迟，不是三参考图端口、CAS 上传或 GPU 本身无法执行。

实现：
- compiler.mjs 计算模板 classTypes、选定输出 capture adapter、已连接 IMAGE/MASK socket 所需的 LoadImage/LoadImageMask 集合，去重排序。
- comfy-v2-adapter.mjs 在 Job 准备时按需读取 /object_info/{class}，不跨 Job 缓存，仍使用实时定义校验编译图、CAS 文件和本地镜头组限制。所有读取共享原 45s 总期限；旧服务 scoped route 404/405、超大类别集合或不适合路径编码的类别可回退全量查询。缺失类别 {} 不触发全量回退，保持编译失败语义。设置页的完整目录接口不变。
- shot-groups.mjs / runtime.mjs / comfy-instances.mjs：预检采用同一 scoped 查询；5s 缓存按实例 ID、地址、类别集合区分，成功后起算，合并同范围并发请求、失败立即驱逐，最多保留 64 个范围；保持原 10s 总期限。
- 新增确定性契约回归：捕获节点及 IMAGE/MASK 加载器、缺失类别、实时 schema 更新、旧服务回退、不对 503 回退、预检同范围共享、错误恢复及实例地址隔离。没有修改 Job 状态机、提交屏障、模板格式、数据库或测试超时。

实际复测（串行，不调整原断言）：

| 场景 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 三种输入模式真实视频用例 | 109.90s，FAIL | 3.80s（带 trace），3.41s（默认传输），PASS |
| 完整节点目录调用（同三模式 trace） | 12 次 | 0 次 |
| 单类节点定义读取 | 不使用 | 1–25ms/次，共 29 次 |
| 串行镜头组/输入模式全量 | 14/15 PASS（历史） | 16/16 PASS（新增一项），0 SKIP |
| 串行套件总耗时 | 199.05s（历史） | 11.79s（带 trace）、11.45s（默认传输） |

首帧、首尾帧、三参考图均实际生成并物化视频，逐帧 RGB 与三个原始 CAS PNG 的颜色断言通过；真实前驱重试及跨两次重启恢复、连续镜头尾帧提取通过。带 trace 的用例包装真实 HTTP transport，不记录请求体、图、文件名或密钥（runtime 对自定义 transport 禁用可选 WS 预览）；第二轮关闭 trace 使用默认真实 transport，结果仍通过。无需在线模型调用、不重启正式后端、未取消或清空用户任务。测试为轻量视频工作流，不验证扩散模型推理。

可复测命令（web，PowerShell）：

```powershell
$env:ATELIER_TEST_LOCAL_COMFY='1'
$env:ATELIER_TEST_COMFY_TRACE='1'
node --test --test-concurrency=1 server/backend/drama-p34a-comfy-inputs.test.mjs server/backend/shot-groups.test.mjs
Remove-Item Env:ATELIER_TEST_COMFY_TRACE
```

后端及编译器契约回归 89 PASS、0 FAIL、3 项显式 live SKIP（已由上述真实测试全部补跑）；TypeScript 通过。P5.1 判定 PASS。

### P5.2 首次缩放 GPU 光栅化诊断（基线 3b13630）

相同隔离 200/100/50 fixture、生产构建、Chrome 158 / RTX 4070 SUPER D3D11、2048×1152 CSS / DPR 1.25、空白页约 60 FPS。严格目标、手势序列和计时区间不变。Trace 独立于无采样的严格验收。

第一轮默认 GPU Trace 共 377161 事件，首次缩放帧间隔 283.1ms。按 rAF 间隔对应时间窗的重叠事件检查：
- CrGpuMain ThreadControllerImpl::RunTask 225.68ms（与该时间窗重叠 202.77ms），内部 RendererRasterWorker 225.64ms / RasterDecoderImpl::DoEndRasterCHROMIUM::Flush 224.95ms。
- DawnPlatformImpl::RunWorkerTask 217.62ms；所在 worker 外层任务 217.64ms（重叠 202.1ms）。
- CrRendererMain 最大完整任务 10.13ms（其中 1.31ms 与窗口重叠）；另外 Layerize 6.65ms、React/JS 回调 6.13ms、MinorGC 0.94ms。Long Task=0。
- GPU Trace 是嵌套且跨线程的事件，不能求和；rAF 标记的时间窗为近似相关范围，不是精确因果链。已定位主要长耗时所在管线，不宣称定位具体 GPU shader 或绘制对象。

对照实验（每种三轮平移、三轮缩放）：

| 构建/环境 | 首次平移 FPS / max | 首次缩放 FPS / P95 / max | 达标轮次 |
| --- | --- | --- | --- |
| 默认 GPU Trace | 56.91 / 100.0ms | 54.88 / 16.9 / 283.1ms | 4/6（诊断） |
| 仅手势期间 world will-change:transform，结束移除 | 54.23 / 133.3ms | 55.91 / 16.9 / 216.7ms | 4/6 |
| 仅固定工具栏/小地图纯色代替 backdrop blur | 56.29 / 100.1ms | 54.60 / 16.9 / 266.6ms | 4/6 |
| 原始产品代码，禁用 SkiaGraphite 的 Trace 对照 | 59.45 / 33.3ms | 55.05 / 33.3 / 83.3ms | 5/6（诊断） |
| 撤回两项产品实验，默认 GPU 无 Trace 严格复测 | 60.01 / 16.9ms | 53.97 / 16.8 / 266.6ms | 5/6，FAIL |

禁用 Graphite 的测试使用独立 Chrome 进程参数 --disable-features=SkiaGraphite；同样显示 ANGLE NVIDIA D3D11，Trace 中 DawnPlatformImpl::RunWorkerTask 由 8 个变为 0 个，首次缩放长帧窗口内最大 GPU 完整任务由 225.68ms 降到 32.46ms。它支持 Graphite/Dawn 光栅化后端参与长帧的判断，但单次对照不能证明具体 shader 编译或驱动缺陷，也未解决持续帧率不足；不是正式产品解决方案。未修改系统 Chrome 配置。两项产品优化实验均撤回，未修改 UI 外观、分辨率或画布手势策略。

恢复默认构建后的无 Trace 正式复测：

| 场景 | FPS | P95 / P99 ms | 最大间隔 ms | 结果 |
| --- | ---: | ---: | ---: | --- |
| 平移1 | 60.01 | 16.8 / 16.9 | 16.9 | PASS |
| 平移2 | 60.01 | 16.9 / 16.9 | 16.9 | PASS |
| 平移3 | 60.00 | 16.7 / 16.7 | 16.8 | PASS |
| 缩放1 | 53.97 | 16.8 / 33.3 | 266.6 | FAIL |
| 缩放2 | 58.84 | 16.9 / 16.9 | 50.1 | PASS |
| 缩放3 | 60.00 | 16.9 / 16.9 | 17.0 | PASS |

LongTask=0；GC 后 JS Heap 增长 2.38 MiB；51 次 API 请求（27 次 scoped），无写入、无浏览器异常。工作区 editor/video/runs/history 437/204/187/234ms，关闭后新增候选轮询 0。严格脚本实际非零退出，P5.2 **BLOCKED**。

新增诊断入口，使用 Python websocket-client（临时 venv 依赖，不需修改全局环境）。在 web 目录：

```powershell
npm run build
python scripts/drama-p34b-chrome-perf.py --gpu --mode production --rounds 3 --workspace-tabs --trace-zoom "$env:TEMP/atelier-p52-default.json"
python scripts/drama-p34b-chrome-perf.py --gpu --mode production --rounds 3 --workspace-tabs --trace-zoom "$env:TEMP/atelier-p52-legacy.json" --legacy-raster-diagnostic
npm run benchmark:drama-p34b:production:strict
```

Trace 在独立浏览器级 CDP websocket 采集，首次缩放后以 ReturnAsStream 读取；保存完整原始 JSON 至指定绝对路径（不入版本库），摘要按时间窗、实际 pid/tid 输出最长事件和重叠时长，记录 Dawn worker 事件数。Trace/CPU Profile/光栅化对照均禁止与 --enforce-targets 混用。严格模式不会添加 Trace 标记、浏览器 feature flag 或预热手势。诊断对照只用于证据，不算严格通过。

后续：针对首次缩放窗口添加更细粒度 layer/tile/raster/Skia pipeline 事件，区分连接位图、媒体裁剪、节点/文本绘制各自贡献；优先在实际桌面 Chrome 与相同驱动重复冷启动对照，必要时测试另一浏览器版本/驱动环境。只有定位可由应用控制的绘制热点并在无 Trace 默认环境稳定复测达标后，才接受产品代码修改。不得用关闭 Graphite、关闭 GPU、额外预热或缩短测量窗口替代验收。

## 6. 判定

P1–P4 信息反馈改造的前端回归和三节点真实浏览器专项已通过；真实文本生成及工作区大规模分页通过。P5.1 真实 ComfyUI 已通过，历史失败保留为根因证据。P5.2 已完成 GPU 管线定位及实验诊断工具，但默认生产环境首次缩放仍未达标，整体 P5 继续 BLOCKED；不以部分通过或更改浏览器后端替代全量验收。
