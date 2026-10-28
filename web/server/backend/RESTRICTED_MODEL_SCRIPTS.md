# P1 · 自定义模型脚本（后端受限执行）

OpenAI 兼容渠道的文本、无参考图文生图、JSON Base64 音频、**异步文生视频**已接入本地 SQLite JobCoordinator + Credential Vault + CAS。后端按用户填写的 HTTP(S) API 地址执行，不要求配置渠道白名单。模型脚本不是任意 JavaScript：仅解释一个经过 AST 检查的语言子集，不使用 Node.js `eval`、`new Function` 或任意动态模块。

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

## 安全与兼容边界

- 脚本不能访问 `apiKey`、`process`、`require`、`eval`、`globalThis`、动态函数、对象原型或任意 Node API。通过受控 HTTP 层注入 Vault 凭据。脚本可编辑请求体，但不能跨域访问任意主机。
- 旧的视频 JavaScript `request()/poll()` 脚本不会自动转换为新 JSON 规范；必须按服务商响应格式调整模板。异步任务不能在脚本中执行循环。
- **暂不支持**第三方远程素材 ID 上传协议、超过限制的大视频/音频文件、由 API Key 鉴权下载的视频内容 URL、任意 MIME 媒体、Gemini 特殊协议、脚本自定义 HTTP Header、对已运行中视频强行删除远程历史。上述能力应由后续专用适配器完成。
- 非 OpenAI 格式渠道的旧脚本尚未移除浏览器执行路径，后续继续完成迁移。测试只模拟上游 HTTP，不调用真实收费模型。

代码：`restricted-model-script.mjs`（AST 表达式解释器）、`restricted-video-adapter.mjs`（视频任务）、`restricted-video-download.mjs`（安全视频下载），附对应 `.test.mjs`。
- 对应集成测试仅使用模拟的上游模型响应，不会调用真实付费 API。

计划下一阶段：为需要先上传素材、再引用远程素材 ID 的模型设计可恢复的 provider-specific 资源准备适配器，之后逐步关闭剩余浏览器脚本执行入口。
