# Infinite Atelier 画布 SQLite-only 架构设计

状态：**P0–P3 已落地；P4.2 Comfy JobCoordinator + SSE；P4.3 视频/音频 media-file CAS；P4.4 OpenAI 图/音频/文本、Ark Seedance 异步视频及第三轮首帧/首尾帧、图音多模态 CAS 冻结和重启取消入口已接通**。单机单用户，不迁移旧浏览器画布，官方模型适配器默认启用。**本地 MP4/MOV → TOS → Ark CreateAsset/GetAsset 的代码链路及 SQLite 素材 ID 缓存已落地；P4.5 工作流模板与预设存储已迁入主 SQLite v9，并为单项目归档补齐模板依赖（需要用户自备 TOS Bucket、素材组和 AK/SK）；第三方代理/其他模型、真实计费生成验收以及 P5 完整备份/设置收口仍待完成**。

## 当前可运行代码（首轮实施）
**P4.4 默认执行策略（2026-10-26 最新）**：`npm run dev` 启动本地后端时默认加载 OpenAI 和火山方舟视频模型适配器，**无需 `ATELIER_OPENAI_MODELS=1`、`ATELIER_ARK_VIDEO_MODELS=1` 或渠道单独的“启用 SQLite”开关**。普通 Canvas 根据模型的渠道协议、官方固定 HTTPS Base URL 和生成类型自动走 JobCoordinator：OpenAI 图/音频/文本、火山方舟 Seedance 纯文本视频。渠道正常点「保存」时自动把填写的 Key 注册/轮换到 DPAPI Vault，并从浏览器当前渠道配置移除；旧配置第一次在 Canvas 使用时也自动注册并清理本地配置，若后端不可用则**明确报错、不回退浏览器请求**。暂未实现 SQLite 后端适配器的其他渠道、参考媒体、第三方代理 URL 仍走已有 API 路径；不代表它们已经后端化。`createLocalBackend` 测试/嵌入式 API 保持显式 adapter 组装，默认启用仅指实际本地开发启动脚本。不迁移旧浏览器画布，历史浏览器备份不会在此轮强制删除。


