# Infinite Atelier 画布 SQLite-only 架构设计

状态：**分阶段实施中（已落地 P0 开发链路、P1 核心 CRUD 与基本图自动保存）**。针对单机单用户；浏览器本地旧画布不迁移、不兼容。**P2 细粒度视口/聊天保存、P3 统一媒体 BlobStore、P4 统一生成、P5 清理/备份仍未完成**。

## 当前可运行代码（首轮实施）

- `npm run dev` 调用 `web/scripts/dev-with-backend.mjs`，启动 SQLite 后端与 Vite 开发服务，同源 API 代理不需要手动环境变量。
- `web/scripts/dev-local-backend.mjs` 开启 `autoLocalSession`，`GET /api/v1/session` 为可信 loopback 同源浏览器建立 HttpOnly + CSRF 会话，不再要求在画布输入 Token；继续保留 Host / Origin / CSRF 拦截。
- 项目 API 增加软删；项目页面的创建、列表、查看、改名和删除通过后端 API。
- `use-canvas-store.ts` 仅 re-export 新的 `use-canvas-sqlite-store.ts`；**不打开旧 Canvas IndexedDB**。Store 保留内存图，450ms 防抖，串行 `PATCH expectedRevision`，失败明确提示且草稿不被覆盖。
- 旧画布“手动连接同步”与“共享后端项目库”入口从可见页面隐藏；原项目浏览器 ZIP 导入/导出暂时关闭，以免在媒体未后端化前生成不完整的项目。
- **当前保留的限制**：`image-storage.ts`、`file-storage.ts` 和视频生成等仍存在旧浏览器媒体路径；完整 SQLite-only 不能在 P3/P4 完成前宣告达成。跨两个标签页的异步 Materializer 刷新、聊天独立表、单项轻量 viewport 持久化、生产静态站点统一托管也尚未接线。

在已有 `npm run dev:backend` 运行时，先安全停止旧服务（不要中断正在提交的 GPU 任务），再用 `npm run dev` 启动；不要同时启动两个后端进程争用端口 8788 和数据库进程锁。

## 1. 不可变约束

1. 画布项目、标题、节点、连接、聊天、视口、画布级设置、媒体和生成任务的**权威存储只有本地后端**。SQLite 持久化结构化信息；大图、视频、音频通过后端 BlobStore 内容哈希文件存储，并由 SQLite 维护索引、关联和生命周期。
2. React/Zustand 只持有渲染与交互中的内存状态，历史撤销栈也只存在内存。不得使用 IndexedDB / LocalStorage / SessionStorage 保存项目文档、Canvas 图片或生成提交记录。
3. 打开应用自动连接本机后端；新建/打开项目直接读取 SQLite；更改自动保存。不再有“本地 vs 共享”双项目库、“连接后端”“同步开关”“人工冲突合并”或 Token 输入。
4. 不读取、不迁移任何历史浏览器的 canvas_projects、canvas_meta、image_files、media_files。浏览器旧画布不会出现在新项目库。后端自身的 SQLite schema 升级仍必须安全、不可静默丢已有后端任务。
5. 不实现多人协同、CRDT、角色、在线用户或云同步。同一用户可能误开两个页面及后台 Materializer 修改图，所以仍保留 revision 防覆盖及写队列，不采用危险的任意覆盖。
6. 不能连接后端时**禁止回退旧浏览器持久化**：页面显示“后端不可用/重试”，未提交的内存修改明确标记为未保存。

## 2. 目标架构

```text
  Web Canvas (127.0.0.1 或 localhost)
      React 交互状态（RAM） / Undo & Redo（RAM）
                │
        CanvasApi / MutationQueue
         ┌──────┼──────────────────┐
         │ REST │ SSE              │ Blob streaming/Range
         ▼      ▼                  ▼
        单一本地 Fastify / JobCoordinator / CanvasMaterializer
             ├── ProjectRepository：SQLite WAL
             ├── JobRepository：SQLite jobs / artifacts / events
             └── BlobStore：data/blobs/<sha256> + SQLite blobs 索引
```

开发启动由 **一个** `npm run dev` 启动器先检查/运行 Fastify，再启动仅 loopback 的 Vite 和后端代理；产品运行用一个入口提供静态前端和 API。两种 hostname 的 Cookie 可以独立，但项目数据库相同，用户完全不需要管理“同步”。

