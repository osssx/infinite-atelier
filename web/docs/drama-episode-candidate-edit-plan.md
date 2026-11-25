# 剧集候选编辑与 AI 优化实施记录

## 范围与依赖

- P1 候选后端编辑能力：已完成（da07157）。
- P2 人工候选编辑器：已实现只读/编辑、保存取消、单集/整条删除、dirty guard、轮询隔离及采用版本接线。
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

## P2 实施记录

- 生成候选 Tab 的展开记录使用候选目录和当前单集详情；仅展开的 run 挂载编辑器，每个 run 只挂载选中集的完整字段区。复用 DramaEpisodeFields、EpisodeReadEditField、SequenceReadEditFields、DramaEditActions 及 DramaFeedback。保持深浅主题一致，不把完整候选编辑器挂到轻量画布卡片。
- 采用字段级编辑缓冲：铅笔进入编辑模式，保存候选时 PATCH 当前字段，取消不写入；场次新增/拆分/合并/删除为显式结构操作。字段保存事件文本仅发送 events，服务端返回稳定身份及关联，不传入前端临时 eventItems；时长清除使用 null。集级原文引用保留并显示数量，不新增裸 GUID 编辑输入；场次详情复用既有来源和事件关联编辑器。
- 单次仅开放一个字段编辑，阻止换集、收起记录、采用及其他候选编辑；Tab 切换与关闭使用 workspace pending 注册，保存失败保留原输入。删除单集、整条 run 均二次确认，删除确认期间禁止采用当前 run。已采用记录只读，最后一集移除禁用。
- GET list 按 candidate revision 而非集数缓存详情；编辑期间保留活跃 run 快照，服务端 CAS 拒绝远端冲突。变更、采用及编辑状态切换增加读取 epoch；变更前的迟到请求不能复活记录或覆盖修改。更高 revision 的摘要使详情失效，展开 run 自动按需读取；可主动刷新。生成重试中的取消仍允许轮询。
- 采用通过既有 project save barrier 传入 expectedRevision（含旧版 0）。手动删除提示采用时保留已有正式草案内容；详细采用差异仍属于 P5。
- P3 AI 直接接入同一局部字段的当前 draft 缓冲与 CandidateFieldContext，AI 预览/应用不调用 PATCH，只有保存候选时才持久化。P3 尚未实施。

P2 前端回归：30 文件、225/225 通过（含新增 3 个状态缓存测试、7 个候选交互测试），npm run typecheck 通过；旧版 tooltip 和只读 article 断言已按新布局更新，重试/取消行为保持。真实 Chrome fixture 脚本扩展候选编辑、关闭恢复、删除与采用验证，使用确定性模型，无付费调用。首次浏览器测试需明确选择完整剧集范围，不能假定从画布第一集打开后默认是全部。

真实 Chrome + 隔离后端验收：scripts/drama-feedback-chrome-e2e.py 62/62 检查通过，浏览器异常 0、在线模型请求 0。候选编辑和单集删除后项目 revision、dramaDraft、dramaConfirmed 均保持；关闭重开读取已保存候选；采用后保留被排除原剧集与确认版本；第二次生成记录整条删除成功，关闭后无 runs 轮询。仅确定性 fixture 验证，在线 AI 优化仍待 P3/P6。

## 测试

新增 server/backend/drama-episode-candidate.test.mjs，纳入 npm run test:drama-p1。覆盖隔离/稳定 ID/no-op、字段限制、revision 冲突、删除采用语义、空候选保护、运行/取消/采用状态限制、幂等 tombstone、真实 ZIP 往返与旧格式、非法归档及实际 Fastify API 授权与响应。测试使用内存 SQLite、临时 CAS、确定性生成 fixture，不调用付费模型或用户正式项目。

本计划与此前创作反馈性能 P5.2 验收分属不同任务；不改变原性能验收结论。