- `npm run dev` 调用 `web/scripts/dev-with-backend.mjs`，依次启动 SQLite 后端、ComfyUI/Ark 本地网关与 Vite 开发服务，自动生成并在两端共享仅用于服务端代理的 `GATEWAY_TOKEN`，无需单独运行 `npm run dev:comfy`。默认端口分别为 8788、8787、3000，可通过 `ATELIER_BACKEND_PORT`、`ATELIER_GATEWAY_PORT` 和 `ATELIER_VITE_PORT` 调整。ComfyUI 未启动时，网关仍可编辑实例，并标记其为离线；这不等于 SQLite GPU 调度已启用。
- `web/scripts/dev-local-backend.mjs` 开启 `autoLocalSession`，`GET /api/v1/session` 为可信 loopback 同源浏览器建立 HttpOnly + CSRF 会话，不再要求在画布输入 Token；继续保留 Host / Origin / CSRF 拦截。
- 项目 API 增加软删；项目页面的创建、列表、查看、改名和删除通过后端 API。
- `use-canvas-store.ts` 仅 re-export 新的 `use-canvas-sqlite-store.ts`；**不打开旧 Canvas IndexedDB**。Store 保留内存图，450ms 防抖，串行 `PATCH expectedRevision`，失败明确提示且草稿不被覆盖。
- 旧画布“手动连接同步”与“共享后端项目库”入口从可见页面隐藏；原浏览器 IndexedDB ZIP 格式不再导入。项目库已改用 SQLite 后端的 `.atelier.zip` 自包含项目归档。
- **P2 已实施**：SQLite schema v7 使用 `project_viewports` 和 `project_chats` 独立存储，v6→v7 升级只从现存 **后端**项目 JSON 抽取必要状态，旧浏览器项目不迁移；新建项目时三类数据在同一事务初始化。后端 `GET/PUT /api/v1/projects/:id/viewport`、`GET/PUT /api/v1/projects/:id/chats` 各有独立 revision，图 `PATCH` 不携带这两类数据；Chat、Viewport、Graph 分开防抖与串行保存。首次读取项目并行 GET 三组状态，只有全部成功才初始化 React。
- **P2 竞态修复**：第一笔 viewport/chat `PUT` 执行时若继续编辑，服务器回包只更新 revision，不把旧 payload 写回本地当前值；后续 pending 内容在新 revision 上提交。409 冲突与失败保留草稿并阻止误认为已保存。
- **P3 第一轮已实施**：`canvas-media.ts` 经由同源 `POST /api/v1/blobs` 将画布图片、视频、音频和生成结果上传后端 CAS，返回稳定 `cas:<sha256>` 键与 `/api/v1/blobs/<sha256>` URL；`canvas-cas.ts` 统一解析并读取后端文件（支持原后端 Range）。前端通用媒体读取函数能解析 CAS，Canvas 页面导入/生成、Comfy V2 导入产物和图像水合改走后端上传；素材库仍保留自身的旧存储，**将素材插入画布时显式复制到 CAS**，不直接把其 IndexedDB 键保存进 SQLite 图。CAS 图片缩略图仅在浏览器内存中空闲生成，不持久写浏览器 IndexedDB。
- **P3 已验证**：图片、视频、音频经真实 Fastify 上传，重复内容得到 200 去重，MP4 Range 返回 206；SQLite 后端关闭再启动，画布 CAS 引用和图片字节均能重新获取。错误 MIME、无效返回值和 Comfy 混合产物导入有前端回归。
- **P3 第二轮（服务端预览）**：`media-preview.mjs` 使用本地系统 FFmpeg（需要在 PATH 中可执行）对已验证的 CAS 图片/视频生成 **256px PNG**，保存在 `data/previews/<sha256>.png`；`GET /api/v1/blobs/:id/preview` 只对已登记 Blob 生效且沿用会话鉴权。单个哈希并发请求只转码一次，最多两个 FFmpeg 进程同时运行，最多排队 256 个请求；FFmpeg 缺失、媒体损坏或转换超时返回明确错误，原始媒体接口不受影响。低缩放节点和视频封面优先读取此接口，CAS 缩略图不写 IndexedDB。已有真实 FFmpeg 生成 MP4 → PNG 的验证。
- **P3 第二轮（保守 GC）**：`blob-gc.mjs` 扫描所有活动项目 JSON、聊天、所有冻结任务快照、Comfy 编译输入、历史 artifacts、事件中的哈希；宁可保留假阳性也不删除可疑引用。`POST /api/v1/storage/gc` 默认只 dry-run；实际删除必须提交 `{"dryRun":false,"confirmation":"DELETE_UNREFERENCED"}`，且仅检查创建/修改已超过 **7 天** 的文件，每轮最多 50 项。每项删除前重查引用、SQLite 外键、文件状态；上传进行中拒绝回收。**不会定时自动执行**，删除前请备份后端数据目录。
- **P3 第三轮（自包含单项目归档）**：`project-archive.mjs` 新增 `GET /api/v1/projects/:id/archive`（流式导出）与 `POST /api/v1/projects/import-archive`（原始 application/zip 上传）。ZIP 由 `manifest.json`（graph、title、viewport、chat sessions、引用媒体的 SHA-256/MIME/长度清单）和 `blobs/<sha256>` 组成，按内容哈希去重。导入时严格限制路径与文件数量，只接受此版的 ZIP32 **无压缩文件条目**，要求有效中央目录结尾并逐项校验 SHA-256、尺寸、MIME；校验全部完成后入 CAS，最后单事务创建**新项目 ID**。任何校验失败均不会创建项目；前置 CAS 写失败可能留下孤立但可回收的 CAS。**V1 已升级单归档上限为 2 GiB（包括所有媒体和元数据），最多 127 个 CAS 文件**，超限返回 413，不会产出不完整备份。项目列表恢复了“导入项目归档”，项目卡恢复了“导出包含媒体的项目归档”按钮；导出/导入前须确认内存中的自动保存队列已提交成功。此归档**不包含**历史生成任务、凭据 Vault、其他项目、用户个性化设置或完整 SQLite WAL 备份。
- **P3 自检**：真实 Fastify 通过 HTTP 导出→软删原项目→导入新项目→关闭重启 SQLite→重新读取节点、视口、聊天和原始图片/音频 bytes；另测试路径穿越、文件丢失、媒体 SHA 变化、ZIP 尾部截断、旧 origin-local media key、未鉴权请求的失败保护。
- **P3 第四轮（大媒体流式归档）**：ZIP32 STORE 最大归档 2 GiB，至多 127 个 CAS 对象。导出保留逐文件 SHA-256 与响应背压；`project-archive-import.mjs` 只把最多 5 MiB 的 manifest 放入 RAM，媒体分块写入私有临时目录并同步计算 SHA-256，校验 ZIP32 结束目录、路径白名单、压缩方式、数量、大小及 manifest 完整性；**所有文件确认完整后才逐个导入 CAS，最后单事务创建 SQLite 项目**。异常时关闭文件流、删除临时目录。前端在支持 File System Access API 的 Chrome/Edge 上直接写入用户选中的 ZIP 文件，不再读取整包 Blob；其他浏览器只允许不超过 128 MiB 的内存下载，超出显式报错。文件选择器需在用户点击的事件上下文中打开。本轮使用 **130 MiB 视频** 完成真实磁盘 ZIP 导出、导入、图与视口恢复。归档限制并非 BlobStore 生成捕获限制，两者仍独立验证。ZIP64（单归档超过 4 GiB）及流式跨项目全库备份不在此范围。
- **P4 第一轮（直接 SQLite Comfy 执行）**：`sqlite-comfy-bridge.ts` 已将普通 Canvas 工作流的 `startBackendComfyWorkflowRun` 直接接入 `use-canvas-sqlite-store`（无需 `createCanvasBackendSync`、手动连接或单独本地项目缓存）。执行前验证实时图与冻结图完全一致，显式写入 Store、等待三通道保存，读取后端项目再次验证图、revision 与源节点 SHA-256 指纹。参考图片上传后端 CAS，任务 `POST /api/v1/jobs` 使用冻结输入及幂等键。后端 `/jobs/snapshot` 增加 `targetNodeId`；SQLite-only 新路径提交前检查同一项目、工作流是否存在非终态任务，HTTP 响应丢失后从服务器查询恢复，**不再将新的生成请求或待确认 payload 保存在 localStorage**。页面载入后自动扫描 SQLite 后端活跃任务及最近最多 40 个缺失产物的成功任务，`sqlite-comfy-job-watch.ts` 检查任务/Materialization 并仅在安全的追加式合并条件满足时自动接入图；Store 同步升级 revision、杜绝重复 PATCH。本轮测试涵盖源图冻结期间发生修改、服务端图不匹配、二次提交拦截、CAS 上传以及 typed 产物合并。旧 V2 已启动的任务仍须终结后才能切到新路径，避免同节点重复 GPU 调度。
- **开发入口与 SQLite ComfyUI 实例配置（v15）**：在 `web` 目录运行 `npm run dev`，自动启动 SQLite 后端和 Vite（不再启动独立 ark-gateway），无需先设置 `ATELIER_COMFY_INSTANCE_ID`/`ATELIER_COMFY_URL`（若指定则仅作为 SQLite 首次初始化的实例种子）；默认注册 `comfy-local` → `http://127.0.0.1:8188`。设置页 ComfyUI 实例现在通过同源 CSRF `/api/v1/comfy/instances` 直接增删改 SQLite `comfy_instances`，在 JobCoordinator 运行中动态注册/撤销可执行适配器，并刷新 `/api/v1/execution/capabilities`；不同于旧 `ark-gateway /api/comfy/instances`，不再需要实例在旧网关和 SQLite 双重配置。非终态（包括提交状态未知）任务所在实例禁止编辑/删除，以免改变冻结 GPU 目标；已删除全部实例在重启后也不会自动恢复默认。实例离线时在设置显示未连接，需启动本机 ComfyUI。新增或修改实例无需重启 SQLite 后端；应用升级需重启一次 `npm run dev`。Canvas 不会回退旧 V2 执行路径。已验证本地 Fastify/SQLite + 模拟 Comfy 的任务提交、素材恢复和重启，**尚未在真实 GPU 上完成生产工作流验收**。
- **P4.2（本轮，H 盘 custom）**：普通 Canvas 的 `executeComfyWorkflow` 已删除旧 V2 POST、V2 状态轮询、浏览器 pending 恢复和废弃的手动同步桥回调。新工作流只经 `createSqliteComfyBridge` → 保存/指纹屏障 → `startBackendComfyWorkflowRun(serverAuthoritative)` → SQLite `/jobs`，后端配置缺失时**明确禁用/报错，不会回退旧 /api/comfy/runs**。节点参数面板改从 SQLite `/jobs/snapshot` 恢复当前任务，避免浏览器 localStorage 保存运行状态；`sqlite-job-events.ts` 为同一标签页的所有活跃任务复用一条带 event cursor 的 `/api/v1/events` SSE 流，按 jobId 唤醒 watcher；SSE 连接失败由 15s 低频轮询兜底。页面重新进入时仍扫描非终态任务和最近产物，Materializer 只在安全的追加式合并情况下更新节点和连线，已完整恢复的图不再提示冲突。保存屏障只等待目标 SQLite 项目，避免无关项目的旧保存异常阻断 GPU 提交。现有 `run-client.ts` 的 V2 API 仍被其他非 Canvas 入口使用，**此轮仅完成 Canvas Comfy 工作流单路径，并未删除全产品的网关 API**。真机 ComfyUI GPU 尚未联调验证。
- **P4.3（本轮）**：前端 `prepareCanvasExternalInputSnapshot` 原本已有 IMAGE/VIDEO/AUDIO 区分，`backend-comfy-run.ts` 与 `sqlite-comfy-bridge.ts` 现在允许将 Video、Audio 画布节点作为类型确定的媒体输入，通过后端 BlobStore CAS 固定二进制和 SHA-256 后提交 JobCoordinator；原本就是 `cas:<sha256>` 的画布媒体直接以同源 `HEAD /api/v1/blobs/:id` 验证 MIME/长度和引用，不把大视频从后端下载到浏览器再上传一次；外部新文件则仍先写入 CAS；仅允许视频 MP4/WebM/MKV、音频 WAV/FLAC/OGG/MP3 及现有图片 PNG/JPEG/WebP，跨类型 MIME 被拒绝。`compiler.mjs` 的外部输入验证接受 video/audio 资源端口与匹配的 `valueKind`；**VIDEO/AUDIO 必须使用工作流模板显式定义的 `inputBinding.mode="media-file"` 且 `mediaKind` 对应类型**，将有 SHA-256 的 CAS 文件名写入相应 ComfyUI 节点的文件名字段。没有图连线或使用旧模板内的本机文件名时仍失败；视频/音频 Socket 自动构造 Load 节点暂不支持。仅已验证 CAS 文件赋值的精确 input 字段可以避开上传前 `/object_info` 的旧文件名枚举，其余枚举与输入仍严格校验。`comfy-v2-adapter.mjs` 通过 MIME→扩展名、内容哈希、最大容量校验与磁盘支持的 `openAsBlob` multipart 将媒体上传到 loopback ComfyUI 的 `/upload/image` input 路径，不再对视频执行 `readFile` 内存全量加载；SQLite `comfy_job_preparations.image_files_json` 列继续保存 `assetId→uploaded filename` 映射（列名沿用旧 schema，不需要迁移）。测试覆盖真实 SQLite、图编译、音视频文件上传、缺失与不匹配媒体、原图片 Socket 不回归。此阶段测试采用模拟 ComfyUI 上游，**真实自定义视频/音频加载节点与 GPU 生产工作流尚待本机验证**。
- **P4.4 第一轮（本轮，H 盘）**：新增 `openai-model-adapter.mjs`，最初以独立可选环境变量注册，现已改为本地开发脚本默认在 `runtime.mjs` 注册 `model` JobCoordinator lane（与 Comfy lane 共存）。只支持固定官方 `https://api.openai.com/v1` HTTPS 目标，无任意 Base URL / HTTP 代理；通过现有后端 `channels` / `credential_versions` **DPAPI Vault** 读取冻结 `channelId + secretVersionRef`，jobs 中不存 API Key。V1 具体支持：**单张纯文本 OpenAI 生图**（`/images/generations`，n=1）、**TTS 语音**（`/audio/speech`，MP3/WAV/FLAC）、**普通文本回复**（`/chat/completions`）；输出均先写入 BlobStore CAS 和 SQLite artifacts 再确认任务成功，采用原有幂等屏障，提交结果不明时不自动重发收费生成。`canvas-materializer.mjs` 为普通 Text/Config 源节点追加对应 image/audio/text 节点和无端口连接，校验冻结源指纹/产物 MIME/provenance，用户编辑源图时将 Materialization 标记 blocked 而保留历史产物；`safeRemoteCanvasMerge` 对 modelArtifact 仅允许严格校验过的追加。前端新增 `sqlite-model-generation.ts`，在普通 Canvas 生成按钮发现官方 OpenAI 渠道 命中受支持官方生成类型时自动走本地 SQLite 保存/指纹屏障→`/jobs`→共享 SSE/Materializer，后端不具备能力则明确失败（不回退浏览器调用）。在渠道正常保存时自动将当前密钥提交到 DPAPI Vault，清空此渠道当前浏览器配置中的 API Key；已有历史备份和其他渠道仍按 P5 单独清理。**暂不受后端支持的渠道继续保留原有 API 行为**；自定义脚本、Skill、图片参考编辑、多图数量大于 1、普通视频 API、其他 OpenAI-compatible 中转 BaseURL 明确不在本轮支持范围，不能称为整个产品 API 已统一。测试包含 SQLite 冻结与源图冲突、DPAPI 引用、密钥吊销、幂等/提交不明、真实 Fastify HTTP→Worker→BlobStore→普通画布自动落图；模型实际 HTTP 上游用可控模拟替代，尚未使用真实付费 OpenAI API 验收。
- **P4.4 第二轮（本轮，H 盘）**：官方 OpenAI Sora 2 Videos API 已于 2026-09-24 停用，故选择截至 2026-10 仍可用的火山方舟 Seedance 异步视频 API，不接入已停用接口。最初以环境变量独立注册、现已默认注册 `ark-video-adapter.mjs`；与先前 OpenAI `model` 适配器在同一 SQLite JobCoordinator lane 通过冻结 `provider` 分流。仅接受固定 `https://ark.cn-beijing.volces.com/api/v3` + DPAPI Vault 渠道，当前 V1 仅支持 Seedance 纯文本视频任务：`POST /contents/generations/tasks` 创建后把远端 ID 原子写入 SQLite `jobs.upstream_task_id`，运行态 `GET` 查询排队/执行/完成/失败/取消/过期状态，10s 最小轮询间隔；重启只恢复远端查询，**绝不再次 POST 计费生成**。成功时 `collect` 再查询远端已完成记录并只从 `https://*.tos-cn-beijing.volces.com` 的非重定向签名地址下载 MP4 至本机流式 BlobStore CAS，再以 SQLite artifacts + Materializer 追加 VIDEO 节点和无端口连接；下载中断只重试收集，来源图指纹不符则阻断落图并保留生成结果。取消接口 `POST /api/v1/jobs/:id/cancel {}` 支持原本未开始的本地排队任务原子取消，或对已提交且远端确认为 queued 的 Ark 任务发 DELETE 并在确认后落库；**远端 running 不支持取消，不会伪报成功**。Canvas 普通视频按钮通过匹配官方地址的 Ark 渠道自动走保存屏障/提交/任务监听，停止按钮调用服务端取消；在正常保存渠道时自动注册 DPAPI 密钥并清空该渠道当前浏览器配置的 Key；普通 Comfy 工作流和暂未支持的外部 API 渠道不受影响。测试以模拟 Ark HTTP 和真实 Fastify/SQLite/BlobStore 进行：重启不重投、下载 retry、SSRF URL 拦截、排队取消、执行中不能取消、来源修改 blocked、视频追加与类型合并。**尚未使用真实付费火山方舟任务/GPU 验证**。\n- **P4.4 第三轮（2026-10-26，H 盘）**：普通 Canvas 视频生成复用 `makeVideoGenerationRequest` 和原始模式/角色配置（`text_to_video` / `first_frame` / `first_last_frame` / `omni_reference`），使用 `seedance-frozen-references.ts` 将图片、音频及方舟视频素材引用冻结为 SQLite JobSnapshot 中可审计的精简字段。已有 `cas:<sha256>` 的图片/音频先通过同源 HEAD 验证存在、MIME 与大小，直接复用 SHA；其他可读取的图片/音频通过受鉴权 `POST /api/v1/blobs` 固定到 CAS，再只保存哈希、媒体类型、角色、可用的尺寸与时长元数据。后端 `ark-video-adapter.mjs` 严格验证互斥的首帧/首尾帧/参考素材模式、图片 ≤9、视频/音频各 ≤3、参考音视频总时长 ≤15s、SHA、MIME、文件限额；在**远端计费 POST 前**从 CAS 校验内容哈希并生成图片/音频 Base64 data URI（整份任务不超过 60 MiB），远端接收的不是不可访问的私有 `localhost` 链接；快照不含 Base64、大文件字节或明文 API Key，断线重启仅恢复已提交 Task ID 的轮询及收集。**本轮之前（历史限制，现由 P4.4 第四轮替代）：**Ark 官方视频输入不接受 Base64，本地 `/api/v1/blobs` 也无法被远端读取；因此只支持已在 Ark 素材库取得的合法 `asset://<ID>` 视频引用，严格拒绝尚未上传的本地视频和未经验证的公网 URL。当前已补充官方 CreateAsset/GetAsset + TOS 上传链路，但未配备专用上传凭据的用户依然无法提交普通本地视频。后端 `GET /api/v1/jobs/snapshot` 与 `/:id` 只追加安全 `modelKind`，不暴露渠道 ID、原始 prompt、密钥或媒体哈希；Canvas 重新打开时按当前项目、目标节点及 modelKind=video 恢复任务绑定与取消按钮，已提交云端任务仍按 Ark 的 queued-only 取消限制处理。模拟官方 Ark HTTP + 真实 SQLite/BlobStore 测试首尾帧、全模态图/音频/Ark 视频资产、类型/模式错误阻断、重启不重 POST 及快照脱敏；**尚未完成真实方舟计费任务的端到端联调**。\n- **P4.4 第四轮：Ark 官方素材自动上传（2026-10-26，E 盘 custom）**：本地参考视频不再需要人工预先获取 `asset://`。普通 Canvas 视频生成冻结阶段复用 CAS 视频哈希，允许 MP4/MOV（按 MIME 和文件头校验）；后端 `ark-asset-manager.mjs` 通过火山引擎 TOS 官方 SDK `@volcengine/tos-sdk` 流式分片上传私有 Bucket 的 SHA-256 固定对象键，用固定的华北二 TOS HTTPS 签名 GET URL 调用方舟 **管控面** `CreateAsset`（Action/Version 2024-01-01），使用 AK/SK HMAC-SHA256 V4 签名，再以 `GetAsset` 轮询直至 `Active`，生成 `asset://<asset-id>` 注入 Seedance 的 `content.video_url.url`。它与原有 **数据面** API Key 生成任务严格分离。SQLite schema **v8** 新增 `ark_asset_uploads`，按 `blobId + Bucket + ProjectName + GroupId` 缓存 staged/creating/processing/active/failed 与素材 ID。CreateAsset 前原子记录 creating：若 API 响应丢失或进程崩溃导致创建是否成功未知，**不自动再次创建**，需要人工在素材库核实；Processing 已有确定的素材 ID 则重启后继续 GetAsset。磁盘 CAS 内容哈希在上云前再次流式验证；预签名 URL、AK/SK 和媒体字节均不保存到任务/素材表。没配置上传凭据时前端在本地文件冻结到 CAS **之前**通过 `/api/v1/execution/capabilities` 显式阻止本地视频提交，不影响纯文本、图片或现成 asset:// 视频。额外校验方舟 HTTP 200 内嵌业务错误、GetAsset 返回的 GroupId/AssetType 与缓存素材归属、TOS 签名 URL 真实对象路径和 Active 缓存中的素材 ID；既有 asset:// 引用优先于残留的本地 storageKey，避免重复上传。素材组、TOS Bucket、账号凭据不会自动创建：需要自己在方舟与 TOS 配好，并通过仅后端读取的环境变量设置（不要写到 Git）：

  ```powershell
  $env:ATELIER_ARK_ASSET_AK="<AK>"
  $env:ATELIER_ARK_ASSET_SK="<SK>"
  $env:ATELIER_ARK_ASSET_GROUP_ID="group-..."
  $env:ATELIER_ARK_TOS_BUCKET="your-private-bucket"
  $env:ATELIER_ARK_ASSET_PROJECT_NAME="default" # optional
  npm run dev
  ```

  上传必须符合方舟输入对时长/尺寸/编码/200 MiB 大小限制，当前代码对媒体头/MIME、大小、已有冻结元数据做校验，真实视频编码、时长、帧率和方舟模型权限需通过服务端审核与真机测试确认。模拟 TOS SDK/方舟控制面/Seedance 数据面的 SQLite 集成回归覆盖去重、Processing 重启恢复、未知 CreateAsset 防重复、素材 Active 后单次视频任务提交，**尚未使用真实 AK/SK、TOS 和付费 Seedance 联调**。
