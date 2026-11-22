# P3.4a：首帧、首尾帧、多参考图真实 ComfyUI 输入模式验收

实施日期：2026-11-22。Infinite Atelier `custom` 分支。

## 本轮目标和证据

按《故事、剧集、资产与分镜配置流水线三期方案》第三期的真实或等价渠道验收约束，补齐此前仅有 TS/Node 能力声明与端口映射模拟测试、而未在真实 ComfyUI 上传图片、产生视频并验证**实际帧内容**的缺口。

新增 `web/server/backend/drama-p34a-comfy-inputs.test.mjs`，并纳入现有 `npm run test:drama-p3` 标准回归。测试只用本机 `http://127.0.0.1:8188` 已安装的 `LoadImage`、`ImageBatch`、`EmptyImage`、`PrimitiveString`、`CreateVideo`、`SaveVideo`，没有远程 API、计费模型请求、扩散推理、MiniMax H3 权重执行，也不触碰用户现有 ComfyUI 工作流或生产项目。

## 真实图片、输入与输出契约

使用确定性的 64×64 RGBA **真正合法的 PNG**（生成原始像素、zlib 压缩及 CRC32），以 `blobStore.put(...,{mime:"image/png"})` 进入隔离 CAS；三张文件的 SHA256 不同，以规范的 `atelier_<sha>.png` 文件名上传到真实 ComfyUI `/upload/image`。输入请求的来源采用画布 IMAGE 源节点、对应连线、`externalInputs.assetId/sha256` 以及完整 `comfyTemplate.mediaUseCase` 声明。预检调用真实 Atelier `POST /shot-batches/inspect`，仅通过已安装节点和真实映射的能力模式。

| 视频模式 | 已冻结的媒体能力 | 实际 Comfy 图输入 | 解码后应有的视频帧 |
|---|---|---|---|
| `first_frame` 首帧 | `first_frame` 1 张 IMAGE | 红色 CAS PNG 经 LoadImage → ImageBatch.image1；image2 为默认黑图 | 红 → 黑，2 帧 |
| `first_last_frame` 首尾帧 | `first_frame` + `last_frame` 各 1 张 | 红 → ImageBatch.image1；绿 → ImageBatch.image2 | 红 → 绿，2 帧 |
| `omni_reference` 多参考 | `reference_image` 1～3 张，实际传入 3 张 | 红、绿 → 第一层 ImageBatch；蓝 → 第二层 ImageBatch.image2 | 红 → 绿 → 蓝，3 帧 |

以上图像可通过解码帧像素验证，所以不会将三种逻辑仅以“请求受理”判为通过。每个 mode 使用独立的模板修订摘要。三个工作流产出真正的 MP4（8 fps），由 Comfy adapter 下载真实产物、写 CAS、进入 `artifacts` 和 `materializations`，再使用本机 FFmpeg 解码为 RGB24 后对中心像素与原始输入颜色逐帧对照，允许 H.264 压缩产生的有限误差。

测试同时校验：真实编译结果 `comfy_job_preparations.graph_json` 中每个 `w_node__loader_<port>` 均是指向匹配 SHA256 文件的 `LoadImage`；指定 `ImageBatch` 端口的 link 对应正确的加载节点；没有错误使用资产 B、忽略最后一张图、接错顺序或把图片作为纯字符串输入。

## 负例与提交安全

- 单元测试：拒绝丢失必需图片、模板未声明模式、同一目标端口的多来源和未成功 staging 的媒体文件。
- 真实后端 `/shot-batches/inspect`：三种模式分别确认正例 ready，且每种都拒绝“完全没有输入图片”和“未声明 `text_to_video`”的假请求。
- **所有预检结束后 Jobs 数严格为 0**；只有用户显式 `POST /shot-batches` 才创建三个独立 Job。测试提交后无重复 Job；模板输出符合 Comfy 绑定，且 3 个 MP4 均完成真实物化。

## 执行方式与兼容性

```powershell
cd web
$env:ATELIER_TEST_LOCAL_COMFY='1'
npm run test:drama-p3
```

或单独执行：

```powershell
$env:ATELIER_TEST_LOCAL_COMFY='1'
node --test server/backend/drama-p34a-comfy-inputs.test.mjs
```

开关未设置时，只执行不涉及 Comfy 服务的能力合同和安全负例；真正的集成用例会标为 SKIP，**不能把 SKIP 计为真实验收成功**。开启开关时必须 0 SKIP。用例会删除自己的临时数据库、CAS 和素材，不使用用户私有 PNG 图片或本地已有模型。

### 发现并处理的测试数据及竞争条件

第一次本机执行时，Comfy 三个 Job 全部 succeeded，但自动物化器处于 retry；原因是新测试的简化画布 `comfy:workflow` 没有真实 UI 必需的 `position/width/height`，物化器按正常画布节点坐标定位新视频节点时抛错。将测试节点修正为实际画布结构，并明确声明 `comfyPorts.video` 后，同一真实测试 **3/3 PASS、0 SKIP**，三个输入模式的视频逐帧校验均通过。此处没有修改生产物化器，也不将错误误报为 Comfy 模型输出失败。

纳入完整 P3 运行后，旧 `P3.2f` 两次重启用例在多组 Comfy 同时运行时存在测试完成条件的竞态：它只等待三个 Job `succeeded` 就马上断言三个异步物化记录存在；改为在原超时内等待 `succeeded` **且**三个 `materializations.status='materialized'` 后才结束轮询。原超时和独立 Job 不重复提交的断言保留。

## 本轮最终回归结果

在 Windows 本机 `http://127.0.0.1:8188` 实际测试：

- `ATELIER_TEST_LOCAL_COMFY=1 npm run test:drama-p3` **15/15 Node PASS + 16/16 Vitest PASS，0 FAIL，0 SKIP**。三个真实 ComfyUI 测试都通过：新增三模式 PNG 上传/连线/解码用例 **10,953.65 ms**；P3.2f 故障恢复 **10,591.83 ms**；原三镜头连续尾帧 **7,744.40 ms**。
- `npm run test:drama-p33` **142/142**；P1 **35 Node + 11 Vitest**；P2 **74/74**；真实 Chrome **64/64**（在线 Provider POST 0）。`npm run typecheck` 与 `npm run build` 成功。项目已有 Vite chunk 警告与测试环境偶发 `localhost:3000 ECONNREFUSED` stderr，不影响相关测试的成功退出码。
- **代码变化仅新增测试及修改 `test:drama-p3` 注册，旧 P3.2f 测试补一个异步物化完成条件；未修改生产视频生成实现、媒体能力状态机、SQLite Schema 或用户 Comfy 配置。**

## 验收边界与下一阶段

本轮严格验证本地 ComfyUI 的**视频输入数据与端口真实执行、产物实际画面顺序及 CAS 落盘**，而不是对任何扩散／视频模型的首尾帧生成语义、画质或推理耗时作保证。具体 AI I2V 模型在模型安装和资源许可后应另做权重实测。

P3 后续建议：**P3.4b** 200 画布元素／100 镜头／50 资产的真实浏览器 FPS、长帧和内存基线；**P3.4c** ZIP 容量与失败诊断、旧项目迁移兼容验收。保留原 13 项用户未提交更改。
