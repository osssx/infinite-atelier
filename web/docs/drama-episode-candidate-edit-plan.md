# 剧集候选编辑与 AI 优化实施记录

## 范围与依赖

- P1 候选后端编辑能力：已完成（da07157）。
- P2 人工候选编辑器：已完成（6807efe），只读/编辑、保存取消、单集/整条删除、dirty guard、轮询隔离及采用版本接线。
- P3 AI 局部优化：已完成字段/选区、当前未保存快照、结构化输出、应用预览与重新优化。
- P4 多轮与整集优化：已实现最近五轮已应用意见、撤销、整集字段选择、手动微调、一次原子保存与事件场次联合校验。
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
- 采用差异预览尚未在 P1 实现，仍安排 P5；P2 至少明确手动移除不会直接删除已有草案集。AI 局部优化由 P3 接入；整集及联合优化仍属于 P4。

## P2 实施记录

- 生成候选 Tab 的展开记录使用候选目录和当前单集详情；仅展开的 run 挂载编辑器，每个 run 只挂载选中集的完整字段区。复用 DramaEpisodeFields、EpisodeReadEditField、SequenceReadEditFields、DramaEditActions 及 DramaFeedback。保持深浅主题一致，不把完整候选编辑器挂到轻量画布卡片。
- 采用字段级编辑缓冲：铅笔进入编辑模式，保存候选时 PATCH 当前字段，取消不写入；场次新增/拆分/合并/删除为显式结构操作。字段保存事件文本仅发送 events，服务端返回稳定身份及关联，不传入前端临时 eventItems；时长清除使用 null。集级原文引用保留并显示数量，不新增裸 GUID 编辑输入；场次详情复用既有来源和事件关联编辑器。
- 单次仅开放一个字段编辑，阻止换集、收起记录、采用及其他候选编辑；Tab 切换与关闭使用 workspace pending 注册，保存失败保留原输入。删除单集、整条 run 均二次确认，删除确认期间禁止采用当前 run。已采用记录只读，最后一集移除禁用。
- GET list 按 candidate revision 而非集数缓存详情；编辑期间保留活跃 run 快照，服务端 CAS 拒绝远端冲突。变更、采用及编辑状态切换增加读取 epoch；变更前的迟到请求不能复活记录或覆盖修改。更高 revision 的摘要使详情失效，展开 run 自动按需读取；可主动刷新。生成重试中的取消仍允许轮询。
- 采用通过既有 project save barrier 传入 expectedRevision（含旧版 0）。手动删除提示采用时保留已有正式草案内容；详细采用差异仍属于 P5。
- P3 AI 直接接入同一局部字段的当前 draft 缓冲与 CandidateFieldContext，AI 预览/应用不调用 PATCH，只有保存候选时才持久化。P3 已按该约束实现。

P2 前端回归：30 文件、225/225 通过（含新增 3 个状态缓存测试、7 个候选交互测试），npm run typecheck 通过；旧版 tooltip 和只读 article 断言已按新布局更新，重试/取消行为保持。真实 Chrome fixture 脚本扩展候选编辑、关闭恢复、删除与采用验证，使用确定性模型，无付费调用。首次浏览器测试需明确选择完整剧集范围，不能假定从画布第一集打开后默认是全部。

真实 Chrome + 隔离后端验收：scripts/drama-feedback-chrome-e2e.py 62/62 检查通过，浏览器异常 0、在线模型请求 0。候选编辑和单集删除后项目 revision、dramaDraft、dramaConfirmed 均保持；关闭重开读取已保存候选；采用后保留被排除原剧集与确认版本；第二次生成记录整条删除成功，关闭后无 runs 轮询。仅确定性 fixture 验证，在线 AI 优化实测留待 P6。

## P3 实施记录

