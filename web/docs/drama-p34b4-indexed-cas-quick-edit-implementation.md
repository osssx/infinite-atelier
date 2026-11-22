# P3.4b4 实施：画布轻量摘要的两字段单条 CAS 快速编辑

实施日期：2026-11-22；基线：`custom` / `e1082f6`。
依据：`drama-episodes-storyboard-lightweight-workspace-design.md` 第 2.1、2.2、3、5 节。
作用域：`drama:episodes`、`drama:storyboard`。保留 P3.4b2 轻卡与 P3.4b3 页面级工作区，不变更后端 API、SQLite Schema、媒体 Job、版本确认流程。

## 实施内容

1. `drama-node-summary-card.tsx`：在草案视图中且单条响应含合法 `entryDigest` 时，显式提供「快速编辑」；确认版本仍只读，只有选择「草案」才可编辑。无草案/无 digest 时仍可打开完整工作区。每次浏览只读取摘要索引（已确认和草案各一次）及所选条目 `limit=1`，不挂载完整编辑器、不请求全量 payload、不运行 runs 轮询。
2. `drama-node-quick-editor.tsx`：使用独立 `React.lazy` chunk，只在用户点击快速编辑后加载。剧集只编辑当前集 `title`、`synopsis`；分镜只编辑当前镜头 `description`、`durationSec`。完整事件、场次、引用、景别与运镜、素材、视频配置、生成、采用与确认保持在完整工作区。编辑表单在节点的固定高度内滚动，无隐藏的全量正文 DOM。
3. 未保存输入仅保留在组件局部状态；取消不产生数据库或图修订。保存时只构造已改变字段，使用既有 `PATCH /drama-pipeline/entry-draft` 或 `PATCH /drama-pipeline/shot-draft`，提交唯一 `operationId`、表单初次打开时冻结的 `expectedDigest`，保留相同操作 ID 供不确定结果重试。复用 `commitAssistantCanvasGraphWithSaveBarrier`，并传入 `keepCreativePointers:true`、`invalidateCreativeNodeId`，**不使用** `ensureCreativeNodesLoaded`、不在快速编辑中回写整个 `dramaDraft`。
4. 并发 CAS 冲突（例如 `drama_candidate_conflict`）时后端拒绝过期摘要的修改，输入仍留在本地，提示重新读取最新草案；点击「重新读取最新草案」才放弃本轮未提交输入。若保存屏障冲突发生在服务端写入之后，文案提示「可能已提交，需重新核对」，不错误地声称未修改。
5. 保存成功触发草案摘要按需失效，保持当前版本与列表位置；初始化默认查看已确认，用户主动切到草案后不因 metadata 更新而重置视图。切换版本或剧集会取消旧请求，当前选中条目有版本/集/offset 键，旧请求不会覆盖新选择；同时提供明确的「刷新摘要」入口。
6. 本轮不新增批量 Summary API：新编辑链路不增加卡片未展开时的请求；是否要引入服务端批量投影需在 P3.4b5 中根据 200/100/50 生产构建网络与性能证据决定，不能仅凭设计假设迁移现有索引。

## 验证

- `npm run typecheck`：通过。
- `npm run test:drama-p3`：12/15 Node PASS，3 个真实本地 ComfyUI 测试按默认环境跳过；29/29 Vitest PASS。新增快速编辑 4 项，包含每条 CAS、单字段更新、冻结 expectedDigest、冲突保留与取消不写入；摘要卡 6 项涵盖只读/动态挂载、版本、过期响应与刷新。
- `npm run test:drama-p1-browser`：**102/102 断言通过**；真实 Chrome/隔离 Fastify+SQLite/确定性模型 fixture PASS，覆盖从画布选中草案、单集单镜保存、单条修订、未选条目与确认版本不变、视频 Config 不变、服务端并发 CAS 409 与本地保留/主动刷新。在线 Provider 请求 0。
- `npm run test:drama-p33`：142/142 PASS；`npm run test:drama-p2`：74/74 PASS；`npm run build`：生产构建通过。模拟模型验收不等于真实模型/ComfyUI 验收。

### 当前 200/100/50 真实 Chrome 性能诊断（非 P3.4b5 全量 A/B）

- 开发服务 fixture：200 节点、100 镜头、50 资产、70 张图、15 个视频、70 条连线；Chrome 157 / RTX 3080 D3D11 / 2048×1152 / DPR 1.25。
- 平移两轮：89.61、102.72 FPS；P95：41.2、29.4 ms；缩放两轮：87.60、96.25 FPS；P95：41.1、35.2 ms；部分轮次有 3 个 Long Task。**全部未达到 P95 ≤18ms 的严格目标。**
- 统计：compact 初始图约 63,559 字节；可见 DOM 节点 48；总 API 请求 51（含测试操作），scoped 请求 25，写请求 0，运行时浏览器异常 0；GC 后 JS Heap 相对初始增长约 4.03 MB。固定数据集当前只包含 2 个本阶段创作轻卡，不足以直接证成批量 Summary API 的必要性。
- 当前仅是一次开发构建的诊断，并非 3 次旧/新版本 + 生产构建的受控 A/B；P3.4b5 必须继续采样与 Profile，不能声称本轮性能达标。

## 未跨越的边界

- 剧集的目标集数、事件、场次拆分/合并、分镜景别、运镜、素材绑定等仍属于完整工作区；快速编辑仅两字段，避免每个可见卡重新实例化大表单。
- 仍允许画布上可见的每张卡独立发出两次 summaryOnly 和一次当前条目读取。P3.4b5 将以真实 200 节点场景检验请求批量化的必要性，并针对开发/生产构建 FPS、P95/P99、Long Task、内存持续增长做严格 A/B，当前不可宣称 P3.4b 总体性能目标已达成。
- 真实本地 ComfyUI、在线模型与实际媒体生成未在本轮重新执行；P3.4b4 不改变这些生产执行路径。
