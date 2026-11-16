# P4.9c：复用已配置在线渠道的真实角色卡验收

> 2026-11-16，基线 `3d67b18`。阶段结论：**真实在线 Provider 已接通，第一轮三张角色卡返回成功；第二轮提交结果未知，已按幂等安全栅栏停止。四轮连续叙事质量未完成验收。** 不应写成全部通过。

## 1. 纠正环境判断

早期只查询了 Infinite Atelier 默认后端端口 8788、Ollama 11434、LM Studio 1234 及常见 OpenAI-compatible 8080；当时未运行。用户指出已配置可用**在线文本模型渠道**后，通过正式用户数据集的**只读 SQLite 查询**确认 UI 当前文本模型选择为 Cline 的 `cline-pass/deepseek-v4.1-flash-1017`，渠道元数据与加密密钥版本均有效。

新增 `web/scripts/p49c-configured-channel-live.mjs`：

- `--probe`：使用 `DatabaseSync({readOnly:true})` 读取用户默认数据目录中的 `ui_settings.model_config` 与 `channels` 元数据，**不解密密钥、不调用模型**。
- 从 `textModel` 中解析用户实际选择的渠道 ID 与模型，要求和 UI 渠道 ID、后端渠道 ID、名称及 Provider 严格匹配；仅支持 HTTPS OpenAI-compatible 在线文本渠道，拒绝本地 HTTP URL、无有效凭据或模糊多渠道。
- `--run --ack-cost`：仅经明确参数确认后，创建项目现有的 `createCredentialVault` 与 Windows CurrentUser DPAPI 保护器，通过只读数据库验证/解密既有凭据。凭据**只在现有 Vault 回调与模型请求头内临时使用**；不输出或保存 API Key，不改动渠道配置或正式 SQLite。
- 复用 P4.9b 的**独立内存 SQLite Task/Prompt/Model Call 审计**。四轮上限、最多 8 次模型上游 POST、无自动网络重试；未知远端结果停止后续任务。原画布不写入、不创建媒体 Job，金额硬上限未实现。

只读预检：

    cd web
    node scripts/p49c-configured-channel-live.mjs --probe

真实受控执行（本阶段已执行一次，**请不要因第二轮未知而自动重跑**）：

    node scripts/p49c-configured-channel-live.mjs --run --ack-cost

## 2. 实机结果（不是四轮全部通过）

模型：`cline-pass/deepseek-v4.1-flash-1017`，现有 Cline 在线渠道。

| 阶段 | 实际结果 | 可信证据 |
| --- | --- | --- |
| 角色卡 | **HTTP 200，3 张角色卡成功** | Model Call `succeeded`；3 张正文不为空，客观数量、标题、人物锚点均通过；未发现自动漂移标记 |
| 场景设定 | **HTTP 409，提交结果未知** | Model Call `needs_reconcile`；错误码 `assistant_model_call_unknown`；不可推断实际渠道端是否处理成功 |
| 六分镜 | **未执行** | 第二轮结果未知，未自动继续 |
| 修订分镜 | **未执行** | 第二轮结果未知，未自动继续 |

**本次上游请求总数：2 次。** 不知道在线渠道实际收费金额，不能承诺金额封顶。根据 `assistant-chat.mjs` 原有保护，远端响应未确认、HTTP 5xx、超时等均可能令调用进入 `needs_reconcile`，本轮缺乏可证明的 HTTP 原因，**不猜测具体故障归因**，亦不自动重发第二轮。失败报告保留完整安全审计状态和经确认的第一轮草案；隔离 Graph revision 保持 1，正式项目、用户画布未被写入。

### 第一轮文本人工初读

三张角色卡各约 350 字，呈现外貌、服饰、性格、人物关系、行为习惯及绘图描述，和固定人物事实一致：

- 小兔嘟嘟：雪白毛色、蓝色斗篷、好奇乐观。
- 兔妈妈：米白毛色、棕色围裙、温柔耐心，鼓励主角。
- 小龟慢慢：橄榄绿色龟壳、沉稳细致，是小兔的冒险伙伴。

模型补充了眼睛颜色、配饰、兔子的性别/亲子细节等**并非用户固定事实**的创意设定；后续复核前仅算未确认草案。对角色卡可作初步“未见明显人物锚点矛盾”的判断，**不能推及未完成的场景连续性、分镜时序与剧情修订**。

## 3. 报告与人工复核

- 新增的 `p49c-human-review.mjs` 对原模型报告做 SHA-256 证据绑定，允许为人物身份/外貌/关系、场景/事件、镜头语言和修订事实填写人工评分与解释，**审核独立于 Task 批准/完成验证**。
- 每份报告的审核模板初始化默认全为 `pending`，真实调用报告也已验证生成 `draft` 模板。即使人工把 Mock 结果全部标为通过，也只能产生 `mock_review_only`；不完整的真实调用结论必须保持 `incomplete_provider_evidence`。
- 对过长正文保留最多 8000 字并记录 `truncated`；如果存在截断，即使填写正面评分也会返回 `source_excerpt_incomplete`，禁止把片段当完整证据。
- 被篡改的原报告/卡片摘要、缺少理由的差评或异常豁免均不能通过验证。审核文件只位于本地 Temp 目录，模型输出和密钥不纳入 Git。
- P4.9b 运行器新增安全诊断字段：每个持久模型 Call 的状态、经过筛选的 `assistant_*` 错误码和耗时，便于**以后新的、显式授权的测试**排查。此增强是在本次未知回执出现后添加，无法逆向补出已经销毁的内存 SQLite 详细错误，不把它说成当前故障证据。

使用示例：

    node scripts/p49c-human-review.mjs --init <报告JSON路径>
    node scripts/p49c-human-review.mjs --verify <报告JSON路径> <审核JSON路径>

## 4. 风险与下一步

下一阶段优先对 `needs_reconcile` 的原因做安全诊断：区分远端 5xx、请求等待超时、DNS/传输故障与格式拒绝，不对**本次**未知任务自动重发；保留首轮成功的内容和人工复核证据。后续真实四轮质量测试只能在新的受控 Task/请求 ID 和新的费用授权下开展。金额级费用硬上限、长视频和负载测试继续按用户选择延期。