- AI 优化入口仅在剧集候选的局部编辑态显示，使用编辑框右上角悬浮 Sparkles 图标（无独立文字按钮），输入框预留右侧空间，图标支持 tooltip、键盘访问及选区保留。支持集标题、剧情梗概、剧情事件、本集结尾、场次名称的整字段改写或选区改写。时长及原文/事件引用不交给模型修改。输入意见必填（最多 2500 字符），采用现有配置的文本渠道，支持 openai、openai_compatible、google_gemini。沿用 channel autoroute / credential preparation；不在浏览器持久化密钥。
- 新接口 POST /api/v1/projects/:id/drama-pipeline/runs/:runId/episodes/:episodeId/optimize。请求 expectedRevision、field、mode（field/selection）、draft（当前未保存文本，最多 12000 UTF-16 code units）、instruction、可选 sequenceId（仅 sequenceTitle）、selection（UTF-16 start/end，拒绝越界、空区间、代理对截断）及文本渠道配置。服务端按项目/run/单集读取已审核 ready 候选，校验目标和版本。上下文使用候选其他已保存字段、有限场次名称、冻结故事前 6000 字符，不发送过期的目标字段。长文本拒绝超限，不静默截断用户当前编辑文本。其他上下文有明确长度上限，不是全文语义检索。
- 模型沿用 plainCanvasChat，关闭画布动作、语义意图及 Skill 工具，不创建画布任务/聊天记录。输出仅接受 JSON 对象 {replacement:string}（兼容单层 JSON fence），不能修改其他字段或 ID；服务器以原始编辑快照精确合成完整 value，并复用候选字段校验。事件文本继续逐行处理，不由模型生成或提交 eventItems；保存时仍由 P1 服务端维护稳定 ID 和关联。P4 负责多字段及事件/场次联合语义校验。
- 优化请求不写数据库、候选 revision、正式草案、确认版本或分镜。返回 runId、episodeId、revision、field、sequenceId（场次名称时）、mode、start/end、replacement、value，前端验证全部目标标识、原始快照及合成结果。请求前与模型返回后都校验 ready/revision；每 run 同时只允许一个优化请求，结束或取消后释放占用。客户端停止等待/关闭/修改输入会 abort 请求并隔离迟到结果；后端监听连接中断并向 provider 传递 AbortSignal。实际远端是否及时取消取决于渠道。
- 显示修改前与优化后完整字段预览；放弃、调整意见重新优化均不改变原编辑缓冲。点击应用只更新 draft，未处理预览或生成中禁止保存，workspace pending guard 同样拦截。显式保存候选仍通过 P1 PATCH；采用仍通过 P2 版本栅栏。若输入或 scope 在请求期间变化，清除预览并保留人工输入。
- P3 不新增数据表、历史记录或跨字段状态机。应用后可再次开启局部优化，但自动保留多轮历史、撤销和整集优化在 P4。此次没有调用真实在线渠道，P6 综合验收须用真实模型检查结构化输出质量及实际取消行为。

P3 验收：后端候选专项 12/12（新增 3 项），相关后端回归 78/78（无跳过）；前端候选专项 13/13（新增 6 项），30 个 drama 前端测试文件 231/231；npm run typecheck 通过。真实 Chrome + 隔离实际后端 76/76，0 浏览器异常，0 在线模型请求。fixture 断言模型收到当前人工修订文本、选区及自定义意见，预览和应用前后候选 JSON 完全相同，显式保存后才改变，关闭重开与采用保留修改、未选中内容、被排除原剧集和确认版本。

## P4 实施记录

