# P1 · 自定义模型脚本（后端受限执行）

OpenAI 兼容渠道的文本、无参考图文生图、JSON Base64 音频、**异步文生视频**已接入本地 SQLite JobCoordinator + Credential Vault + CAS。后端按用户填写的 HTTP(S) API 地址执行，不要求配置渠道白名单。模型脚本不是任意 JavaScript：仅解释一个经过 AST 检查的语言子集，不使用 Node.js `eval`、`new Function` 或任意动态模块。

**浏览器回退边界（P1）**：OpenAI 格式渠道（包括自行配置的 OpenAI 兼容接口）只通过画布后端 JobCoordinator 执行自定义脚本。`runModelPlugin` 的旧调用入口对这些渠道直接拒绝执行，不能因为画布之外的图片/音频/视频/文本辅助调用而重新把 API Key 交给浏览器 `new Function`。脚本编辑器对 OpenAI 格式只显示受限后端模板与可用变量（如 `model`、`params`、`http`），不再提供会把 `apiKey`、`request`、`poll`、`fetch` 暴露给前端的旧模板。旧脚本保留在渠道设置中，不自动转换或删除，用户需显式调整到安全模板；不支持的调用会明确报错，而非静默换接口或重新发起可能收费的请求。

Gemini 格式、非标准方舟旧脚本等尚未接入统一后端受限解释器的路径本轮**保持原行为**，仍可能使用浏览器 JavaScript，不能视为已完成全面隔离。下一步需为这些 provider 做独立后端适配，再移除剩余浏览器执行器。

## 普通图片、文本、音频脚本

进入「配置与用户偏好 → 模型渠道 → 选择模型 → 脚本」，选择对应的「安全脚本」模板。支持 `const`、`model`、`prompt`、`messages`、`params`、JSON 属性与数组访问、基本表达式、`await http.post()`、`return`；每次执行仅允许一个网络请求。文本返回字符串；图片返回 PNG/JPEG/WebP Base64；音频返回 JSON 中 MP3/WAV/FLAC Base64。单张生成、无参考图/Skill。

## 异步视频脚本

选「安全异步视频（提交/轮询）」模板后，编辑两个独立的受限脚本。完整编辑器内容是 JSON 字符串（`version=1`），而非单段立即执行的浏览器 JS。示例：

```json
{
  "version": 1,
  "submit": "const data = await http.post(\"/videos\", {model, prompt, seconds: params.duration, ratio: params.ratio, first_frame: params.firstFrame, last_frame: params.lastFrame, reference_images: params.referenceImages, reference_videos: params.referenceVideos, reference_audios: params.referenceAudios}); return data.id;",
  "poll": "const data = await http.get(\"/videos/\" + remoteTaskId); return {id: data.id, status: data.status, videoUrl: data.video_url || data.url};"
}
```

视频节点的首帧、尾帧和最多 4 张普通参考图片通过既有画布素材角色绑定。前端先冻结为 CAS `blobId`（每张最大 8 MiB，合计最多 24 MiB，最多 6 张）；JobSnapshot **只保存哈希、MIME 和角色**。后端在第一次付费提交前检查 CAS 文件大小、类型及 SHA-256，随后仅在 `submit` 阶段临时生成 `params.firstFrame`、`params.lastFrame`、`params.referenceImages`（Data URL），由脚本决定如何映射到第三方请求 JSON。`poll`/`cancel` 不会读取或再次发送这些素材。另支持最多 3 段参考视频（MP4/MOV/WebM，每段不超过 12 MiB）和 3 段参考音频（WAV/MP3/FLAC/OGG，每段不超过 6 MiB），整体参考素材总大小不超过 32 MiB；在 `submit` 阶段通过 `params.referenceVideos`、`params.referenceAudios` 提供 Data URL 数组。上述数据不会写入任务快照。需要先上传素材才能获得远端素材 ID 的第三方接口，仍需专用的上传/恢复适配器，不能直接复用方舟专属 TOS 协议。

