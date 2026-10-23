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
- `web/src/features/comfy-workflow/comfy-workflow-instance-panel.tsx`：允许实例选择/验证、IMAGE root 选择、运行、状态轮询、主动刷新与取消意图。
- `web/src/pages/canvas/project.tsx`：从 run artifact 下载 Blob，调用现有 `uploadImage` 保存 IndexedDB 并创建 Image 节点；根据 artifactId 检测重复导入，保留 `runId/workflowNodeId/portId` 溯源。
- `web/src/features/comfy-workflow/artifact-layout.ts`：单 run 多图分格布局，采用实际图片比例生成画布节点尺寸，避免异步批次导入时图片节点相互重叠。

## 本机启动（PowerShell）

建议在 `web` 目录运行 Node 24+（`node:sqlite`）：

```powershell
$env:GATEWAY_TOKEN = "<generate-a-long-secret>"
$env:COMFY_INSTANCES_JSON = '[{"id":"comfy-local","url":"http://127.0.0.1:8188"}]'
$env:COMFY_ALLOWED_CLASSES = "CheckpointLoaderSimple,CLIPTextEncode,EmptyLatentImage,KSampler,VAEDecode,VAEEncode,LoadImage,SaveImage,ImageScale,ImageScaleBy"
$env:COMFY_DATA_DIR = "H:\\WebDev\\infinite-atelier\\web\\.comfy-workflow-data"
node server/ark-gateway.mjs
```

另开一个终端并设置相同 `GATEWAY_TOKEN`，然后在 `web` 目录运行 `npm run dev`；`MEDIA_GATEWAY_URL` 未设置时指向 `http://127.0.0.1:8787`。生产环境应由受认证的反向代理承载 `/api/comfy/*`，不能把网关 token 放到浏览器应用配置中。

白名单实例目前 **仅接受配置明确的 127.0.0.1 或 ::1 HTTP 原点**；端口必填。使用非内置 class 的工作流，需由受信任管理员显式扩展 `COMFY_ALLOWED_CLASSES`。默认白名单在 `service.mjs` 中配置，优先考虑显式环境配置而不是任意自定义节点。

## API 契约

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/comfy/instances` | 实例 ID / 可达性 / allowlisted class 清单 |
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