- 局部 AI 控件保留编辑框悬浮入口，已应用的最近 5 轮意见及修改前/后文本仅在当前字段编辑会话内保存；下一轮使用最新 draft 与已应用意见，未应用/放弃的建议不进入历史。支持逐轮撤销；之后手工输入不同文本时禁止旧撤销覆盖新输入。保存、取消或关闭编辑会话清除历史，不新增 SQLite 表或永久聊天记录。
- 候选单集标题栏新增「整集 AI 优化」入口。局部编辑结束后方可打开，复用 CandidateFieldContext pending 注册、候选版本快照和工作区未保存保护。允许选择集标题、梗概、事件、结尾、目标时长、场次规划（存在场次时）；默认选梗概、事件、结尾。结果逐字段对比，可选择接受子集，事件与场次同时返回时联动选择。已应用结果存于本地整集缓冲；标题/梗概/结尾/时长可继续手动微调，结构化事件和场次通过联合 AI 优化或原有人工结构编辑器处理。下一轮带入当前缓冲和最近五轮已应用意见，支持撤销；手工调整后禁止旧撤销覆盖。未处理预览、生成期间或无效输入不能保存。放弃、取消、迟到响应均不写候选。
- POST /api/v1/projects/:id/drama-pipeline/runs/:runId/episodes/:episodeId/optimize-episode：expectedRevision、fields、draftChanges、instruction、previousInstructions（最多 5 项）、已有文本渠道配置。复用 P3 同一个每-run 请求占用、连接取消及前后 CAS 校验。提示词基于当前候选和未保存修改，包含冻结故事摘录与同一候选中可用的前后集梗概/结尾；最新文本和最新意见优先。只接受 {changes:{...}} 且 changes 非空、仅含授权字段。上下文总大小仍限制 96 KiB；模型结果不会执行画布动作或持久化。
- 场次规划使用 scenePlans: {title,eventIndices:number[]}[]，数量和顺序必须与现有场次一致。模型与客户端均不提供新 ID；服务端保留 scene.id/sourceRefs/replaces，依据最终事件数组索引解析为稳定 eventItems ID。事件经共享 normalizeEpisodeEvents 维护身份；新增/拆并事件给出待核对提示。错误索引、重复引用、非法字段、场次数量改变或未解决的事件引用均拒绝。事件+场次同时返回时必须联合应用；已有未保存 scenePlans 时，再优化 events 也必须选择并返回 scenePlans，防止索引指向错误。场次对比由服务端返回当前有效索引，不展示 GUID。场次新增/删除/重排仍走人工结构操作。
- PATCH 原候选接口新增 wholeEpisode:true，允许上述字段和 scenePlans，服务端在同一个事务内再次校验、映射事件 ID、更新候选 revision（实际改变只增加一次）。失败全量回滚，正式草案/已确认版本/项目 revision/其他候选剧集不变。P1/P2 普通 PATCH 完全兼容。后续 P5 负责采用差异与上下游影响审核。
- 真实模型输出质量、长期会话恢复和实际 provider 取消仍待 P6。本轮历史只在未保存的当前编辑会话中存在；整集场次只支持现有场次名称和事件分配，不允许模型直接增删场次或改原文引用。

P4 验收：候选后端专项 15/15（新增 3），相关后端回归 81/81，无跳过；候选前端专项 17/17（新增 4），30 个 drama 前端测试文件 235/235；TypeScript 检查通过。真实 Chrome + 隔离实际后端 98/98 检查，0 浏览器异常，0 在线模型请求。浏览器覆盖两轮整集建议、独立字段排除、应用不落盘、撤销、手工微调保护、一次保存以及关闭重开和采用；事件/场次联合关系由 HTTP/后端和前端专项测试覆盖。

## 测试

新增 server/backend/drama-episode-candidate.test.mjs，纳入 npm run test:drama-p1。覆盖隔离/稳定 ID/no-op、字段限制、revision 冲突、删除采用语义、空候选保护、运行/取消/采用状态限制、幂等 tombstone、真实 ZIP 往返与旧格式、非法归档及实际 Fastify API 授权与响应。测试使用内存 SQLite、临时 CAS、确定性生成 fixture，不调用付费模型或用户正式项目。

本计划与此前创作反馈性能 P5.2 验收分属不同任务；不改变原性能验收结论。