`submit` 必须返回远程任务 ID（字母、数字、下划线和连字符；最多 128 位）；JobCoordinator **只提交一次**并持久化任务 ID。之后 `poll` 每次从 SQLite 传入 `remoteTaskId`，只允许 GET 此 ID 对应的路径；返回 `{id?,status,videoUrl?}`。状态接受 `queued/running/in_progress/processing/succeeded/completed/failed/cancelled/canceled/expired`，其中成功时 `videoUrl` 是视频媒体 URL。远端响应不确定时不会自动重新付费提交。

可选第三段 `cancel`：使用 `await http.delete("/videos/" + remoteTaskId)`，只在轮询确认远程状态是 `queued` 时执行，并在执行后再次轮询确认 `cancelled` 才算成功。不写 `cancel` 时明确返回不支持取消，不会伪称成功。

视频媒体下载单独执行 **无 API Key 的 GET**，支持 HTTPS 公网签名 CDN 地址，或与已冻结 API 地址同源的本机/局域网 HTTP 媒体 URL。拒绝用户信息、重定向、元数据地址、DNS 回绑定、非视频内容以及超过 200MB 的数据。只收集 MP4 或 WebM，写入 CAS 后再标记成功；下载失败仅重试读取/下载，不重复发起生成。

## 远端素材 ID 上传（可选）

对于同一 OpenAI 兼容渠道上提供 **JSON 上传接口** 的服务商，在视频脚本编辑器选择「安全异步视频（远端素材 ID）」。现有直接嵌入 Data URL 的视频脚本不受影响。

```json
{
  "version": 1,
  "assetUpload": "const r = await http.post(\"/assets\", {model, type:params.asset.kind, role:params.asset.role, mime_type:params.asset.mimeType, content:params.asset.dataUrl}); return r.id;",
  "submit": "const r = await http.post(\"/videos\", {model, prompt, reference_video_asset_ids:params.referenceVideoAssetIds, reference_audio_asset_ids:params.referenceAudioAssetIds, first_frame:params.firstFrame, last_frame:params.lastFrame, reference_images:params.referenceImages}); return r.id;",
  "poll": "const r = await http.get(\"/videos/\"+remoteTaskId); return {id:r.id,status:r.status,videoUrl:r.video_url||r.url};"
}
```

`assetUpload` 是 **可选的第三个受限脚本阶段**，仅对 CAS 冻结的参考视频、音频逐项执行。可访问 `params.asset.kind`、`role`、`mimeType`、`sha256`、`index`、`dataUrl`；每项调用最多一次同渠道的 `http.post`，返回远端素材 ID 字符串或 `{id}`（字母/数字/`_`/`-`，最多 128 字符）。上传只从 Vault 获取当前任务冻结的渠道密钥版本。

上传前必须写入 `script_asset_uploads` 的 `uploading` 不可重放屏障；成功响应后写入 `active` 及远端 ID。视频 `submit` 不再附带视频/音频 Base64，而是使用 `params.referenceVideoAssetIds`、`params.referenceAudioAssetIds`。图片仍可在 `submit` 阶段作为 Data URL。JobSnapshot 只包含 CAS 哈希、脚本和 Vault 密钥版本**引用**，不包含远端上传 ID 或大媒体。

**响应丢失或进程意外终止后，`uploading` 状态禁止自动重复上传。** 后端会使任务准备失败、保留已确认的其他素材 ID；需要对照服务商记录进行人工核对，再决定如何恢复。上传返回确定的 4xx 拒绝时保存 `rejected` 状态，不会自动重试。当前没有自动远端任务 ID 对账接口。

这是一条适用于 JSON Base64 上传的受控实现，不代表支持 multipart/form-data、分片上传、跨域预签名 PUT、先申请上传地址再上传内容等协议。此类 API 仍需要逐供应商适配器。用户自定义的 HTTP(S) 渠道地址无需配置主机白名单，但仍接受 DNS/SSRF 校验、无跳转、同一渠道地址与受限 HTTP 动词约束。

### 同渠道 Multipart 上传

