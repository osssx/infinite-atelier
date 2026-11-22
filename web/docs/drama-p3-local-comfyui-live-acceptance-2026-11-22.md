# P3 媒体与镜头组：本机真实 ComfyUI 验收

日期：2026-11-22。项目：Infinite Atelier `custom` 分支。**状态：已实测通过，不是 SKIP，不是模拟 Comfy 服务器。**

## 真实环境核验

- 实际连接：`http://127.0.0.1:8188/system_stats` 返回 **HTTP 200**，ComfyUI 版本 **0.45.0**。
- `/queue` 初始状态：`queue_running=0`、`queue_pending=0`。
- `/object_info/{EmptyImage,CreateVideo,SaveVideo,PrimitiveString}` 全部返回真实节点描述和参数，节点已安装。
- 本机 `nvidia-smi`：`NVIDIA GeForce RTX 3080`，显存 20 GiB；`ffmpeg` 和 `ffprobe` 均在 PATH 中。此测试使用纯色帧生成视频，不依赖扩散模型推理，因此 GPU 空闲并不代表模型推理验证。
- 先前每轮 P3 回归 **1 项 SKIP** 的直接原因是测试文件以 `ATELIER_TEST_LOCAL_COMFY` 环境开关跳过真实集成用例；此处明确设置该开关后执行，避免继续把 SKIP 写成通过。

## 实际运行命令及结果

单独验证真实镜头组服务：

```powershell
cd web
$env:ATELIER_TEST_LOCAL_COMFY='1'
node --test server/backend/shot-groups.test.mjs
```

**结果：6/6 PASS、0 FAIL、0 SKIP**。真实用例 `real local Comfy creates three videos across backend restart and uses the extracted final PNG` **8,774.52 ms**，全部后端用例 **9,277.60 ms**。

继续运行包含前端的完整 P3：

```powershell
cd web
$env:ATELIER_TEST_LOCAL_COMFY='1'
npm run test:drama-p3
```

**结果：6/6 Node PASS、16/16 Vitest PASS、0 SKIP**；真实用例 **8,123.75 ms**，Node 测试 **8,620.93 ms**，4 个 Vitest 文件均通过。

## 已覆盖的实际端到端条件

真实 P3 集成测试使用 `createLocalBackend({comfyInstances:[{id:"local",url:"http://127.0.0.1:8188"}],autoDispatch:true})`，临时隔离 SQLite 与 CAS/激活目录。通过同源本地会话、CSRF 与实际镜头组路由依次：

1. 创建包含三个镜头的项目与 Comfy 工作流绑定；分别调用 `shot-batches/inspect`，检查三个工作流可执行，尚未产生任何 Job。
2. 提交批量镜头生成。检查 `queued / waiting / queued`，前后镜头独立执行，连续镜头等待前驱产物。
3. **关闭并重新创建真实 Atelier 后端实例**，沿用此前的 SQLite 数据库和本地材料存储；轮询实际 Job 的执行、物化与批次状态，无 `failed`、`blocked`、`submission_unknown`。
4. 本地 Comfy 使用 `EmptyImage → CreateVideo → SaveVideo` 创建真实视频文件（64×64，3 帧，8 FPS），通过生产捕获与物化链路落库。
5. 从前驱视频经真实 `ffmpeg` 尾帧提取创建 PNG；检查尾帧来源、`tail.timeMs=250`、CAS Blob 的 `image/png` MIME 和后续连续镜头 Job 中真实绑定的 `externalInputs[0].assetId`。
6. 验证三个真实 Job 均成功，产物可追溯，重启没有重复创建视频 Job，临时测试数据库和磁盘目录最终清理。

现有非实时测试同时覆盖：等待所有 materialization 完成后的多输出选择、非法选择拒绝、停止尚未提交镜头、修改镜头顺序后的 continuity 保护，以及普通 video/config 节点作为镜头组成员。

## 验收边界

**本测试验证了真实 ComfyUI 服务调用、真实视频编码/文件捕获、ffmpeg 尾帧、跨重启状态恢复和 P3 镜头组依赖控制。** 但这里的画面来源是 `EmptyImage`，不涉及 MiniMax H3、Moss 等权重推理；所以不能声称已完成真实 AI 视频模型的画面质量或性能验收。若要独立验证 MiniMax H3 I2V，应在相应模型已安装、预设已绑定且实例空闲的前提下，另执行 `minimax-p3c2-live-acceptance.mjs` 的专用预检与显式 Live 流程。

本次无在线计费模型请求、未修改用户 Comfy 配置或运行中的工作流；三镜头测试产物保存在临时隔离目录并按现有测试设计清理。以上结果满足本轮 P3 镜头组**真实 ComfyUI 端到端集成**验收要求，随后才允许推进 P3.3i。
