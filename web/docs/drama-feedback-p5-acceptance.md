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
| 生产画布三轮平移、三轮缩放 | 5/6 达标，严格门槛未通过 | npm run benchmark:drama-p34b:production:strict |
| 真实 ComfyUI 后端集成 | 并发首轮 13/15 PASS；串行 14/15 PASS；均 0 SKIP | 见下文 |

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

## 6. 判定

P1–P4 信息反馈改造的前端回归和三节点真实浏览器专项已通过；真实文本生成及工作区大规模分页通过。P5 完整门槛需保留真实 ComfyUI 及整体画布性能的不通过/待验证项，不以首轮通过的部分代替全量验收。