启动鉴权自动化≠裸奔：页面同源请求自动建立短期本机会话，后端继续保持 Host allowlist、loopback 绑定、Origin + Fetch Metadata + CSRF、HttpOnly SameSite Cookie、不开放 CORS、拒绝 DNS rebinding。不得以取消校验替代取消手工 Token；模型密钥继续由 DPAPI Vault 管理。

## 3. SQLite schema 规划

采用 schema v7（以当前 v6 为基线）：

| 数据 | 规划 |
|---|---|
| `projects` | `id,title,document_json,revision,created_at,updated_at,deleted_at,node_count,connection_count`。document_json **仅图**：nodes/connections；标题/统计放列以避免项目列表解析所有大图 |
| `project_viewports` | 复用现有表，单独保存 viewport，不因缩放改变图 revision |
| `project_ui_state` | 画布级 backgroundMode/showImageInfo/comfyInstanceId 等，单独 json 行 |
| `canvas_chat_sessions` | 按 project_id/chat_id 独立保存聊天内容、活动会话和时间戳，避免输入一个字重写整个图 |
| `blobs` / `media_assets` | 后端文件 SHA256、MIME、长度、宽高、时长、预览/原始关联；节点只保存 assetId/blobId，不保存 blob:、data: URL 或文件路径 |
| `jobs/job_attempts/artifacts/materializations` | 继续用持久提交屏障、幂等去重、恢复能力；产物落图是同事务改 revision/写事件 |
| `project_events` | 复用当前持久化项目事件；承担自动刷新/重启回放，不为多人协作设计 |

不迁移浏览器老画布，但已有后端 SQLite 文件仍按 schema migration 向前升级。对全图字段和标题字段选择一种唯一规范形式，避免文档与列双写不同步。

## 4. 接口设计

- `GET /api/v1/ready`：SQLite/锁/schema/worker 启动状态，前端开屏检测。
- `GET /api/v1/projects`、`POST /api/v1/projects`：项目列表与创建；创建真正持久化后才能进入编辑器。
- `GET /api/v1/projects/:id`、`PATCH /api/v1/projects/:id`、`DELETE /api/v1/projects/:id`：项目详情、保存和软删除。更新携带 expectedRevision；已保存后回传新 revision。
- `PUT /api/v1/projects/:id/viewport`：独立低频保存。
- `GET/PUT/DELETE /api/v1/projects/:id/chats[/:chatId]`：聊天会话按需读取、保存。
- `POST /api/v1/blobs`、`GET /api/v1/blobs/:id`：图片/视频/音频/文本上传与 Range 下载；媒体 metadata 由后端维护。
- `POST /api/v1/jobs`、`GET /api/v1/jobs/:id`、`GET /api/v1/projects/events`：运行时持久化、异步生成和项目事件。客户端不可绕过 Save Barrier 向 GPU 提交不一致的图。

MVP 复用现有图级 `PATCH`，不立即引入复杂 typed operation log；200 节点下优先验证节流后的一次 JSON 快照大小和网络开销。

## 5. 前端模块替换清单

- `web/src/stores/canvas/use-canvas-store.ts`：移除 Zustand persist、localforage、浏览器 projectRecords；Store 改为内存远端缓存 + `loadProjects/createProject/loadProject/updateProject/renameProject/deleteProject` 的 async action。只有后端确认的结果才成为持久态。
- `web/src/pages/canvas/index.tsx`：唯一 SQLite 项目列表；去掉 `BackendSharedProjects` 和双库卡片；新建/改名/删除/导入/导出统一 API。
- `web/src/pages/canvas/project.tsx`：GET 后 hydrate 内存、Undo/Redo 仍即时；一个 CanvasDocumentController + AutosaveQueue 负责 dirty、序列化、刷写与错误显示。删除 toggleBackendSync、reconcileBackendSync、backendComfyEnabled 双路线。
- 删除画布专用 `canvas-project-records.ts`、`canvas-backend-sync.ts`、`backend-shared-projects.tsx`、`backend-preferences.ts` 和双库存储桥。通用指纹算法、提交操作复用至独立 canvas-api/execution-api。
- `image-storage.ts` / `file-storage.ts` 的 **Canvas 资源**走 BlobStore；旧 storageKey 改成 assetId/blobId，media preview 可只缓存浏览器内存，不再持久依赖 IndexedDB。检查所有导入、裁剪、抽帧、缩略图、视频、音频、结果节点路径。
- `backup-restore.ts` / `canvas-export`：从后端数据库快照和 BlobStore 构建自包含归档，导入须先验证全部 Blob；不要导出浏览器空缓存充当有效备份。
- 不必改变与 Canvas 无关的浏览器偏好设置；模型渠道凭据继续属于后端 Vault。

