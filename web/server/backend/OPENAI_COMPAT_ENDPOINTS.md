# 自定义 OpenAI 兼容 API · 本地后端执行

支持第三方 OpenAI-compatible 图片生成/编辑、文本问答（含 SSE）与语音生成。**不需要单独设置地址白名单，也不需要 `ATELIER_OPENAI_COMPAT_ENDPOINTS` 环境变量。**

在「配置与用户偏好 → 模型渠道」中选择 OpenAI 协议，直接填写 API 基础地址、模型和 API Key。可以是：
- 远程 `https://models.example.net/v1`、`https://models.example.net:8443/custom/v1`；
- 本机代理 `http://127.0.0.1:8188/v1` 或 `http://localhost:8000/v1`；
- 显式局域网 IP 地址 `http://192.168.1.23:8080/v1`。

后台使用 SQLite JobCoordinator，密钥经现有 DPAPI Credential Vault 封存。每个 JobSnapshot 固定**当次渠道 URL + 密钥版本引用**，切换渠道 URL 不会改变已经排队的任务，也不会把密钥放进快照。前端保存之前会校验协议和 URL，后端在消费任务时再次校验。

## 安全约束

- 支持用户配置的 HTTP(S) 地址，而不提供按渠道名称维护的白名单。远程使用 HTTPS 更安全；HTTP 会明文传输 API Key，请仅在可信本机/局域网使用。
- 禁止将 URL 用户名/密码、查询串或 fragment 传入模型地址，拒绝非 HTTP(S)、已知云元数据服务和链路本地/保留 IP。
- 远程 DNS 域名解析时只连接通过公网 IPv4 检查的地址，以防域名重绑定指向内部网络；局域网地址应使用显式局域网 IP。HTTP 重定向不会自动跟随，以防 Bearer token 被转发到其他服务。
- 没有成功启用的后端/凭据时直接报错，绝不自动回退到浏览器付费请求。
- 这个 API 不是任意 HTTP 转发器：依然只支持既有适配器定义的 `/images/generations`、`/images/edits`、`/chat/completions`、`/audio/speech` 协议；特定服务返回 URL 而不是 base64 图片、使用非标准流格式时，仍需要独立兼容适配。
- 官方 OpenAI 视频、其他自定义视频协议、Gemini 和任意 JS 模型脚本不属于本次接入范围；尚未迁移的辅助功能可能仍依赖浏览器密钥副本，不能直接删除旧存储。

回归测试使用模拟上游，不会发起真实付费请求。
