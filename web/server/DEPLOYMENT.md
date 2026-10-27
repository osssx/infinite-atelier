# Infinite Atelier 本地后端部署

目前不再运行独立 `ark-gateway.mjs`。官方 Ark 视频、ComfyUI 工作流及媒体产物由 Fastify + SQLite 后端统一管理。

## 本地开发

```powershell
cd web
npm run dev
```

只启动两个本地进程：Fastify（默认 `127.0.0.1:8788`）和 Vite（默认 `127.0.0.1:3000`），不再启动 8787 网关。单独运行后端可使用 `npm run dev:backend`。手动启动 Vite 时，需将 `ATELIER_BACKEND_URL` 设置为 `http://127.0.0.1:8788`。

## 渠道及媒体

- 目前官方 Ark API 地址为 `https://ark.cn-beijing.volces.com/api/v3`。渠道密钥在设置页写入 SQLite Credential Vault，不再使用 Gateway Token 或浏览器 `/api/ark/*` 进行付费调用。
- ComfyUI 实例在设置页管理，后端 `/api/v1/comfy/instances` 读取实例，生成经同一 JobCoordinator 调度。
- `POST /api/v1/blobs` 上传媒体至 CAS；Ark 素材上云使用后端 Ark Asset Manager（AK/SK、素材组、TOS Bucket）。
- `GET /api/v1/channels/:id/health` 仅检查已保存官方 Ark 渠道的凭据，不会产生收费任务。
- `POST /api/v1/media/download` 仅接受受信任的 Ark/TOS HTTPS 媒体主机，实施 DNS/IP 检查、禁止重定向、大小限制、MIME 校验与 CAS 存储。

## 安全及限制

Fastify 的本地 Session、同源 CSRF 和本机网络策略保护这些 API。付费生成只经过画布来源冻结、持久化幂等键及 JobCoordinator。旧 `/api/ark/*`、`/api/comfy/*`、`/api/media/uploads` 开发路由返回 HTTP 410；**不提供旧 Gateway 任务数据兼容或迁移**。旧 `jobs-v2.sqlite` 不加载，也不主动删除；新 SQLite JobCoordinator 任务和 CAS 产物保持不变。

自定义 Ark/本地 Ark 中转地址目前没有统一的服务端 Provider Adapter，不能经旧浏览器 Gateway 客户端提交，应改用受支持的官方方舟渠道，或后续实现新的安全 Adapter。普通 OpenAI 兼容客户端及插件模型使用其原执行链路。

**生产环境**：现有 `npm run start` 仍为 Vite Preview，并非 Fastify 同进程托管前端的正式生产部署。公网部署仍需完成静态文件托管、鉴权入口与网络隔离审计；开发环境已无需 Gateway。
