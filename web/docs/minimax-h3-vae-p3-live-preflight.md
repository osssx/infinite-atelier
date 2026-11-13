# P3 实机工作流预检与 MiniMax H3 VAE 适配

日期：2026-11-13。此轮使用 **现有真实 ComfyUI 的只读工作流信息**，未提交付费 /prompt、未产生新的生成 Job，也未将本轮标为真实视频生成验收完成。

## 现场发现

- 运行中 ComfyUI 位于 `http://127.0.0.1:8188`，查询时队列运行/等待均为零。
- 后端通过 `web/.env` 中既有 `ATELIER_DATA_DIR` 解析用户数据位置为 `E:\CanvasData`；不假设默认 `LOCALAPPDATA` 目录。
- Moss Image 文生图与 MiniMax H3 I2V Turbo 使用最新注册的 **预设 ID + revision**，不是旧版名称或 `video-minimax-h3-fl2v-turbo` 硬编码模板 ID。
- 当前 MiniMax H3 模板中存在 `VAELoader(105_11).vae_name=minimax_h3_video_vae_int8_convrot_v2.safetensors`，但真实 ComfyUI `/object_info` 不包含该名称；可用列表包含用户明确指定的 `minimax_h3_video_vae_int8_convrot.safetensors`，还存在 FP16 版本。
- 模板的 `requirements.modelAssets` 也引用了旧 VAE；**仅修改图节点字段、不同步模型资源声明是错误的**。模板新修订必须同时更新图及此声明，并重新计算不可变的内容 SHA-256。

## 已执行的变更

在用户明确指定使用 `minimax_h3_video_vae_int8_convrot.safetensors` 后，执行：

```sh
cd web
node scripts/minimax-h3-vae-update.mjs
node scripts/minimax-h3-vae-update.mjs --apply
```

脚本默认只读：验证数据预设、真实 ComfyUI VAE 选项、27 节点编译、首帧连线和视频捕获；**只有 `--apply` 才通过正式 Comfy Registry API 发布不可变新工作流版本并在事务中将当前预设重绑**。不直改旧模板文件和旧记录、不发起 ComfyUI 生成；重复执行在新版已生效时只报告已配置。

实际版本：

- 工作流：`video-minimax-h3-i2v-turbo`，预设名称「MiniMax H3 I2V Turbo · 图生视频」。
- 旧版本：`06efd5a2350b110872e3efc7038232651b86195eeb1fe1023c7c557f7a966815`，保留供审核或回滚。
- 新版本：`7674f6028b99eac1b5da4f5bdad93832924ce0c860dbc0458f3fe3a7cf464fe4`，当前预设已绑定。
- 旧版本当前没有项目节点、Task/Job 或默认绑定引用；无须修改任何用户画布和计划。
- 验证重新查询时，新模板 `VAELoader` 和 `requirements.modelAssets` 均指向新 VAE，原版本仍保留原值。

## 无生成预检

```sh
cd web
# Windows PowerShell
$env:ATELIER_MINIMAX_PREFLIGHT='1'
node scripts/minimax-p3c2-live-acceptance.mjs
```

预检读取真实配置及实时 `/object_info`、`/queue`，编译 Moss → CAS 图片来源 → MiniMax first_frame → Video 捕获，**没有修改用户现有项目和数据库，也不会调用付费 /prompt**。

输出：`MINIMAX_P3C2_PREFLIGHT_ONLY_PASS`；Moss 27 节点、MiniMax 27 节点，可信首帧映射和视频捕获配置均有效。该结果**只能证明请求可编译及环境选项一致**，不能证明 VAE 推理稳定、远端生成完成、产物 CAS 落图或崩溃后真实对账。

真实生成脚本仍需用户单独明确启用 `ATELIER_MINIMAX_LIVE=1`，并且内部仍先冻结 Step、逐次审批和幂等入队。由于这里未获新一轮付费生成授权，**本轮不执行真实媒体生成**。

## 后续验收建议

在用户确认可提交新媒体生成任务后，以独立测试数据根进行一次真实运行，然后跨聊天会话、重启、故障恢复、物化后再对账；监控原始 Job ID、Artifact/CAS 内容指纹、已提交的 Step/Attempt 数量，并确保无额外付费 POST。对 `submission_unknown` / 超时一律停在待对账，不重复生成。