- **P4.5（2026-10-26，custom）ComfyUI 模板与预设 SQLite-only**：主数据库 schema **v9** 新增 `comfy_template_versions` 与 `comfy_presets`，`comfy-registry.mjs` 通过 canonical SHA-256 验证不可变模板、事务批量安装、预设引用和被项目/预设引用的版本删除保护；同源 `/api/v1/comfy/templates`、`/api/v1/comfy/presets` 走既有本机鉴权、CSRF 和 Host/Origin 校验。前端 `template-registry.ts`、`preset-registry.ts` 已改为只通过 SQLite API 读写，后端不可用不会回退到 IndexedDB；设置页已移除“导入浏览器旧预设”入口及专用 LocalForage 迁移实现，不再读取旧浏览器预设。项目 `.atelier.zip` manifest 内嵌引用的不可变工作流模板版本，导出遇到缺失依赖直接报错，导入先验证哈希与引用一致性再恢复模板和图。未将模型密钥、所有设置及其他非 Canvas 素材迁入 SQLite；全库/WAL 一致性快照仍属于 P5。
- **P4.6（2026-10-26）官方模型普通 Canvas 重试与并发提交收口**：固定官方 OpenAI（图/音频/文本）和 Ark Seedance（视频）的新生成仍由 `startSqliteModelGeneration` 统一走 SQLite JobCoordinator。本轮补齐结果节点重试：按结果保存的模型配置确定官方渠道，再从上游 Config 或唯一 Text 生产节点生成新的追加式后端任务，不再经过旧的浏览器 `requestGeneration`/`requestEdit`/`requestAudioGeneration`/`requestVideoGeneration` 重发收费请求；旧结果和错误历史保留。参考图编辑、带历史参考素材的视频结果重试、Skill、脚本等未支持组合明确拒绝，不允许官方路径回退浏览器请求。前端同一项目/来源节点提交阶段加同步锁，后端 `submitJob` 的 SQLite 写事务对 model 任务检查同一项目/来源的非终态任务，跨标签页并发只能入队一次。原幂等键仍可恢复原任务；只有对应旧任务完全终结后才允许新提交。暂未替换其他第三方/代理 API，真实计费联调仍待验收。
- **P4.7（2026-10-26）SQLite 任务历史、原因及安全落图恢复**：新增 GET `/api/v1/projects/:id/jobs?limit=20&before=<jobId>` 项目级游标分页，按时间和 ID 稳定排序，返回工作状态、来源节点、已生成产物与落图状态、受阻原因及安全白名单的执行结果码；**不返回**任务 Prompt、冻结快照、API Key、远程引用或凭据版本。画布顶部“SQLite 任务历史”提供状态浏览、分页、定时刷新、刷新本地画布、具体 blocked 产物的“重新尝试落图”以及成功但 pending 的已有产物“立即尝试落图”；新的后端重试入口仍沿用既有 `POST /api/v1/projects/:id/materializations/:artifactId/retry`，限定成功的旧任务+当前 blocked 产物，写事务更新并发出 `artifact_materialization_requeued` 事件。对 pending 产物新增 `POST /api/v1/projects/:id/materializations/:artifactId/recover`，只对当前项目已成功的旧任务定点执行 Materializer，不调用 JobCoordinator 或付费模型，不绕过 retry 的退避时间；Materializer 均会重新验证原指纹、原工作流端口和 Blob CAS。提交结果未知/密钥阻塞仅显示诊断，不提供自动重新付费生成。缺失产物的成功任务显示人工排查说明。P4.7 不包含远端未知任务的自动对账/恢复、不受限的全量任务列表或跨项目历史。
- **P4.8（2026-10-26）未知提交任务的 ComfyUI 人工对账**：新增 `POST /api/v1/projects/:id/jobs/:jobId/reconcile`，请求仅含待核对的 ComfyUI `prompt_id`，复用本地会话/CSRF/Origin 保护。JobCoordinator 只接受提交结果未知、`poll` 模式、已保存随机 `submit_marker`、提交屏障和不可变编译图的 ComfyUI 任务；只从绑定的本机实例读取 `/history/:prompt_id`，要求远端历史记录的原始提交标记及完整编译图均一致，若记录携带 client_id 还需对应本机提交尝试。无记录、标记不匹配、工作流图不匹配、不同项目/其他渠道、同 ID 已归属其他任务、运行中租约或并发状态改变都拒绝恢复，保持未知。证据通过后将原任务置为 `running`（仅轮询）、`collecting`（仅下载并落图）或 `failed`（远端证明失败），写入不含敏感信息的 `job_reconciliation_checked` / `job_reconciliation_verified` 事件；不执行 `/prompt`，不创建新生成任务。项目任务历史 UI 只对具备恢复条件的 ComfyUI 未知任务开放人工录入并二次确认；历史列表仅显示是否可对账，不暴露随机标记/Graph/密钥。方舟异步视频缺少相同绑定证明，OpenAI immediate 请求不具备可查询远端任务 ID，**本轮均不允许按任意远端 ID 恢复或重新提交**。未完成远端成功历史的真机核验与其他渠道可验证回执接入。
- **P4 后续**：完全停用 Canvas V2 双执行与废弃手动同步代码；普通图/视频/音频 API 的统一 JobCoordinator 化、后端模板持久化、视频和音频作为外部 Comfy 输入、更细的任务历史筛选/告警、其他渠道的可信远端任务对账、分页任务订阅与更完整端到端 Comfy 真机验证。SQLite-only 的“项目数据”已完全后端化，但素材库和设置持久化仍在 P5 单独处理。
- **P5.1（2026-10-26）全量 SQLite + BlobStore 停服备份与全新目录恢复**：新增 `cold-backup.mjs` 和 `npm run backup:data -- create|verify|restore`。安全停服且获得原实例的独占锁后才生成镜像；Node SQLite backup 包含已提交 WAL，按镜像中的 blobs 表逐项 SHA-256 验证 ready 媒体。manifest 记录数据库哈希、大小、schema 和 CAS 清单；备份及恢复均在私有 staging 验证 SQLite integrity/FK、Blob 完整性后发布。恢复只允许**全新的数据目录**，不覆盖原库、不向模型渠道发请求；运行中的实例、失效锁或目标已存在时直接拒绝。包含 DPAPI 密文但备份本身未加密；浏览器非 Canvas 数据、派生缓存与孤儿文件不包含，真机停服与断电恢复演练待完成；同机同账户的恢复副本激活保护已由 P5.2 补充，跨机双副本互斥仍不受支持。参见 `COLD_BACKUP.md`。
- **P5.2（2026-10-26）恢复副本激活/谱系保护**：新增 `dataset-activation.mjs`，为每份权威数据根目录生成谱系 ID 与原始副本 ID，v2 冷备份 manifest 保存谱系；恢复创建独立 standby 副本，`npm run backup:data -- activate <newDataDir> ACTIVATE_RESTORED_DATASET` 由用户在原实例停服后显式切换。实际后端初始化时先取得原目录实例锁和同一谱系共享锁并验证活动登记，随后才打开主库、恢复 JobCoordinator 和启动 Worker。激活前重验 SQLite/FK 和每一个 registered CAS 文件哈希，活动谱系登记被删除/损坏或副本 ID 不符时 fail-closed；切换后旧数据目录在同账户本机无法重启。P5.1 v1 旧备份可校验但不允许不安全的直接恢复；跨用户/跨机器无法提供分布式活动互斥，原地手工复制不享有新流程的谱系保证。参见 `COLD_BACKUP.md`。
- **P5.3（2026-10-26）持久 CAS 引用台账 + 断电后只读媒体审计**：SQLite schema v10 新增 `blob_ref_ledger`（来源类型、来源主键、64 位 CAS 哈希）及 `blob_ref_ledger_state`（脏标记、变更序列、重建序列、重建时间）。项目、聊天、冻结任务、Comfy 编译输入、产物、任务事件、模板版本、Ark 素材记录的新增/修改/删除均在各自 SQLite 事务中通过 SQL 触发器把台账标记为 dirty。进程安全启动和明确的 GC 维护会事务性重建拥有者引用；GC 只在已对账台账及实时引用扫描都不保留目标、7 天冷却、无活动上传、无 FK 引用且需明确人工确认时才移除文件，不会把台账遗漏当成删除依据。新增 `npm run backup:data -- audit <dataDir>` 停服独占锁只读检查所有 registered CAS 的大小/SHA-256、磁盘孤儿文件及 `tmp/*.part` 断电残留，损坏、未登记文件只告警不自动删除/修复/重发模型请求。专项测试覆盖事务回滚、持久化、多个引用来源、数据库/文件缺失、相同长度篡改及文件提交前后断电窗口。仍不承诺任意时刻跨 SQLite/文件系统的原子事务或自动删除孤儿文件；详见 `COLD_BACKUP.md`。
 - **P5.4a（2026-10-27）非 Canvas 素材库 SQLite 元数据与媒体 CAS 收口**：主数据库 schema v11 增加唯一 `asset_catalog`（revision+assets_json），`asset-catalog.mjs` 对每次 PUT 进行版本 CAS、主键/种类/大小校验，图片/视频必须是后端已登记的 `cas:<sha256>`、与 BlobStore 的 MIME/byteSize 完全一致，拒绝 `blob:`、`data:`、`image:`、`video:` 等不可移植链接；同源 `GET|PUT /api/v1/assets` 使用现有会话/CSRF/Origin。Zustand 素材库只从 SQLite 读取，乐观版本冲突或请求结果未知时拒绝盲写，没有旧浏览器库自动回退。历史曾提供“导入旧浏览器素材”人工迁移入口，但该入口及对应 LocalForage 读取/迁移实现现已移除；SQLite 素材库不会自动回退浏览器数据。新素材上传入口改为 BlobStore，Asset 引用纳入 P5.3 持久台账与保守 GC；P5.1 冷备份包含 v11 元数据与被引用 CAS 文件。**这仅覆盖素材库元数据及其媒体，不代表整个非 Canvas 本地配置已经迁移**：渠道模型设定、第三方普通 API、Skills、其他缓存/本地存储继续分期收口。历史全应用浏览器 ZIP 不能替代 P5 完整冷备份。