第三方视频模型要求 multipart/form-data 时，在视频脚本编辑器选择「安全异步视频（Multipart 上传）」。复用现有 assetUpload、submit、poll 阶段，CAS 冻结、Credential Vault 和人工对账恢复。

受限脚本中使用 http.multipart("/assets", {fileField:"file", fields:{model, role:params.asset.role, mime_type:params.asset.mimeType}})；只允许在 assetUpload 阶段，固定为 POST、相对当前冻结渠道的合法 API 路径。脚本不得自定义目标域名、鉴权 Header、文件名、任意本地路径或二进制文件内容。

后端仅从已完成 MIME/大小/SHA-256 校验的 CAS 素材创建真实的 FormData 二进制文件字段，采用内容哈希派生文件名。fileField 默认为 file；fields 最多 24 项，键名受限，值仅支持短文本、有限数字或布尔值，不允许内嵌 Base64、控制字符和任意结构。multipart boundary 由底层 HTTP 客户端生成，Authorization 由 Vault 注入，不写入任务快照。

每项上传依然先写入上传不可重放屏障，再进行网络 POST。远端素材 ID 成功响应后持久化并复用，响应不确定时禁止自动重传，可在任务历史进行人工核对；继续使用视频最多 12 MiB、音频最多 6 MiB、全部参考素材 32 MiB 的限制。

尚不支持预签名跨域 PUT、多文件字段、分片续传和专有多步骤上传协议。

### 公网 HTTPS 预签名 PUT（单文件）

如果服务商会先在渠道 API 返回远端素材 ID 与临时上传地址，可以选择「安全异步视频（预签名 PUT）」模板。服务端先执行一次受限的同渠道 `http.post("/assets/presign", ...)`，脚本返回 `{id: grant.id, uploadUrl: grant.upload_url}`。普通模板只适用于返回素材 ID 的单次 PUT 协议。上传后需要额外确认的服务商应使用下方的多阶段模板；要求在确认完成后才首次返回 ID 的服务商仍需专用适配器。

后端从 CAS 校验文件的 SHA-256、MIME 和大小，随即向临时 URL 发送 **一次 HTTPS PUT** 原始文件字节。只允许公开 HTTPS 域名和标准 443 端口；禁止 IP 字面量、localhost、内部域名、认证信息、重定向，并在建立连接时验证、固定 DNS A 记录为公网地址。预签名 URL 可以带查询签名，但不得写进任务快照、数据库、日志或错误信息。PUT 请求**绝不携带渠道的 Vault API Key**，只使用服务端校验的 Content-Type，不能从脚本自定义 Header。

这两个网络步骤共用原来的 `script_asset_uploads` 不可重放屏障：在申请地址之前先写入 `uploading`，只有 PUT 明确返回 2xx 才将 ID 记为 `active`。申请地址、实际上传及读取响应任一步结果不确定，都不会自动重发，也不会开始生成；可在任务历史人工核对。多个资产逐项处理、已完成的 ID 可以在重启后复用。

当前范围只覆盖返回 ID 与 URL 的**单文件、单次 PUT** 协议，不支持 POST 表单上传到预签名跨域域名、自定义签名 Header、分片上传、断点续传或随后必须执行 complete/finalize 的 API。

### 预签名 PUT 后完成确认

选择「安全异步视频（上传完成确认）」模板。在原先的 `assetUpload` 之外增加可选 `assetFinalize` 受限脚本，其调用示例：

```javascript
const result = await http.post("/assets/" + params.asset.remoteAssetId + "/complete", {
  id: params.asset.remoteAssetId
});
return result.id;
```

完整上传阶段是「申请预签名 URL → PUT 原始 CAS 文件 → 持久化已成功上传的远端 ID → 发出一次完成确认 → 完成后激活远端素材」。只有同渠道 POST 的完成接口受支持；确认接口必须返回 **与申请阶段相同的素材 ID**，否则不激活素材。上传 URL、媒体内容不会保存到任务快照或完成阶段记录。

