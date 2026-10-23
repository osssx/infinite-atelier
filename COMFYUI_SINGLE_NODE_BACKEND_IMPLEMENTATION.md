# ComfyUI 单画布工作流真实执行 — 首版实现记录

实施日期：2026-10-23。依据 `COMFYUI_WORKFLOW_CANVAS_NODE_DESIGN.md`，采用 **单节点先闭环** 的执行范围。

## 范围 / 非范围

每次请求仅包含一个固定 `templateId@revision` 的 `comfy:workflow`；模板自身可包含完整的 ComfyUI API Format 图。显式端口连线支持 Text `text`、Image `image`（PNG/JPEG/WebP）作为外部来源；还支持实例本地 override/default 与模板安全内联值。选择一个可捕获的 IMAGE 输出 port，ComfyUI `SaveImage` 允许返回多张图片。

**未实现**：多工作流合并或 socket 互连、多个输出端口、VIDEO/AUDIO、其它 capture adapter、分布式 worker 租约、服务端 SSE、任意自定义节点自动安装、正式多用户认证体系。自动导入结果仅在画布工作流参数面板打开/重新打开时触发；关闭面板不影响后端 GPU 执行。

## 代码

- `web/server/comfy-workflow/compiler.mjs`：RunRequestV1 单节点限制；template SHA 验证、Typed Port 解析、输入唯一来源；edge > override > default > template / disconnect；外部 IMAGE 文件模式与 LoadImage socket 桥接；先插 SaveImage 捕获节点，**再反向剪枝**；最终图节点能力、连线、必填项与循环校验。
- `web/server/comfy-workflow/store.mjs`：Node 24 `node:sqlite` WAL + FULL synchronous、Run 唯一键、原始完整请求/最终 graph/capture map、状态转移与 durable staging/artifacts。文件临时写入、同步后 rename；存储路径默认 `web/.comfy-workflow-data/`，也可配置 `COMFY_DATA_DIR`。
- `web/server/comfy-workflow/service.mjs`：白名单实例；`/object_info` 校验；Comfy `/upload/image`、`POST /prompt`、`GET /history/{promptId}` 和 `/view`；一次提交、单进程单 GPU 任务调度、图片集合持久化，失败下载可再次采集。
- `web/server/ark-gateway.mjs`：使用网关原有 `GATEWAY_TOKEN` 鉴权承载 `/api/comfy/*`。
- `web/vite.config.ts`：开发环境限制 loopback + same-origin，并仅在服务器代理层注入 `GATEWAY_TOKEN`；凭据不会下发浏览器。
- `web/src/features/comfy-workflow/run-client.ts`：读取画布冻结快照、真实 Blob 上传，保存 `RunRequestV1` 在浏览器 localStorage 后提交；如果 POST 响应丢失，可使用同一幂等 key 恢复未确认的提交。
- `web/src/features/comfy-workflow/comfy-workflow-instance-panel.tsx`：单工作流参数配置与运行、状态刷新与取消；默认实例由全局 ComfyUI 设置统一指定，输出自动采用模板的 IMAGE 端口。启动运行时即写入节点 `comfyExecution`，并保存 `lastRunId`。
  - 参数面板底部统一为 `CanvasConfigNodePanel` 同款 Ant Design 主操作按钮（36px 高、整行宽度、圆角矩形、Play 图标与“开始生成”文字），上方仅显示简明任务状态（成功时附图片数量）；移除重复的实例/输出、runId/promptId、手动刷新、首版限制提示及参数计数。任务进度由画布自动轮询；保留运行中取消请求、提交未知时恢复原幂等请求以及失败错误信息。
- `web/src/pages/canvas/project.tsx`：画布级任务观察（2.5 秒轮询，独立于参数面板），更新节点运行状态 `comfyExecution`；收到成功回调后下载 Blob，通过 `uploadImage` 保存 IndexedDB 并创建 Image 节点。每张产物同时建立从工作流对应 IMAGE 输出端口到生成 Image 节点左侧的**真实画布连线**，按 artifactId 防重复；画布重载时恢复运行任务并为旧图片补全丢失的来源连线。
- `web/src/features/comfy-workflow/artifact-layout.ts`：同一工作流跨多次 run 的多图分格布局，采用实际图片比例生成画布节点尺寸，避免异步批次导入、再次运行时图片节点重叠。
- `web/src/features/comfy-workflow/run-status.ts` 与 `web/src/components/canvas/canvas-node.tsx`：工作流节点显示真实提交/排队/执行/回收/导入状态的转圈动画；成功、失败、取消和不确定提交时停止旋转并显示状态/错误。
- **选中工作流节点的顶部工具栏**新增「执行」按钮（播放图标），可直接运行，不必打开参数面板。顶部按钮与参数面板按钮共用画布级执行入口：加载已绑定的不可变模板、选择 IMAGE 捕获输出、冻结当前 Text/Image 端口连线和参数、使用全局默认实例提交。同步防重锁覆盖异步准备阶段；重载后先确认上个任务已结束。存在待恢复幂等请求时仍沿用原请求恢复，不生成第二份 GPU 作业。运行中按钮禁用并显示旋转图标。
- `web/src/lib/canvas/canvas-port-connections.ts`：仅对匹配 `comfyArtifact` 溯源且源端口为 IMAGE 的产物图像开放工作流到普通 Image 节点的类型化来源连线；其他工作流输出仍不得任意连接普通资源节点。恢复旧画布时幂等回填此类边。