- **P5.4a 收尾**：独立素材 ZIP 的旧媒体键 `image:`/`video:` 在导入时重写为后端 CAS，不创建浏览器端媒体副本；校验失败不添加素材，内容地址不匹配拒绝成功。全应用旧 ZIP 发现含后端 CAS 的项目/素材即拒绝误导性导出；导入不能覆盖已有 SQLite 项目/素材。Canvas 节点、Prompt 素材收藏及素材页在成功提示前等待素材库 SQLite 落盘，写入版本冲突或结果未知后停止盲写。增加源码级前端专项测试与后端 SQLite 快照/引用保护测试。
- **P5.4b（2026-10-27）模型设置与主题偏好 SQLite 分离收口**：修复 Markdown 超大文档缓存引用复用问题。SQLite schema v12 新增 `ui_settings`（`model_config` / `theme` 独立 revision）；同源会话/CSRF 的 `GET|PUT /api/v1/ui-settings/:name` 使用预期版本防止冲突。模型设置及主题从 SQLite 加载，不自动回退旧浏览器设置，也**不提供旧设置迁移按钮**。后端拒绝 Key、令牌与脚本进入设置表；普通配置 JSON 与旧应用 ZIP 排除密钥和脚本。仍依赖浏览器直连的 Key / 自定义脚本保存在浏览器独立临时凭据记录中（明文、不随 SQLite 冷备份），不自动覆盖 Vault 或删除旧数据。
- **P5.4c（2026-10-27，显式迁移入口已撤销）**：现有 DPAPI Vault 与 `POST /api/v1/channels`、`PATCH /api/v1/channels/:id/credential`、SQLite JobCoordinator 的 `secretVersionRef` 调用链继续保留，渠道编辑器可以正常创建/更新服务端加密凭据；密钥未改变时不会无谓轮换现有凭据。**按最新产品要求，移除设置页旧 Key 批量迁移/明文清理按钮与执行模块**。浏览器直连所需密钥不自动删除；历史版本已经写入的 `atelier:vaulted-model-channels` 标记仍被只读尊重，避免让旧明文重新激活。跨设备 DPAPI 仍需重新配置密钥；这不代表所有渠道已实现后端执行。
- **P5.4d（2026-10-27）SQLite 图片编辑与带图文本问答**：复用官方 OpenAI DPAPI Vault → SQLite JobCoordinator → CAS BlobStore → Materializer 链路。openai-model-adapter 的 image + operation:edit 通过官方固定地址 /images/edits 提交 multipart 图片与可选 PNG mask；text + images 通过 Chat Completions 提交图文混合输入。参考图在 JobSnapshot 仅保存 {blobId,mimeType}；后端核验 CAS 存在、MIME、单文件/总大小和 SHA-256，拒绝任意外部 URL、内嵌 Base64、错误 MIME，API Key 不进作业快照。Canvas 普通图生图与带图文本节点、局部涂抹和角度重绘的官方 OpenAI 路径已接入；产物由 Materializer 自动追加节点，来源改动遵循 revision/指纹隔离，失败不回退浏览器直连。输入 CAS 哈希纳入 P5.3 持久引用台账及冷备份。限制：每任务 8 张参考图、单图 20 MiB、总计 64 MiB、单结果；mask 仅限单图 PNG。暂不覆盖自定义网关/Gemini 适配、交互式流式文本、Skill 工具调用、混合视频/音频参考、非 Canvas 公用 API 和全产品密钥清理；不恢复已移除的设置迁移按钮。
- **P5.4e（2026-10-27）SQLite 文本会话与可重放流式进度**：官方 OpenAI text JobSnapshot 可提交冻结的多轮消息历史（system/user/assistant 与已执行工具调用的 assistant/tool 记录），角色、字段、工具 ID/参数匹配、长度与末尾用户提示词需验证；不允许浏览器 Key 或内嵌媒体进入作业快照。文本任务可选择 upstream Chat Completions stream=true，后端增量解析 SSE、按上限写入 model_text_delta JobEvents，经既有 SSE 订阅提供非权威临时预览；仅收到完整结束标志才将最终文本写为 CAS 产物并由 Materializer 写回，截断/网络不明进入 submission_unknown，**不会重发付费调用**。普通 Canvas 文本生成已使用流式任务并可注入经用户明确选择、固定版本的手动 Skill 指令；自动 Skill 工具调用仍未接入后端（不得把模型给出的函数名自动执行），多轮历史后端协议已有支持，但画布的多轮会话交互与自动 Skill 回合需要后续专门接线。每个请求最多 32 条历史消息，总计 128 KiB，单条工具输出 32 KiB；前端仅显示最后少量实时文本，历史中间流式片段会保存在 SQLite 的 job_events 中并纳入冷备份。普通生成复用已存在的 Vault 版本，避免每次执行无谓密钥轮换，保留尚有浏览器直连用途的凭据，不恢复设置页迁移按钮。
- **P5.4f（2026-10-27）自动 Skill 后端只读回合**：Canvas 官方 OpenAI 普通文本任务支持自动 Skill。浏览器首先复核已启用、项目 scope 与版本固定的 Skills，将本次完整文本包（SKILL.md 和可读取的 references 文本）冻结成 ≤1 MiB 的 `text/plain` CAS JSON；JobSnapshot 仅保留 `task.skills.blobId`，CAS 哈希由 SQLite P5.3 引用台账/冷备份保留。后端在 prepare/submit 验证 CAS MIME、长度、SHA-256、包结构、固定版本标识与安全相对路径。**受限工具白名单**只有 `search_skills` / `activate_skill` / `read_skill_resource`，且 `read_skill_resource` 必须先 activate，工具参数严格按 schema，拒绝任意命令、磁盘、网络、绝对路径及 `..`。每个任务最多 6 轮工具、12 次工具调用；多轮使用同一 SQLite submit barrier、每次调用固定官方 Chat Completions 端点、工具进度写入 job_events，前端通过 SSE 显示。只在取得完整最终文本后写 CAS Artifact；中断、非法工具、未决网络响应 => submission_unknown，不执行第二次提交。工具正文不进入 job_events，但通过 CAS 冷备份可读。Skill 内容来自同源已授权的用户本地包，服务端不具备独立签名/第三方发行者身份验证；**这不是开放任意远端 Skill 执行**。自动 Skill 回合使用非 streaming Chat Completions，文本增量/工具调用的混合流仍待后续；普通非官方自定义模型、Gemini、公共文本 API 和历史生成节点重试的 Skill 适配未统一收口。浏览器 Skill 目录仍在 IndexedDB，不在完整 SQLite Skills 注册表；仅本次冻入 CAS 的资源属于冷备份。保留已移除的迁移入口状态。
- **P5.4g（2026-10-27）Skill 历史版本恢复、工具审计与混合 SSE**：SQLite 任务历史为已冻结 Skill 的项目任务显示 `hasSkillSnapshot`，新增项目限定 `GET /api/v1/projects/:id/jobs/:jobId/skill-audit` 返回版本 ID、Skill 名称、白名单工具名称/调用轮次/状态（不返回 Prompt、Skill 正文、函数参数或 API Key）。历史页可在人工确认后调用 `POST /api/v1/projects/:id/jobs/:jobId/replay-skills` **创建新付费任务**，只允许原任务 `succeeded`、官方 OpenAI 自动 Skill、源节点与所有上游输入的指纹未变，复用原始 JobSnapshot、CAS 版本、模型和凭据版本；新 idempotencyKey 防重，任务仍由 JobCoordinator 执行并追加结果，不重试 `submission_unknown` 或覆盖旧产物。结果节点的普通重试若检测到自动 Skill，转为引导打开 SQLite 任务历史，禁止悄然以当前 Skill 版本重发。后端 `skill-stream-parser.mjs` 对每个 Chat Completions SSE 轮次拆分的内容/token、函数名称与 JSON 参数增量组装，完整 `finish_reason` 与 `[DONE]` 到齐才执行工具、提交下一轮，参数严格按白名单验证；部分输出 `skill_text_delta` + `round` 以有界 SQLite JobEvents 通过同源 SSE 展示，**它们仅是非权威进度，不构成成功产物**。异常/截断按 `submission_unknown` 处理，不重发已提交的计费轮次。自动 Skill 混合 SSE 保留最多 6 工具轮、12 次工具与同一 submit barrier 约束；不开放任意 Skill 脚本、外网抓取、第三方模型或跨设备 DPAPI 凭据自动恢复。对于原来源已变化但用户想沿用旧 Skill 的内容编辑/新生成，需要后续单独设计安全衍生工作流，不能复用原指纹直接跳过校验。
- **P5.4h（2026-10-27）Skill 注册表 SQLite v13 收口**：后端新增 `skill_registry_state`（全局递增 revision）、`skill_entries`（启用状态、当前版本、可选项目作用域）和 `skill_versions`（不可变版本：manifest、SKILL.md、references 只读文本、可选原始 ZIP BLOB）。`GET /api/v1/skills` 与指定版本读取为 SQLite 唯一权威；导入、启停、改作用域、切换版本、删除均走同源 session/Origin/CSRF 的 POST/PATCH/DELETE，携 `expectedRevision` 在事务内做 CAS 防并发覆盖。严格限制每库最多 100 Skills、500 版本、单 Skill 30 版本、文本/ZIP 每包 5 MiB；禁止读取/执行 scripts 或不安全路径，历史版本 hash/内容冲突拒绝覆盖。前端 `skill-registry.ts` 保留稳定 SDK 导出接口但不再访问旧 LocalForage `skill_packages`；自动与手动 Skill 根据新目录做 enable/scope/version 校验，冻结到既有 CAS JobSnapshot 的流程不变，历史任务继续使用原冻结版本而不受当前目录删除影响。旧 IndexedDB 原始数据**保留但不自动导入或回退**；用户可在现有 Skill 管理器按原文件逐个导入，**不恢复设置迁移按钮**。全部 SQLite 元数据、正文与可选原始 ZIP BLOB 由 `backup:data` 冷备份；旧版浏览器全应用 ZIP 不能备份/覆盖含 Skill 的 SQLite 数据，必须使用完整冷备份。旧浏览器 ZIP 导入含 Skills 时提前明确拒绝，避免静默破坏 v13；`restoreSkillSnapshot` 仅阻止旧快照覆盖。现有版本哈希沿用前端 ZIP 解析生成的标识，后端校验形状和版本不可变性，**不应把它视为作者签名或独立可信发行验证**。其余本地临时凭据和第三方公共 API 未整体迁移。
- **P5.4i（2026-10-27）Skill 包独立完整性复验与多标签页目录同步**：SQLite Skill 导入与读取时使用后端独立 `skill-package-integrity.mjs` 按 `path + NUL + 原字节长度 + NUL + 原文件字节`、按 normalized path 进行 `localeCompare` 排序重算 SHA-256；对 `.zip` 先解析中央目录、校验条目/大小/路径/加密/符号链接/压缩比，再做限定内存解压，纳入脚本/素材等全部原始成员字节核对。无原始 ZIP 的单 `SKILL.md` 包对正文/参考资源重算；同时复核 YAML name/description、manifest id/hash/version、resources/warnings 与参考文件一致，拒绝伪造、篡改和损坏的 SQLite 版本行。**SHA-256 是字节完整性，不是来源签名/发布者信任证明**；脚本仍不可执行。Skill 管理器跨同源标签页采用 `BroadcastChannel` 变更通知、窗口焦点及可见时每 10 秒重新读取 SQLite 权威 revision，遇不可用环境使用 focus/poll 回退；每个 UI 修改携其实际看到的 `catalogRevision`，过期返回 `skill_revision_conflict`、主动刷新目录并要求重新确认，不能从后台取最新版本号后静默覆盖其他标签的决定。自动/手动 Skill 运行时仍以 SQLite 已启用/项目 scope/版本为准，完整冷备份保留原版本数据；不导入或清理旧 IndexedDB、不恢复设置迁移按钮。
- **P5.4j（2026-10-27）自动 Skill 冻结授权一致性与恢复集成验收**：原先自动模式先读 SQLite Skill 目录再逐个取包，中间禁用/改 scope/删版本存在 TOCTOU。现在 `freezeSqliteSkillCatalog` 在规划前记录 `getSkillRegistrySnapshot().revision`，构造固定 `skillIds`/`versionPins` 后调用新的同源 `POST /api/v1/skills/authorized-catalog`，服务端在同一次同步 SQLite 读里验证项目存在、**expectedRevision** 不变、每个 Skill 当前 enabled/project scope、版本存在与内容 hash/manifest 复验，最后按顺序返回仅授权的 SKILL.md/references；客户端不再通过自行逐个 `getSkillPackage()` 拼接自动 CAS。`skill_revision_conflict` / `skill_authorization_changed` 提交前拒绝上传和模型调用；成功授权的内容再写 1MiB `text/plain` CAS 进入原 JobSnapshot，已明确冻结的历史任务不随随后删除/禁用重写，未知提交继续禁止自动重试。新增 SQLite 注册→HTTP 授权→CAS→假上游多轮 tool→job artifact→`backup:data` 验证与恢复的跨模块集成测试；同时覆盖 scope/禁用/修订号变化拒绝、删除目录后的 CAS 可读、第二轮请求断链无重复提交。`npm run test:backend` 显式收纳之前漏掉的 `sqlite-skill-registry.test.mjs` 与新增 `skill-end-to-end.test.mjs`。**边界**：当前授权操作是受保护的标准 Canvas UI 路径；`POST /api/v1/jobs` 尚无持久可核对的“本次 Skill 授权授予记录”，所以可由有权限的本机客户端自行构造历史格式 CAS 快照直接发 Job；下一轮应将生成授权 CAS/授权票据与 Job 提交统一绑定，防止绕过 UI。没有真实收费 OpenAI 联通测试，也没有双标签页真实 GUI 驱动（目录交互仍依赖模拟测试）。不自动迁移旧浏览器 Skills、不恢复设置迁移按钮。
- **P5.4k（2026-10-27）自动 Skill 服务端冻结与 Job 一次性授权绑定**：SQLite v14 新增 `skill_job_grants`（项目 ID、服务端创建的 CAS blobId、当时 Skill 目录 revision、签发/过期时间和唯一 jobId）。标准 Canvas 自动 Skill 不再由浏览器上传冻结正文：`POST /api/v1/skills/freeze` 在后端一次校验项目/所有 Skill 的 enable/scope/version/内容完整性，形成 `atelier-skill-snapshot-v1`，写入 `text/plain` CAS 并在文件 IO 之后事务内再校验 revision，然后返回 `{blobId,authorizationId,revision}`（不返回正文）。前端把 `authorizationId` 作为 **Job 请求顶层字段**，`task.skills` 仍仅 `{blobId}`；对外 `POST /api/v1/jobs` 通过 `submitJob(requireSkillGrant:true)` 在 **同一 SQLite 事务**插入 Job 后核对签发的项目/精确 blobId、十分钟有效期、未被消费、目录 revision 未变化，设置 `skill_job_grants.job_id` 唯一绑定；错误会整体 ROLLBACK，不产生部分 Job/授权消耗。相同 idempotencyKey 的已接受请求仍安全返回原 Job，不产生新的计费提交；其他 key 不能重用授权，伪造 CAS/跨项目/过期/撤销/改 scope 被拒。后端可信内部历史 replay 使用成功旧 Job 的不可变 snapshot/source fingerprint 独立保护，不走普通 HTTP grant；旧任务 CAS 仍可恢复/重放。测试包含攻击路径和客户端授权参数转发，已将 `skill-job-grants.test.mjs` 放入默认后端测试。**边界**：本地授权会话仍拥有对自己当前获授权 Skills 创建新授权的权利；授权证明完整性与 Job 绑定，不等于 Skill 发布者签名。已过期且未消费的授权记录尚未自动清理，下一轮可做有界 GC 与恢复/重放的进一步断电测试。不自动迁移旧 IndexedDB、不恢复设置迁移按钮。
- **P5.4l（2026-10-27）授权清理和历史 Skill 重放幂等恢复**：新增 `pruneExpiredUnclaimedSkillGrants`，仅删除 `job_id IS NULL` 且 `expires_at` 超过 24 小时保护期的记录，每事务至多 100（接口可限定至 500）；在新授权签发事务中顺带有界清理，**绝不删除已绑定 Job 的授权，也不碰 BlobStore/CAS 文件**。新增项目隔离的只读 `GET /api/v1/projects/:id/jobs/:jobId/replay-status?idempotencyKey=...`：只找同项目、同源节点指纹和完全相同 JobSnapshot 的历史成功 Skill 重放，返回 `found/jobId/status`，绝不执行付费 POST；来源图之后改变不妨碍核实已接受 Job。前端 `replayCanvasSkillJob` 在 POST 前将 `idempotencyKey` 与 `expectedProjectRevision` 作为短小的非敏感提交意图存入 `localStorage`（不可用时回退 `sessionStorage`/当前页内存），只为网络重启与多标签页恢复使用，**不是 Skill/项目权威业务数据**；同页并发点击复用同一个 in-flight Promise。提交响应丢失先只读查询，若服务器证实已接单则显示原 Job；尚未证实就保留意图并将 UI 变成只读“核实待确认提交结果”，不会产生新随机 key/第二笔付费请求。只有后端明确非模糊 4xx 且查询确认无 Job 时可丢弃意图；损坏持久意图也拒绝自动再次提交。**限制**：完全禁用浏览器存储时，刷新/关闭应用仍可能丢失当前页面内存中的提交意图；跨标签页近乎同时首次点击不是数据库级 replay 锁，仍依赖 Coordinator 的活跃 Job 栅栏，不应宣传所有场景的 exactly-once 计费。无人工 GUI 或真实收费官方 API E2E 验证。
- **尚待完成**：超过 2 GiB 的单项目 ZIP64/分段归档及在线一致性备份、派生预览文件清理与失效缓存重建、跨 SQLite/文件系统强原子事务和自动化断电后安全修复（P5.3 已实现持久保守引用台账和只读磁盘故障审计，GC 仍需明确人工确认）、其他非 Canvas 浏览器缓存、设置残余项/普通第三方 API 数据收口与备份密文的跨设备恢复限制；`services/api/video` 等公用非 Canvas 入口仍可能使用旧素材库。跨标签页 Materializer 增量刷新、生产静态站点托管、聊天按会话行拆分仍在后续计划。**P4/P5 完成前不可宣告整个产品 SQLite-only 全部完成。**

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

主数据库现已升级到 **schema v9**（v7 画布状态分离、v8 方舟素材、v9 ComfyUI 模板与预设）。下表保留早期结构规划，其中聊天逐会话拆表等仍属于后续阶段：

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
