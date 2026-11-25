# 剧集候选编辑与 AI 优化实施记录

## 范围与依赖

- P1 候选后端编辑能力：本轮实现。
- P2 人工候选编辑器：只读/编辑、保存取消、单集/整条删除、dirty guard、轮询隔离。
- P3 AI 局部优化：字段/选区、当前未保存快照、结构化输出、应用预览。
- P4 多轮与整集优化：字段选择、撤销、事件与场次关联联合校验。
- P5 采用差异与一致性：剧集差异预览、用户显式选择、上游与稳定 ID 校验。
- P6 综合验收：真实模型、浏览器、主题、并发与恢复。

AI 结果 → 应用到本地编辑缓冲区 → 保存候选 → 采用到正式草案 → 显式确认版本。前四步中的前三步不改变已确认版本或下游分镜。P1 不调用模型、不实现 UI，后续 AI 请求不得绕过本接口。

## P1 已实现合同

沿用 drama_runs.candidate JSON，无 SQLite schema 迁移。新生成候选 revision=0；旧候选缺省 0。一次实际修改或单集移除增加 revision，no-op 不增加。manualChanges 包含 originalEpisodeIds（初次修改前的候选顺序）、editedEpisodeIds（尚保留的已修改项）、removedEpisodeIds、updatedAt。冻结输入、baseline、fingerprint 不可变。

路径前缀：/api/v1/projects/:id/drama-pipeline/runs/:runId

| 方法与路径 | 输入 | 输出 |
| --- | --- | --- |
| PATCH /episodes/:episodeId | {expectedRevision, changes} | 最新完整 run |
| DELETE /episodes/:episodeId?expectedRevision=N | revision | 最新完整 run |
| DELETE ?expectedRevision=N | revision | discarded run |
| POST /adopt | {expectedRevision}（修改过的剧集候选必须提供） | 采用后的 project |

PATCH 允许 title、synopsis、ending、targetDurationSec（null 清除）、events、sourceRefs、sequences；禁止直接写 episode.id、eventItems、候选元数据和冻结输入。文本、数组、ID 与时长校验；事件文本变更由 normalizeEpisodeEvents 维护稳定 ID，未解决的关联仍须由编辑器提示处理。已有场次对象字段白名单，场次添加/拆分/合并允许现有结构化编辑器生成新场次 ID。后续 AI 联合事件/场次优化须额外处理关联重映射，不把模型生成 ID 直接当作可信标识。

候选修改/单集删除只允许 ready。至少保留一集。整条删除允许 ready/failed/interrupted/cancelled，运行中的生成必须先取消且服务端 controller 已退出。adopted 不可编辑或丢弃。整条删除为 discarded tombstone，列表过滤（在 LIMIT 前），保留原请求幂等性及原候选数据用于归档；不是物理销毁。重复删除整条记录幂等，重复生成请求不能复活记录。

采用时仍校验 frozen input 和 baseline。旧客户端可采用未手动修改的 revision=0 候选；修改后的候选缺少 expectedRevision 或版本不一致均拒绝。完整候选原有生成替换语义保持；明确由人工移除的候选 ID 如果存在于冻结 baseline，采用时恢复对应旧剧集于原候选顺序，如果是新增 ID 则不进入草案。目标生成集数不变。单集采用保留其他集。修改/删除候选不更新项目 revision、草案、确认版本或触发项目更新事件。

ZIP 兼容旧版无 revision；修改后的原始 ID 集合与当前/移除 ID 必须精确分割、顺序匹配、修订值合法，discarded 仅限 episodes。采用后仍保留历史记录。

## P2 接线注意事项

- GET list 继续只返回候选计数与摘要，包含 revision 和 manualChanges；GET detail 返回完整对象（旧候选也补 revision=0）。前端不可以数量相同判断内容相同，按 revision 和请求 epoch 拒绝迟到响应。discarded 从列表隐藏。
- 候选保存直接调用新 API，不调用 entry-draft 或画布保存屏障；采用操作仍通过项目当前 save barrier，传入已审核的候选 expectedRevision。未改动的前端目前仍可采用 revision=0，修改过的候选不能用旧采用请求绕过版本栅栏。
- dirty guard 覆盖 Tab 切换、收起候选、切换剧集、关闭；编辑缓冲不得被轮询覆盖。
- 采用差异预览尚未在 P1 实现，仍安排 P5；P2 至少明确手动移除不会直接删除已有草案集。P3/P4 AI 功能尚未实现。

## 测试

新增 server/backend/drama-episode-candidate.test.mjs，纳入 npm run test:drama-p1。覆盖隔离/稳定 ID/no-op、字段限制、revision 冲突、删除采用语义、空候选保护、运行/取消/采用状态限制、幂等 tombstone、真实 ZIP 往返与旧格式、非法归档及实际 Fastify API 授权与响应。测试使用内存 SQLite、临时 CAS、确定性生成 fixture，不调用付费模型或用户正式项目。

本计划与此前创作反馈性能 P5.2 验收分属不同任务；不改变原性能验收结论。
