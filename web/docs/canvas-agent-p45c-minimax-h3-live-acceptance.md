# P4.5c：本地 MiniMax H3 I2V 实机生成与安全恢复验收

> 日期：2026-11-15。Windows / 本地 ComfyUI 127.0.0.1:8188 / NVIDIA RTX 3080。验收用独立临时 SQLite、CAS 和 Project；不涉及在线金额结算。

## 指定 VAE 与实时编译

用户指定 `minimax_h3_video_vae_int8_convrot.safetensors`。实时 `/object_info` 已安装该 VAE、MiniMax H3 节点与所需主要模型。用户数据里的 MiniMax I2V 预设已经采用此 VAE，当前不可变版本 `7674f6028b99eac1b5da4f5bdad93832924ce0c860dbc0458f3fe3a7cf464fe4`，无需再次发布。

本轮同步修正了仓库内置 `workflows/video_minimax_h3_i2v_turbo.json`，使其 `VAELoader(105_11).vae_name` 与当前实例一致。前端专项测试同时断言模板 `requirements.modelAssets` 包含新 VAE、不含旧 `_v2` 文件名。

只读命令 `ATELIER_MINIMAX_PREFLIGHT=1 node scripts/minimax-p3c2-live-acceptance.mjs` 成功：Moss 27 个节点、MiniMax H3 27 个节点、首帧选择为 `edge`，视频捕获有效；队列为空且没有 GPU Job 提交。

## 实机 GPU 执行

使用已有 `scripts/minimax-p3c2-live-acceptance.mjs`，设置 `ATELIER_MINIMAX_LIVE=1`，新建完全隔离的验收数据根：

`H:\Temp\infinite-atelier-minimax-p3c2-1794737655250-VirL96`

原 Moss Job 生成图片并得到可信 CAS 物化；第二个 MiniMax H3 I2V Job 使用该图片 SHA-256 注入 `first_frame`。本地测试执行会话在 ComfyUI 已确认第二项生成任务之后超时，但 GPU 任务与远端 ID 仍在。**没有重新提交 /prompt**，而是使用本轮新增的专用 `minimax-p45c-recover.mjs` 从原 SQLite 及 ComfyUI 历史恢复轮询、收集与物化。

恢复命令示例（PowerShell）：

`$env:ATELIER_MINIMAX_RECOVER_ROOT = 'H:\Temp\infinite-atelier-minimax-p3c2-1794737655250-VirL96'`

`node scripts/minimax-p45c-recover.mjs`

恢复器拒绝伪造根目录或缺少原始 SQLite 的路径；检查任务、两个原始 Job、唯一提交屏障、原视频远程 ID、来源 CAS、冻结模板与用户指定的 VAE。执行中只允许对原 Job 恢复查询/收集；`submission_unknown` 或没有可信远端 ID 时停止，不重新提交。

## 实际结果

| 证据 | 实际结果 |
| --- | --- |
| Moss 图片 Job | `succeeded`，真实 CAS 和物化成功 |
| MiniMax H3 视频 Job | `succeeded`，原远端 Task ID 保留 |
| 视频格式 | MP4 / H.264 |
| 视频画面 | **448 × 448** |
| 视频时长 | **1.625 秒** |
| 视频帧数 | **39** |
| 视频大小 | **98,822 字节** |
| 视频 SHA-256 | `07675944fef9d9ee64230ab19e309b87dfc22b2926685b09c6fab02f5cb1ca4f` |
| Task | `completed`，两个 `materialize` Step 均为 `server_committed` |
| 任务提交次数 | SQLite 总计 **2 个 Job**，每个 Job **1 次 submit barrier** |
| 恢复结果 | `completed`，原 Job/远端身份未改变、未重复生成 |

恢复器重新流式计算原 CAS 视频的 SHA-256，检查 MP4/EBML 签名，并用 ffprobe 提取流参数。恢复时保存一个便于观看的独立复制品，**不会改写原 CAS**：

`H:\Temp\infinite-atelier-minimax-p3c2-1794737655250-VirL96\minimax-p45c-verified-07675944fef9.mp4`

审计 JSON：

`H:\Temp\infinite-atelier-minimax-p3c2-1794737655250-VirL96\minimax-p45c-recovery-result.json`

这些是 Windows 临时目录内的实际本地文件，不是永久资产库；需要长期保存时请移动或复制到正式资产库。

## 验收边界

- P4.5b 的自动授权已在 SQLite/HTTP 集成测试中覆盖；**本次真实 GPU 链采用逐 Step 明确审批**。因此不能将本次真机结果误称为 P4.5b 用户预授权按钮的完整浏览器真机测试。
- 验证的是 1 秒目标、实际 1.625 秒视频；长视频持续运行、音频轨、多候选图片、远程取消竞争条件、持续 GPU 负载与未知提交的人工证据对账还需专项实机验收。
- 不修改 Schema、在线计费或用户已有画布。恢复脚本只允许隔离验收数据，无法用它对任意用户生产数据库执行新 Job。

## 相关测试

`node --test scripts/minimax-p45c-recover.test.mjs server/backend/comfy-v2-adapter.test.mjs server/backend/comfy-live.test.mjs server/backend/job-coordinator.test.mjs server/backend/assistant-task-run-binding.test.mjs server/backend/canvas-materializer.test.mjs`：**150 项通过**。

`npm test`：前端 **169 个文件、1114 项通过**。TypeScript `npm run typecheck` 与 Vite 生产构建 `npm run build` 均通过；构建存在不阻断的静态/动态混合导入与较大 JS Chunk 提示。无须再次进行 GPU 推理即可跑上述回归测试。
