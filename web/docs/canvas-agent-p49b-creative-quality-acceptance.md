# P4.9b：多轮文本创作一致性隔离验收

> 2026-11-16 · 基线 5ad5409 · 分支 custom。**已通过 Mock Provider 的 Task / Fastify / SQLite 四轮隔离验收；尚未调用真实文本 Provider，也未开展人工语义评分。** 不涉及用户既有画布、数据库迁移或 GPU 生成。

## 固定用例

验收集 rabbit-short-animation-v1：儿童动画《小兔嘟嘟的星星》；小兔嘟嘟为雪白毛色、蓝色斗篷、好奇乐观；兔妈妈米白毛色、棕色围裙、温柔耐心；小龟慢慢为橄榄绿龟壳、沉稳细致的小兔朋友。场景路线为晨光森林小径发现星星 → 暴雨石桥救助迷路小动物 → 观星草地团聚。

用户确认目标和三个持续约束保存在隔离 Task 语义状态（user_confirmed），不把模型的历史草案当作用户确认事实。连续四轮分别生成 3 份角色卡、3 份场景、6 份分镜和 6 份雨天修订分镜，共 18 份创作文本草案；第三轮重新关联另一个 Chat Session，模拟跨会话继续，不冒称已执行真实 Chrome 刷新。

## 实施

- web/server/backend/assistant-creative-consistency.mjs：版本化故事案例、可疑服饰与人物关系漂移提示、角色/场景/数量/占位内容的客观检测；保留每张卡片的有限文本及摘要。
- web/scripts/p49b-creative-quality.mjs：真实 createAssistantTask、appendAssistantTaskTurn、changeAssistantTaskSemantic、createAssistantChatService、buildApp 与 Fastify app.inject；使用内存 SQLite，模型响应默认 Mock。没有 Graph Commit、Job、物化或 ComfyUI 调用。
- 每轮实际模型请求前复核：包含用户确认目标及三条约束、不包含未授权私有画布正文；第 2–4 轮还必须携带历史 AI 草案并明确它是未确认内容。报告只保存这些布尔证据，不持久化完整发送请求。
- 每一轮的 HTTP 推理记录真实 model_call 审计，单轮最多一次 format_repair；整轮最多 8 次上游请求。服务端原有未知结果对账、一次性请求 ID 和批准/执行栅栏仍生效。
- 人工复核七个维度：人物身份、外貌、人物关系、场景连续性、事件时序、镜头语言及修订后保留事实。全部默认 pending。自动关键字匹配**从不判定语义质量通过**；疑似漂移需要人工查看语境（包括“不要穿红色斗篷”一类否定句）。

## 运行

模拟 Provider（完全离线、不收费）：

    cd web
    node scripts/p49b-creative-quality.mjs --mock

报告写到操作系统 Temp 子目录下的 p49b-quality-report.json；包含四轮文本、事实覆盖、疑似问题、Call 审计和人工待审字段。默认不写仓库文件。

真实 Provider 受控入口（本轮未运行）：

    node scripts/p49b-creative-quality.mjs --live --ack-cost

真实调用需在**当前进程环境中**临时设置 P49B_API_KEY、P49B_BASE_URL、P49B_MODEL；仅支持 OpenAI-compatible Chat Completions，采用原项目的 DNS pinned HTTP 客户端。**不读取既有 DPAPI 渠道密钥、不访问既有用户数据集、不会向正式画布写入**。必须同时传入 --live 和 --ack-cost，否则拒绝。最长 4 轮、最多 8 次上游 POST、每次最多 90 秒，不能把这个请求数量上限冒充金额级硬上限。任何未知回执都不自动重发；显式用户控制的密钥不可进入 Git 或报告。

## 已有验收证据

2026-11-16 对 http://127.0.0.1:8788 的 /health、/api/v1/session 与 /api/v1/channels 做只读查询，应用后端均不可用，因此没有可访问的已配置真实文本渠道，本轮没有付费模型调用。

隔离 Mock：4 次模型 POST 和 4 条持久调用记录、4 个用户 Turn、2 个关联 Chat Session、18 份文本动作；每轮所有固定确认事实均被传入上下文，第 2–4 轮保留先前 AI 草案；未经授权的私有画布内容无泄漏。四轮客观检查通过；人工语义复核仍全部 pending。Graph revision=1 保持不变、只有 1 个原有测试节点，Jobs=0。

相关测试包含故意的内容缺失、角色外观漂移、凭据遮蔽、未明确授权的实机模式拒绝、任务连续性、报告可复读与 Graph 不变检查。

## 未完成范围

尚未取得真实文本 Provider 的创作结果，不能宣称角色/剧情语义质量达标；没有进行真实 Chrome 刷新、多 Provider 对比、GPU 模型中断、长视频或并发负载测试。下一阶段在渠道可用且明确指定模型后执行隔离实机和人工复核；对模型文本的人工评分**不参与 Task 完成授权**。费用硬上限、长视频和负载测试按用户安排继续延期。