## 本机启动（PowerShell）

建议使用 Node 24+（`node:sqlite`），本地开发可在 `web` 目录直接运行：

```powershell
npm run dev:comfy
```

它将启动 `ark-gateway` 和 Vite（开发代理共用自动生成的网关 token，默认后端 Comfy 实例 `comfy-local = http://127.0.0.1:8188`）。只用于本地开发，不替代生产网关身份认证。若需要分开启动，则按下面方式配置：

若 `3000` 端口已被原有 Vite 占用，请先停止旧的前端开发进程；或在 PowerShell 设置 `$env:COMFY_DEV_PORT = "3902"` 再执行 `npm run dev:comfy`（前端在相应端口）。本命令启用 Vite `--strictPort`，不会悄悄换端口。已使用真实本机网关验证 Vite → `/api/comfy/templates` 通过鉴权并返回 HTTP 200 JSON；此检查不提交 GPU 任务。


```powershell
$env:GATEWAY_TOKEN = "<generate-a-long-secret>"
$env:COMFY_INSTANCES_JSON = '[{"id":"comfy-local","url":"http://127.0.0.1:8188"}]'
$env:COMFY_DATA_DIR = "H:\\WebDev\\infinite-atelier\\web\\.comfy-workflow-data"
node server/ark-gateway.mjs
```

另开一个终端并设置相同 `GATEWAY_TOKEN`，然后在 `web` 目录运行 `npm run dev`；`MEDIA_GATEWAY_URL` 未设置时指向 `http://127.0.0.1:8787`。生产环境应由受认证的反向代理承载 `/api/comfy/*`，不能把网关 token 放到浏览器应用配置中。
**全局 ComfyUI 设置（新界面）**：右上角「配置与用户偏好」→「ComfyUI」集中管理本地实例、预设工作流以及默认实例。画布底部的「外观」面板已移除 ComfyUI 配置；所有工作流节点读取同一个全局默认实例，节点参数面板不再提供实例/输出选择。默认图片输出自动采用当前模板第一个 SaveImage 捕获的 IMAGE 端口。

- 实例列表经受 token 保护的网关管理，`POST /api/comfy/instances` 新增、`PUT /api/comfy/instances/:id` 修改、`DELETE /api/comfy/instances/:id` 删除；SQLite 持久保存并在网关重启后恢复。只能添加 `http://127.0.0.1:<port>` 或 `http://[::1]:<port>` 的精确 HTTP 本机地址，拒绝凭据、路径、query、非本机以及 HTTPS。存在 queued/preparing/submitting/submission_unknown/running/collecting 任务时拒绝变更实例，避免重定向未完成的 GPU 请求。
- 全局预设列表和节点「Template bindings」下拉使用同一个预设目录，**始终包含内置的 Krea 2 Turbo INT8 文生图**（即使当前 IndexedDB 从未保存该模板），再合并用户显式管理的预设。内置项首次进入「编辑绑定」时才写入其默认不可变模板。用户保存内置预设修改时，在内置行显示「已修改」和单击可用的「重置默认」按钮；重置重新安装并指向打包的原始 workflow + 默认端口绑定，旧 revision 保留供已绑定画布使用。内置项不可删除，自定义项可删除；同一 templateId 的内置与用户修改版本只显示一条。新增/编辑预设复用 ComfyWorkflowPanel，可以导入 ComfyUI API JSON、修改暴露的输入参数与 socket、选择 IMAGE 输出以及 SaveImage 捕获；保存新版本时，更新对应预设 revision 指针而不累积历史项。旧项目固定使用先前的 revision，仍可用 ID@revision 加载；历史模板数据保留，不做不可恢复删除。
  - 绑定面板顶部统一使用一个「加载预设」下拉菜单，按「内置预设」（Krea 2 Turbo INT8 文生图）和「全局预设」分组；同一个 Krea 工作流已加入全局预设时不再重复出现内置项。取消原有单独的「Krea 2 Turbo 预设」按钮及第二个全局预设选择入口。选择条目直接加载对应模板及画布端口绑定；保留「Import API JSON」「Load /object_info」独立功能。
  - 全局设置中的「编辑绑定」使用嵌入式 ComfyWorkflowPanel 布局，由 Ant Design Modal 统一管理标题和关闭按钮，子编辑器不再重复显示画布浮窗标题、边框与阴影；通过 Ant Design theme token 与设置页保持一致的亮/暗配色。窗口宽度自适应、编辑区左右分栏独立滚动，避免整体横向滚动；画布节点内部打开的独立绑定编辑器维持原来的视觉布局。
  - 已把 `workflows/video_minimax_h3_i2v_turbo.json` 注册为第二个内置预设「MiniMax H3 I2V Turbo · 图生视频」（`video-minimax-h3-i2v-turbo`）。保留完整 27 节点 ComfyUI API 图和模型路径；暴露首帧 IMAGE（`114.image` 文件名槽）、文本提示（`105_104.prompt`）、视频时长（`128.value`）、画幅、MP 大小、随机种子、Lightning LoRA、常规/Lightning 步数、LoRA 强度和 FPS，并将 `105_91` CreateVideo[0] 绑定为 VIDEO 输出，捕获适配器为 `SaveVideo`。它与 Krea 使用同一套列表、编辑保存与「重置默认」入口。
  - **视频执行尚未接入**：当前网关仅支持一条 IMAGE 输出的 SaveImage 捕获与 Image 节点回填；VIDEO 捕获与视频产物持久化还未实现。视频预设当前只允许导入、展示、编辑及保存绑定；节点面板会提示未支持，并禁用 VIDEO-only 工作流的「开始生成」与顶部执行按钮，避免误提交 GPU。后续需要专门增加 VIDEO 产物编译、SaveVideo /history 回收和画布 Video 节点连接。
