# P4.9d：在线文本模型未知回执的安全分层诊断

> 2026-11-16，基线提交：`7dea9f8`。范围：在线文本 Provider 的服务端 Task 模型调用审计与隔离回归；**不重发 P4.9c 那次结果未知的请求**。本阶段未调用真实付费模型，不改变 SQLite Schema、正式画布、已有数据集或 Job 调度。

## 问题与可信事实

P4.9c 真实使用已配置的 Cline / `cline-pass/deepseek-v4.1-flash-1017`：第 1 轮 3 张角色卡返回成功；第 2 轮场景模型调用记录 `needs_reconcile`，HTTP Task API 返回 `assistant_model_call_unknown`，原脚本已停止后续轮次。此前的内存 SQLite 已销毁，运行报告只有 `needs_reconcile` 及有限的调用状态；**无法事后确定第 2 次是 HTTP 5xx、超时、传输断开还是其他未知结果，更不能推断上游是否收费或已完成**。

`assistant-chat.mjs` 原来把“有上游 HTTP 响应”“读取正文失败”“请求发送阶段异常”等经同一个安全栅栏统一判定为 `needs_reconcile`。正确的幂等性需要保留，但错误码范围过宽，不便分析新发生的真实请求。

## P4.9d 变更

1. `assistant-model-call-diagnostics.mjs` 新增静态有限类别：`http_server_error`、`http_request_timeout`、`http_rate_limited`、`http_auth_rejected`、`http_client_rejected`、`deadline_expired`、`transport_timeout`、`transport_disconnected`、`dns_resolution_failure`、`dns_policy_rejected`、`tls_certificate_rejected`、`response_parse_invalid`、`response_body_timeout`、`response_incomplete` 等。附带 **观察阶段**（`await_response` / `read_response`）与可确认的 HTTP 状态码（否则 null）。
2. 只读取异常的 `code` / 有界 `cause.code` 作为分类依据。**不保存、输出或重新包装异常 `message`、URL、Header、完整请求、Provider 响应、鉴权令牌或内层异常对象**。
3. `createAssistantChatService` 每次被审计的 Provider POST 出错时，在现有 `callObserver.failure` 中提交额外安全 `diagnostic`。原 `assistant_model_calls.status`、`error_code`、提交标记与 Task 幂等逻辑**完全不变**。即使能确认 HTTP 503，也不能由此证明上游未接受请求；`needs_reconcile` 一律不得重试。
4. `createAssistantModelObserver` 在**同一 SQLite 事务**内将受白名单验证的诊断写入已有 `assistant_task_events` 的 `model_call_failed` / `model_call_needs_reconcile` 事件。无新表/字段，不迁移旧数据库；历史事件没有新诊断时该字段缺失，**不能回填猜测**。
5. 现有项目级 `GET /api/v1/projects/:id/assistant/tasks/:taskId/model-calls` 在已授权 Task 下可返回每次模型调用对应的只读 `diagnostic` 对象。按当前页面的调用 ID 集合有界查找事件，拒绝无效/陌生字段；不扩张项目间访问权限。
6. `scripts/p49b-creative-quality.mjs` 的后续隔离验收报告会包含安全诊断及耗时，不改变模拟/真实模式的明确授权、限量 POST、人工复核、Canvas 只读语义。此前 P4.9c 报告不会因本次代码升级自动增加原因。

示例（**模拟的** HTTP 503 分类，不是 P4.9c 真实故障记录）：

```json
{
  "status": "needs_reconcile",
  "errorCode": "assistant_upstream_error",
  "diagnostic": {
    "version": 1,
    "category": "http_server_error",
    "phase": "read_response",
    "httpStatus": 503
  }
}
```

错误类别代表**已观察的链路症状**，不代表模型实际推理进度、是否扣费或可以重发。不能把 `http_rate_limited`、本地异常或静态文本校验升级为 Task 成功或失败终态。

## 测试与验收

- `assistant-model-call-diagnostics.test.mjs`：纯分类器，校验白名单输出、嵌套传输异常、密码/URL/私有正文不泄露。
- `assistant-model-call-diagnostics-http.test.mjs`：真实 Fastify + 内存 SQLite 的 Task 模型请求与审计查询，模拟 503、408、429、401、422、200 非法 JSON、空响应、截断、连接断开、DNS 失败、读取正文超时以及真实 `AbortSignal.timeout`。
- 用例同时检查：持久事件与 API 返回诊断相同、`failed` / `needs_reconcile` 状态未改变、不重复提交同一命令、报告中没有测试凭据与未经授权的画布正文。
- 既有模型调用、Task 恢复、创作连续性、HTTP 入口及前端专项回归保持通过后才能提交。

## 剩余边界与下一步

- 当上游从未返回响应、进程崩溃或网络发生异常时，诊断可以指明观察位置，却**不能证明对方是否接收或完成**；需要上游提供稳定的请求 ID/任务查询接口，才可能进行真正的远端对账。
- 现有 P4.9c 第 2 次调用的唯一可信状态仍是 `needs_reconcile`，不自动补发、不借新诊断推断旧故障，也不去修改用户的渠道密钥/账单。
- 后续若要真实验收 3 场景 + 6 分镜 + 修订分镜，应使用新的隔离 Task、独立请求 ID，并再次明确授权在线模型可能发生的费用。金额硬上限、长视频、并发负载继续延期。
