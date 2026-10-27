# Ark Gateway 整合至 SQLite Backend

状态：**实施中，已完成 P1/P2 部分接口、P3 前端旧 Comfy Runner 清理、P4 媒体下载子链路**，尚未达到「不启动独立 Gateway」的最终目标。遵循不兼容、不迁移旧 `jobs-v2.sqlite` 任务数据；不主动删除历史数据文件。

## 已完成并接入默认 Fastify Backend（8788）

- `trusted-http.mjs`：固定 HTTPS allowlist、DNS 校验、IPv4 公网解析绑定、阻止重定向与响应体上限。
- `ark-channel-health.mjs`：`GET /api/v1/channels/:id/health`；官方 Ark 渠道的 DPAPI Vault 密钥，固定 GET 不存在的任务进行免费连通性检测，禁止通过请求提供任意上游地址或 API Key。
- `trusted-media-download.mjs`：`POST /api/v1/media/download`，JSON `{ "url": "https://..." }`，同源 Session/CSRF、固定 Ark/TOS 主机 allowlist、无重定向、公网 DNS IP pinning、200MiB 总量限制、MIME/文件签名校验、流式导入现有 SQLite CAS；仅接受 HTTPS 地址，不返回上游签名 URL。
- `GET /api/v1/comfy/instances/:id/object-info`：统一从 SQLite ComfyUI 实例注册表读取本地上游能力。
- 设置页 Ark 连接测试已切换 `/api/v1/channels/:id/health`，要求先保存加密密钥；不传浏览器明文密钥或 Gateway Token。
- 现有 `POST /api/v1/blobs` 已是流式媒体上传接口，不再重复提供第二套上传存储。

## P3 已完成：前端移除旧 Comfy Gateway Runner

- 删除未被正式画布调用的 `run-client.ts`、`run-client.test.ts`，清除 `/api/comfy/runs`、`/api/comfy/inputs`、浏览器 `localStorage` 待提交请求及旧 Gateway 实例编辑函数。
- 提取仍需 UI 使用的 `ComfyRunState`、`ComfyRunArtifact`、`ComfyInstance`、`missingComfyMediaInputs` 至无副作用 `run-types.ts`。
- 画布、实例配置、媒体落图类型全部直接引用新模块；无新增 GPU 提交逻辑。单独添加媒体输入预检和 SQLite-only 执行边界测试。
- 此阶段仅删除前端死代码；`web/server/comfy-workflow/service.mjs` 仍被独立网关进程使用，**必须等 P4 旧 Ark 依赖解除再删除**。

## P4 进行中：Ark 视频媒体下载改由统一 Fastify CAS 处理

- `web/src/services/api/video.ts` 不再使用 `/api/ark/download` 及 `VITE_MEDIA_GATEWAY_TOKEN` 转发已有任务的结果 URL。改用已接入的 `POST /api/v1/media/download`；后端固定 Ark/TOS 签名域名白名单、校验真实媒体并写入现有 CAS，再通过 `GET /api/v1/blobs/:id` 读取。
- 校验 CAS blob ID、大小、MIME 后才向视频落盘层返回 Blob；下载失败不会重新调用创建任务的 `/contents/generations/tasks`。
- **未完成**：`video.ts` 仍保留 `POST/GET/DELETE /api/ark/contents/generations/tasks` 和 `/api/media/uploads` 旧路径。正常画布官方 Ark 已使用 SQLite JobCoordinator；后续需要清理其余遗留的浏览器直连/自定义渠道视频提交逻辑，才可以移除 8787 网关进程。

## 尚未完成：禁止提前删除旧进程

1. P4：`web/src/services/api/video.ts` 中旧 `/api/ark/*` 创建/轮询/取消视频任务与 `/api/media/uploads` 上传代码仍依赖旧 Gateway/Vite 路由。全部改为 SQLite JobCoordinator（保持任务冻结、幂等屏障与不可重复提交），媒体使用 `/api/v1/blobs` 和 `/api/v1/media/download`。自定义路由兼容不作为迁移目标。
2. P5：确认旧调用已归零后，从 `dev-with-backend.mjs` 移除第二进程、`GATEWAY_TOKEN`、8787 端口，从 `vite.config.ts` 移除相应代理/插件，删除 `dev-with-comfy` 和旧 gateway 服务代码与依赖。运行统一启动端到端测试。

**不要迁移旧 Gateway 的 runs、artifacts 或 jobs-v2.sqlite**。保持旧文件原位、停止使用，不自动删除。已经由 SQLite JobCoordinator 管理的任务及 CAS 必须保留。

## 测试

- `node --test server/backend/ark-channel-health.test.mjs server/backend/trusted-media-download.test.mjs server/backend/comfy-object-info.test.mjs`；
- `npm run test:backend`；`npm run typecheck`；`npm run build`。

安全约束：网络探测只能执行 GET，不能通过健康检查创建生成任务；付费 POST 仅允许 JobCoordinator 管理，不能做新通用 Ark 转发 API。未认证、跨源、无 CSRF 的变更操作被 Fastify 拒绝。