- 默认实例及“启动时检测实例”的偏好写入全局 AiConfig，跟随 JSON 配置导入/导出；跨设备备份不自动信任另一台机器的网关地址、认证 token 或旧画布实例 ID。预设别名存于本机 IndexedDB；模板版本的项目备份策略独立于全局偏好。


如果看到 Comfy backend returned invalid response 或提示网关不可用，请先检查 `127.0.0.1:8787` 的 ark-gateway 和 Vite 的同一个 `GATEWAY_TOKEN`。只有 ComfyUI 的 `8188` 服务在线还不够，浏览器会通过项目网关提交任务。

**旧进程版本问题（`comfy_route_not_found`）**：如果前端已经更新，但仍在运行加入实例管理接口之前启动的 `ark-gateway` 进程，`PUT /api/comfy/instances/:id` 会收到旧服务 HTTP 404 `comfy_route_not_found`。请在原来启动 `npm run dev:comfy` 的终端按 Ctrl+C，待进程停止，再在 `web` 目录运行 `npm run dev:comfy`。**单纯刷新浏览器或热更新 Vite 并不会重载 Node 后端模块**。新网关 `GET /api/comfy/instances` 返回 `apiVersion:2`、`instanceManagement:true`、以及每个实例的 `url`；浏览器会先检查能力，若连接到旧进程将提示明确的重启操作，不再让用户编辑后得到原始 `comfy_route_not_found`。重启前如果有实际 GPU 任务，应等待其结束或先确认其安全恢复状态，避免中途终止后出现 `submission_unknown`。



**不限制 ComfyUI 节点 class 白名单**：所有由目标 ComfyUI `/object_info` 公布的节点类别均可用于模板和运行，包括本机安装的自定义节点（例如 `ComfySwitchNode`、`TextGenerate`）。仍校验 class 是否实际安装、必填输入、合法输入名（包含 `COMFY_DYNAMICCOMBO_V3` 的选项依赖子输入）、连接引用、输出槽及环路；不接受随意伪造的节点类型或输入。`COMFY_ALLOWED_CLASSES` 已不再使用。注意：ComfyUI 自定义节点可以执行本机代码，请只连接可信的本机 ComfyUI 环境，并保护网关令牌和访问边界。