后台新增独立的 `script_asset_finalizations` 持久化阶段：`uploaded` 表示 PUT 已确认成功、尚未发出完成请求；`finalizing` 表示请求已发出、结果可能未知；`completed` 表示远端确认响应中的 ID 匹配，且已与素材 `active` 在同一事务内提交。重启后 `uploaded` 可以恢复完成请求而 **不重做 PUT**；`finalizing` **绝不自动重试**，需要人工向服务商核实后使用已有的素材对账入口。所有远端 ID、密钥版本与 CAS 素材仍按原任务身份约束，只有 `active` 的素材才进入视频生成提交。

目前不支持上传后才首次分配远端素材 ID、完成请求使用特殊签名头、分片续传或将整个服务商协议交给任意 JavaScript 执行。

### 可恢复的分片预签名 PUT（最多 8 片）

选择「安全异步视频（分片上传）」模板。服务商的 `assetUpload` 必须返回 `{id, partSize, parts:[{partNumber,uploadUrl}]}`，`partSize` 以字节为单位；服务端验证素材总长度、固定分片大小、分片序号从 1 连续排列、2–8 个分片及全部公网 HTTPS 目标。脚本不能指定任意文件路径、分片偏移或自行提交 HTTP PUT。每片由冻结 CAS 原始字节截取，使用无渠道密钥的 HTTPS PUT 发送，**每片 2xx 必须返回合法 ETag**；缺少 ETag 或响应不明都不得视为成功。

为了支持重启恢复未开始的分片，新增受限 `assetPartUrls` 阶段：它只能使用当前渠道的只读 GET，访问原素材 ID 对应的 `/parts/<assetId>`，返回 `{id,parts:[{partNumber,uploadUrl}]}`。服务商必须保证这是**只读签名地址刷新**，不能创建新素材会话。若服务商没有该能力或安全保证，不要使用此通用模板。重新获得的 URL 只在内存中使用，不进入数据库或任务快照。

完成后 `assetFinalize` 请求通过 `params.asset.partEtags` 取得按分片序号排序的 `[{partNumber,etag}]`，并返回与申请时相同的素材 ID。只有全部分片有已确认 ETag，才能进入完成确认与视频生成。数据库中的 `script_asset_chunk_sessions` 只保存素材 ID、CAS 哈希、脚本指纹、分片大小及数量；`script_asset_chunks` 为每片保存 `ready/uploading/uploaded` 和 ETag。网络 PUT 前先将该片持久化为 `uploading`；重启只跳过 `uploaded` 片，对 `ready` 片重新获取只读签名地址继续；对任何 `uploading` 片一律停止，转人工对账，**绝不盲目重传**。此处不是任意服务商的自动断点续传：结果不明的片不能自动判定成功。

现有媒体限制不变：视频最多 12 MiB、音频最多 6 MiB、全部参考素材最多 32 MiB；单片最大 8 MiB，最多 8 片。不支持要求特定 Content-MD5、S3/OSS 额外签名请求头、单次 PATCH、专有校验算法或完成确认后才首次生成素材 ID 的服务商。页面不暴露任何签名 URL、渠道密钥或原始分片数据。

### 结果未知分片的只读服务商核对

分片脚本可选 `assetPartAudit`，通过受控的同渠道 `http.get("/assets/parts/status/"+params.asset.remoteAssetId)` 获取 `{id,parts:[{partNumber,etag}]}`。服务商必须保证该接口**只读且返回当前上传会话的权威分片状态**；这不能仅靠 HTTP GET 字面保证，由渠道接入者按服务商文档核实。脚本不能指定任意 URL、方法、凭据或文件内容。GET 只向当前冻结渠道发起，仍进行 DNS/SSRF 防护、禁跳转及响应大小限制。

当分片 PUT 已发出、结果未知时，在「任务历史 → 核对远端素材上传」点击「从服务商只读核对未知分片 ETag」。后端验证上传会话 ID、分片数量、每个 partNumber、合法 ETag、已确认分片 ETag 不变、`ready` 分片不能出现远端回执，以及原任务从未进入视频生成提交阶段。只有**所有未知分片都具有可信服务商 ETag**，才会在一次事务内将对应分片 `uploading → uploaded` 并写入对账事件。缺失证据保持阻断，冲突一律拒绝，不会自动重新 PUT 或执行 Finalize。

