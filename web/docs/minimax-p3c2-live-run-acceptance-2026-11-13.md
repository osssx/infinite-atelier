# P3c2 真机运行验收：Moss → MiniMax H3 I2V

日期：2026-11-13。分支：`custom`。前置：`72eaf4a` 修复并登记的 MiniMax H3 VAE 工作流版本 `7674f6028b99eac1b5da4f5bdad93832924ce0c860dbc0458f3fe3a7cf464fe4`。

## 已实际生成并通过

在执行前，确认 `http://127.0.0.1:8188/queue` 无运行/等待任务；ComfyUI `/object_info` 与最新 Moss/MiniMax 预设编译通过。用户本轮要求继续执行实际验收，使用此前已有 **显式 `ATELIER_MINIMAX_LIVE=1`** 的隔离验收脚本运行，仅提交下述两项生成：

- Moss Image 文生图：独立 Task Step 审批后入队一次，回执 Job `19c04da7-c83f-425c-bdc4-1728063865a4`，上游 Prompt ID `95e555f4-229e-4716-b394-37f460e6a42f`；产物为 **PNG 433,289 字节**。
- 服务端先验证 Moss 图片 CAS SHA-256，生成并提交 `canvas_mutation` 审批与可信接线，将 `moss-image-source.image` 连接到 `minimax-i2v-workflow.first_frame`。没有让模型文本或未经证实的节点引用成为媒体来源。
- MiniMax H3 I2V：审批后仅入队一次，Job `ae959571-8b98-4213-9278-308cf3399e8f`，上游 Prompt ID `57a8e511-7dbd-4a8c-acf0-169055244781`；产物为 **MP4 99,032 字节**。实际 `ffprobe` 显示 H.264，448×448、约 1.625 秒、39 帧（输入请求时长为 1 秒）。
- Task `8fe13cd6-6e48-492f-9044-7c0cc4215f5a` 的状态为 `completed`；Run Sequence 也为 `completed`。整个 Task **5 个 Step 成功并具有 `server_committed` 回执，3 个 Attempt（两次 Job 加一次画布），2 个实际 Job**。重复调用两个 Step 的入队接口分别返回原 Job ID，没有第三个生成。
- 视频先落入隔离目录的 CAS，文件格式、内容哈希与 `artifacts` / `blobs` / `materializations` 三类记录相符；物化节点 `artifact-8017bfb3-213a-4181-b9b8-3d766d88881c` 存在于画布。

验收数据根（**临时目录，不是用户真实生产画布**）：

```text
H:\Temp\infinite-atelier-minimax-p3c2-1794582059412-TEsJQK
```

报告：`minimax-p3c2-acceptance-result.json`。视频 CAS 文件（可能随系统临时文件清理而丢失）：

```text
H:\Temp\infinite-atelier-minimax-p3c2-1794582059412-TEsJQK\blobs\96\9635cfc15e95c3a6496c381579f1407e504305bc076c59de633072d2cb16129d
```

用户实际数据根 `E:\CanvasData` 未被这次生成脚本作为 Job 写入目标。

## 生成后独立审计与恢复测试

新增两个**不调用 ComfyUI** 的可重复脚本，命令均在 `web` 目录执行：

```powershell
node scripts/minimax-p3c2-postflight-audit.mjs --root "H:\Temp\infinite-atelier-minimax-p3c2-1794582059412-TEsJQK"
node scripts/minimax-p3c2-offline-recovery-check.mjs --root "H:\Temp\infinite-atelier-minimax-p3c2-1794582059412-TEsJQK"
```