## API 契约

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/comfy/instances` | 实例 ID / loopback URL / 可达性 / 已安装 class 清单 |
| POST / PUT / DELETE | `/api/comfy/instances[/:id]` | 添加、修改、删除受限本机实例；有未完成 GPU 任务时 HTTP 409 |
| POST | `/api/comfy/templates` | `{instanceId, template}`，按 SHA 保存固定不可变 revision |
| GET | `/api/comfy/templates` | 服务端已有版本 |
| POST | `/api/comfy/inputs` | raw image bytes + 精确 `Content-Type: image/png/jpeg/webp`；返回持久 `assetId,sha256` |
| POST | `/api/comfy/graphs/validate` | 端口 / graph / capabilities 预编译校验，不消耗 GPU |
| POST | `/api/comfy/runs` | 单节点冻结 RunRequestV1；相同作用域/key/payload 返回原 run，语义不同 409 |
| GET | `/api/comfy/runs/:id` | 状态、promptId、captureMap、多图片产物列表 |
| POST | `/api/comfy/runs/:id/cancel` | queued/preparing 可取消；已提交仅记录取消请求，不使用全局 `/interrupt` |
| GET | `/api/comfy/runs/:id/artifacts/:artifactId` | 已持久化、经 SHA 验证的图片，按 runId 归属 |

## 可靠性边界

- staging 图片在 `POST /runs` 前完成持久化；queued/preparing 重启可恢复并安全重上传输入。任务记录包含冻结的源文本、媒体摘要与 template revision，执行不回读最新画布值。
- `submitting` 状态先于网络 `POST /prompt` 持久化。丢失 `prompt_id` 或在该窗口重启，转 `submission_unknown`，**不重新提交**；当前实现保守阻塞该实例的后续新 GPU 任务，等待管理员核对。没有自动关联 `submitMarker` 的能力，也没有暴露“强制重发”的危险按钮。
- `running/collecting` 持久化 `promptId`，重启继续查询 history 与回收结果；采集行按 `(runId,captureNodeId,fileKey)` 去重。上传 staging 和输出 artifact 目前保留至手动清理，尚未加入资源总量配额/自动清理策略；部署应对目录使用磁盘监控与访问权限。
- SQLite 使用单进程 worker；**不可同时启动多个指向同一数据目录的后端进程**。未来多 worker 需要数据库租约和 fencing，不能直接横向扩展本版本。
- 首版的 principal 是网关 token 所属的单租户主体，不是多账号隔离；使用公开域名前必须接入可信用户认证/权限和资产归属校验。

## 验证

```powershell
node --test web/server/comfy-workflow/comfy-workflow.test.mjs
cd web
npm run typecheck
npm run test
npm run build
```
需要复现真实 GPU 端到端验收时（仅在确认 Comfy `/queue` 为空后运行；会产生真实 GPU 请求及 Comfy output 文件），在项目根目录执行：

```powershell
$env:COMFY_LIVE_TEST = "1"
node web/server/comfy-workflow/comfy-workflow.live-smoke.mjs
```

脚本检查实际安装的 class 和模型，创建隔离临时 SQLite、经后端接口提交两个小工作流，并验证三张图片的产物引用、下载与 SHA-256。默认未设置 `COMFY_LIVE_TEST` 时不会提交 GPU 工作。

6 个专项用例覆盖 CF-01、中间 IMAGE 捕获、单节点 Image→LoadImage、输入重复来源拒绝、0/空串优先级、SQLite 同 key 幂等与 409、staging/restart、单次 prompt 提交、两张结果、下载中断恢复、running+promptId 重启恢复、`submission_unknown` 不重发。前端 Vitest 全量 52 文件 / 303 个测试通过；类型检查和构建通过。**真实 ComfyUI 后端 E2E 已通过（2026-10-23）**：项目执行环境实际连接 `127.0.0.1:8188` 上的 ComfyUI 0.42.0，`/system_stats`、`/object_info`、`/queue` 返回 200（`/object_info` 约 5 MB、响应约 4.6 秒，原先 2 秒测试超时为误判）。使用已安装的 `dreamshaperXL_lightningDPMSDE.safetensors`，真实 Text→文生图以 256×256、4 steps、batch=2 成功采集 2 张 PNG；随后通过 `/api/comfy/inputs` 上传第一张图，真实 `LoadImage`→`ImageScaleBy` 放大成功采集 1 张 PNG。两次实际 `/prompt` 均获得 promptId、完成 `/history` 追踪及图片下载/哈希校验。该测试直接驱动服务端 `createComfyService` 和本地 HTTP 服务，**未验证完整浏览器画布 UI 和 Vite/Ark 网关代理链路**。

补充使用隔离临时目录及随机网关 token 启动真实 `ark-gateway.mjs` 路由做 HTTP 鉴权与实例发现验证：未授权请求 HTTP 401、`x-gateway-token` 正确的请求 HTTP 200、`comfy-local` 可达且发现 `SaveImage`。**Vite 浏览器真实画布点击与图片可视化尚未进行自动化 E2E**；多图节点重叠问题已改为确定性分格排布并通过 2 项布局测试。

## 下一步（先闭环验证，再合并）

真实 GPU smoke 已跑通。下一步对浏览器画布进行交互验收，包括工作流绑定、文本/图片连线、点击运行、进度轮询、两个输出 Image 节点不重叠，以及页面重载后的已采集产物恢复。随后补充 unknown 提交关联/人工 reconciliation、上传与 artifact 容量/保留策略、未打开面板时的完成通知；最后才逐步放宽多 workflow socket 和 rootOutputs，**不要改变 RunRequestV1 历史 schema**。
