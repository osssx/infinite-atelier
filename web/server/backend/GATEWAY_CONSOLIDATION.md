# Ark Gateway 整合至 Fastify + SQLite Backend

状态：**P1–P5 开发环境主链路已完成**。不迁移或兼容旧 Gateway 的 `jobs-v2.sqlite`，不主动删除该数据；既有 SQLite JobCoordinator 任务和 CAS 产物保留。

## 已完成

- P1/P2：官方 Ark 连通性探测、信任主机 HTTPS 下载、DNS/IP 固定、响应限制、CAS 导入、统一 Fastify /api/v1 + Credential Vault + Session/CSRF，ComfyUI 实例 `object-info` 查询。
- P3：前端删除旧 Comfy `run-client.ts`、浏览器待提交快照，UI 需要的类型和输入校验移至纯模块 `run-types.ts`。生成不绕过 SQLite JobCoordinator。
- P4：画布官方方舟渠道继续通过 `startSqliteModelGeneration` 与 JobCoordinator 执行；旧 `video.ts` 不再直接向 `/api/ark` 创建、查询、取消任务或向 `/api/media/uploads` 上传。旧 Gateway task ID 明确拒绝轮询/重放，不重新生成。普通 OpenAI 视频及插件脚本仍使用原执行方式。
- P5：`npm run dev` 启动 Fastify（8788）与 Vite（3000），不再启动第三个 ark-gateway（8787）。移除 `dev:comfy`、`ark-gateway.mjs`、Gateway Token/8787 Vite 代理。旧开发路由以 JSON HTTP 410 明确拒绝。

## 验证

- `node --test scripts/dev-with-backend.integration.test.mjs`：实测 Fastify + Vite 的会话、ComfyUI 实例写入、旧路由 410，在保留旧网关 env 配置时仍不启动第三进程。
- `node node_modules/vitest/vitest.mjs run src/`：前端全量回归。
- `npm run test:backend`：Node 后端回归。
- `npm run typecheck` 与 `npm run build`。

## 尚未支持

- **自定义 Ark/本地 Ark 中转地址**暂未接入 SQLite Provider Adapter；直接由浏览器发起的旧 Ark 任务/旧 task ID 已禁用，不将此能力错误标记为已迁移成功。后续需新的安全服务端 Adapter 和冻结请求协议。
- 旧 Gateway 专用 `server/comfy-workflow/service.mjs` 等非活动模块仍可能留在仓库，开发启动与正常工作流均不引用它们；后续清理需区分和后端共享的编译器/测试工具。
- 正式生产环境单进程 Fastify 托管前端尚未实现，现阶段只保证开发环境无需 Gateway。
- 不为重构验证调用真实付费 Ark/Comfy 生成。付费请求安全使用 mock 和真实进程启动回归验证。
