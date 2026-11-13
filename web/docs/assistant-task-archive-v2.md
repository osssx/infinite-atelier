# Task 项目归档 v2：只读历史恢复

> 2026-11-13。对应 `assistant-task-state-design.md` 的 P3「归档/导入只读」，不替换 P3c 高级执行协议。

## 格式与兼容

项目的现有 `GET /api/v1/projects/:id/archive` 导出 `manifest.version=2`；原项目图、视口、聊天、媒体和不可变 Comfy 模板保留。额外包含 `assistantTasks:{format:1,tasks:[...]}`。每项包含 Task、Steps、Attempts、Events、跨聊天关联、命令摘要、模型调用摘要和 Run Sequence 历史。Task 持有的 CAS 引用也计入媒体备份和完整性核验。

`POST /api/v1/projects/import-archive` 同时接受旧 `version=1`（不恢复 Task，也不臆造步骤完成事实）和新 `version=2`。对 Task 数量、步骤/事件数、身份、步骤依赖与 JSON 数据进行导入前校验；沿用项目 ZIP 5 MiB Manifest、128 文件、2 GiB 流式媒体上限。

## 安全与恢复语义

- **从不恢复可执行权限**：所有导入的 Task 强制 `read_only=1`；新建本地 Task/Step/Attempt ID，清空 `active_step_id` 和租约。步骤的历史状态与可信回执仅作查看，不代表本机验证过上游执行。
- **外部身份只作历史**：原 `execution_key`、`external_id`、`submit_marker`、冻结快照和证据记录在导入 Attempt 的审计数据中；导入 Attempt 为 `archived`，`external_kind/external_id/submit_marker` 均为 NULL。不会创建或关联 Job、Skill Run、Comfy 执行或新的 Provider 请求。
- **命令与长流程不激活**：旧命令摘要、模型 Call 和 Run Sequence 转为只读审计 Event；不导入到 `assistant_task_commands`、`assistant_model_calls`、`assistant_task_run_sequences` 等可参与执行的表。聊天关联仍可查询，但只读 Task 不可继续、取消或重新规划。
- **读与对账分离**：外部 Job 恢复扫描与手动对账明确跳过 `read_only` Task。Task 面板隐藏继续和结束记录按钮并显示「只读归档」。
- **事务性**：模板版本安装沿用现有行为；在一次 SQLite 事务里新建项目、画布状态和 Task 历史。如果创建 Task 历史失败，项目/Task 插入全部回滚。媒体先按 SHA-256 完整性验证并写入 CAS。

## 刻意不覆盖的能力

不把导入历史作为可继续执行的 Plan，不恢复外部模型/Job 的收费执行身份，不在导入时自动重试物化，不改变旧项目的当前画布生成流程。历史外部资源 ID 仅能在审计事件中查看。若未来需要重新执行，应在本机创建新 Task、新 Plan 并重新审批。

## 验证

```bash
cd web
node --test server/backend/assistant-task-archive.test.mjs server/backend/project-archive.test.mjs
node --test server/backend/assistant-task-external-jobs.test.mjs
npx vitest run src/features/canvas-assistant/canvas-assistant-task-state.test.tsx
npx tsc --noEmit
```

覆盖 v1→v2 兼容、完整 Task/Step/Attempt/Event 往返、Job ID 不关联、只读状态、原子回滚、篡改依赖拒绝、重启与手动对账只读保护、前端入口禁用、大视频流式回归。