核对成功后需要用户**再次明确点击恢复原任务**。恢复仍在事务内验证原任务、原图状态、凭据、素材哈希和脚本指纹，并仅让未开始的 `ready` 分片通过原服务商的只读 `assetPartUrls` 获取新 URL、继续 PUT；`uploaded` 片不会重传。随后执行一次 Finalize 和可能收费的视频生成。新增项目级 API `POST /api/v1/projects/:id/jobs/:jobId/assets/:referenceIndex/audit-chunks`，只接收原上传行版本 `expectedUpdatedAt`，不接收 ETag 或签名 URL。当前不支持没有权威只读分片查询接口的服务商自动确认未知分片。

## 上传结果未知：人工核对与恢复

如果上传阶段网络中断，素材状态会保留为 `uploading`，原生成任务处于 `failed`，**不会自动重传素材，也不会重新提交视频生成**。在「任务历史」找到失败的视频模型任务，选择「核对远端素材上传」：

1. 打开服务商控制台或对应素材查询接口，确认素材是否被接收以及真实的远端素材 ID。
2. 对结果未知的素材填写已确认的 ID，点击「确认素材 ID」（显式人工确认），或者确定服务商未接收时点击「确认未接收」。界面不自动查询远端，也不会伪造服务商的验证结论。
3. 对分片上传可先核对全部未知分片 ETag，再显式恢复剩余分片；非分片上传仍要求所有素材均为 `active` 后，才可点击「恢复原任务并允许视频生成」；将恢复 **同一个原任务**，复用已持久化的素材 ID，依照原冻结参数可能产生一次视频生成费用。

后端提供项目隔离且需要已授权会话的 API：`GET /api/v1/projects/:id/jobs/:jobId/assets`，`POST /api/v1/projects/:id/jobs/:jobId/assets/:referenceIndex/reconcile`，`POST /api/v1/projects/:id/jobs/:jobId/resume-assets`。服务端要求素材身份及上传脚本指纹匹配、行版本未改变，恢复时还核对 Job 从未进入生成提交阶段、最后失败原因仅为 prepare_failed、凭据仍有效、画布源节点及输入没有变化、没有同节点并行模型任务。这些判定都在数据库事务内完成。已提交生成、待轮询、来源改变、身份冲突、被拒绝的上传均不得通过这个入口恢复。

## 安全与兼容边界

- 脚本不能访问 `apiKey`、`process`、`require`、`eval`、`globalThis`、动态函数、对象原型或任意 Node API。通过受控 HTTP 层注入 Vault 凭据。脚本可编辑请求体，但不能跨域访问任意主机。
- 旧的视频 JavaScript `request()/poll()` 脚本不会自动转换为新 JSON 规范；必须按服务商响应格式调整模板。异步任务不能在脚本中执行循环。
- **暂不支持**完成确认后才首次产生素材 ID 的协议、结果未知分片的自动重传、复杂签名 Header 或多文件字段等专有上传协议、超过限制的大视频/音频文件、由 API Key 鉴权下载的视频内容 URL、任意 MIME 媒体、Gemini 特殊协议、脚本自定义 HTTP Header、对已运行中视频强行删除远程历史。上述能力应由后续专用适配器完成。
- 非 OpenAI 格式渠道的旧脚本尚未移除浏览器执行路径，后续继续完成迁移。测试只模拟上游 HTTP，不调用真实收费模型。

代码：`restricted-model-script.mjs`（AST 表达式解释器）、`restricted-video-adapter.mjs`（视频任务）、`restricted-video-download.mjs`（安全视频下载），附对应 `.test.mjs`。
- 对应集成测试仅使用模拟的上游模型响应，不会调用真实付费 API。

计划下一阶段：支持更多服务商专有分片协议的明确确认与对账，同时继续收敛旧浏览器脚本执行入口。