## 6. 自动保存状态机

```text
bootstrap → loading → ready → dirty → saving → saved
                     └─────────────── save_error → retry
```

- 拖拽/框选/画布缩放每帧只改内存，**手势完成**后 300–600ms debounce 保存图；输入文字停止片刻后保存。独立保存 viewport/chat，避免全图因滚轮/聊天频繁重写。
- 每个项目同一时间**最多一个写请求**；追加修改合并到 latest snapshot，先发旧请求再发最新快照，收到确认的 revision 后才更新 saved 状态。不能由于网络响应乱序倒退 UI。
- Undo/Redo 也是一次普通图编辑，复用保存队列；生成/导出/页面切换前 await flush。关闭/刷新前如果未收到后端确认，显示未保存提示；小请求 keepalive 只能辅助不能视为成功。
- 后端不可用则显示独立的 save_error/连接错误，不把内存内容伪装成 SQLite 已保存。旧的本地画布无任何回退作用。
- 409 时重新获取后端最新 revision，检测是否为后台产物物化/已确认请求；不能安全重放当前修改则保留内存内容并提示刷新，不静默丢失或覆盖。
- 实时事件可以自动刷新项目列表或后台产物；单用户不需要协作光标和 CRDT。
- 保存产物应先安全入 BlobStore，后端 transaction 统一更新节点、边、revision 和事件。

## 7. 逐步实施与验收

**P0 自动后端启动与认证**
- `npm run dev` 一键启动 Fastify + Vite / 自动 Session；UI 无连接或 Token 弹窗；断开后端只显示错误，不回退浏览器画布。
- 验收：localhost 与 127.0.0.1 同一个 SQLite；无暴露到局域网和跨站写入。

**P1 唯一项目 CRUD 和编辑器读取**
- 统一 backend 项目 API、项目列表、创建、删除、重命名、打开；替换 Store persist；取消浏览器本地画布迁移。
- 验收：创建/刷新/重启/换 hostname 后列表和图一致；清空浏览器站点数据不影响 SQLite 项目。

**P2 画布自动保存与图/聊天/视口分流**
- 引入保存队列、重试/错误可见、Undo/Redo 提交与导航 flush；引入 viewport/chat API。
- 验收：连续 200 节点拖动时无逐帧网络保存；手势结束确认一次持久修订；断网、重启和并发请求不显示假成功。

**P3 媒体后端化**
- 所有 Canvas 图片/视频/音频/文本、参考图、裁剪、抽帧、预览与生成输出转后端 BlobStore；重写引用字段和归档导出。
- 验收：换 hostname 后媒体正常加载与 Range 播放；不存在任何 Canvas IDB 媒体依赖。

**P4 统一生成**
- 画布默认使用 JobCoordinator/Comfy Adapter/Materializer，移除原 V2/新后端开关；保持提交屏障、来源指纹和未知提交的防重复 GPU 语义。
- 验收：图保存成功才能运行，Comfy 断网/重启不二次提交；image/video/audio/text 均直接存后端并接回画布。

**P5 清理与备份**
- 移除废弃 Canvas IDB/sync 分支和 UI；备份使用 SQLite 一致性快照 + Blob 文件清单（不可直接在 WAL 激活期间复制 sqlite 主文件）；完善异常和回归测试。
- 验收：所有画布项目读写走后端，页面清除 IndexedDB 后项目仍完整；`npm run typecheck`、后端测试、前端测试、生产构建全通过。

## 8. 实施警戒

- 不要先删前端存储再让空白页面成为可编辑态：P1 必须有加载屏障，后端写失败不能出现“已保存”。
- 不要把大视频塞入 SQLite BLOB；SQLite 权威记录媒体内容标识，文件存后端数据目录。
- 不要因为单用户而删数据库锁、revision、CSRF、幂等请求、任务提交屏障。
- 为了实现最终版本，可以删除旧浏览器 Canvas 结构，但不得顺手清理与用户提供的其他仓库脏文件。