1. `postflight-audit` 只读打开实际生成数据库，流式计算 PNG/MP4 的 SHA-256，与 CAS、mime/签名、物化节点核对；验证两个上游 Job ID 和四个“首次入队/重复入队”请求的回执配对；再次从独立 SQLite 连接读取原状态。结果：`MINIMAX_P3C2_READ_ONLY_POSTFLIGHT_PASS`。
2. `offline-recovery-check` 使用 SQLite backup 生成一个临时副本，在**没有媒体 Provider/Worker** 的测试 HTTP App 上执行 Task 启动恢复、链接第二聊天会话、两次对账、读取 Task/Run Sequence；销毁 App、重开 SQLite 后重复验证。两轮均保持 `completed`、2 Job、3 Attempt，第二聊天能查到原 Task。校验原数据库关键表数据未变化，最终删除测试副本。结果：`MINIMAX_P3C2_OFFLINE_CLONE_RECOVERY_PASS`。

## 边界与风险

**已证实**：真正的 Moss→MiniMax 工作流运行、可信图片绑定、服务端回执、视频 CAS 落图、重复提交防护、Task/Run Sequence 终态、独立只读验证、真实 DB 克隆恢复与跨 Chat 任务列表。

**尚未证实**：在用户正在运行的正式 App 上重启后端并直接从新聊天继续执行。尝试现场 HTTP 重启验收时受当前工具安全约束，因此没有绕过其限制，也没有修改正式 App 的会话授权或执行第三次付费生成。克隆环境恢复测试不能替代正式 App 重启测试。

未来如需在正式画布上验证，优先由用户控制 App 重启与任务会话；从已有 Job ID 恢复、只读对账，**绝不可重新提交** `/prompt` 或以新 request ID 自动重跑任何付费媒体任务。

## 可重复命令

无付费预检：`ATELIER_MINIMAX_PREFLIGHT=1 node scripts/minimax-p3c2-live-acceptance.mjs`。本次已经生成成功，不要为复查报告再次运行 `ATELIER_MINIMAX_LIVE=1`；应使用上述两个离线审计脚本。

## 收尾补验：2026-11-14（实际后端 HTTP 启停）

用户要求继续收尾。本轮确认正式后端和 ComfyUI 均未运行，因此**没有重启用户正式应用，也没有新的媒体生成**。现有验收结果的独立数据根仍可读取，两个 Job 仍处于 `succeeded`。

新增 `web/scripts/minimax-p3c2-server-restart-check.mjs`，采用以下测试方式：

1. 将成功生成的 SQLite 使用 `node:sqlite` 一致性备份到临时数据目录，复制仅需的 CAS 和工作流文件。生成独立数据集身份和临时 activation registry；**不会把原数据集身份或生产锁复制过来**。
2. 在克隆目录调用真正的 `createLocalBackend`，禁用 `autoDispatch`、不提供任何 ComfyUI/模型 Provider 或 Coordinator。Fastify 以本机临时端口监听，调用实际 HTTP、会话 Cookie 和 CSRF 接口。
3. 第一次启动：通过 HTTP 将已完成 Task 关联到新的聊天会话；从该聊天列出原 Task，读取 Run Sequence 图片和视频输出，并重复执行两次安全对账。
4. 完整关闭后端，再次在**同一个克隆数据根**启动后端：新聊天仍能查询完成的 Task，Run Sequence 仍为 `completed`，2 Job、3 Attempt、2 Artifact、2 已物化产物完全不变。最后再次验证原始验收 SQLite 中任务、Job、Attempt、ChatLink 全未改变，销毁临时克隆。

```powershell
cd web
node scripts/minimax-p3c2-server-restart-check.mjs --root "H:\Temp\infinite-atelier-minimax-p3c2-1794582059412-TEsJQK"
```

结果：`MINIMAX_P3C2_REAL_HTTP_BACKEND_RESTART_CLONE_PASS`；**2 次后端启动/关闭、2 次真实 HTTP 会话验收、0 次付费生成、0 个新增 Job**。

新脚本与之前的 `offline-recovery-check` 不同，验证了实际后端装配、数据库启动恢复、HTTP 路由、会话授权与实例锁；但它仍是**隔离副本**，不能冒充正式生产后端重启。正式后端当前离线，需待用户主动启动正式应用，再检查其自身 Task/Chat；无需再次向 MiniMax 提交生成。
