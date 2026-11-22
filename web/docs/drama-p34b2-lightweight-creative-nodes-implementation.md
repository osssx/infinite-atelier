# P3.4b2 实施：剧集与分镜画布轻量摘要 + 按需最大化编辑器

实施日期：2026-11-22；实施基准：`custom` / `428b59f`。遵照 `web/docs/drama-episodes-storyboard-lightweight-workspace-design.md`；此轮以 P3.4b2 为核心，同时补齐保留功能所必需的最小页面级工作区接线，不宣称完成后续 P3.4b3 全量架构分离与 P3.4b4 快速编辑。

## 实现内容

1. 新增 `web/src/features/canvas-assistant/drama-node-summary-card.tsx`。仅 `drama:episodes`、`drama:storyboard` 改为定高、溢出裁剪的摘要卡：剧集数量、确认/草案版本、单集标题及两行概要；分镜的集/镜头数量、当前集选择、景别、时长及两行画面描述。选择集、前后镜头只变更本地 UI 状态，不产生 Canvas Revision 或模型请求。
2. **画布常驻组件没有完整编辑器**：不挂载 `DramaPipelineNodePanel`、`DramaEpisodeFields`、`DramaStoryboardFields`、`DramaVideoConfigFields`，不启动 `runs` 的 3 秒轮询。摘要通过真实后端 `GET /drama-pipeline/revision-scope?summaryOnly=true` 获取草案/确认数量；只通过 `limit=1` 获取当前集/镜头，切换集按 `episodeId` 检索。请求支持 `AbortController` 和 stale response 防护。旧内联字段由原 scoped reader 兼容，不在 React render 中 `JSON.parse` 全部 100 个镜头。
3. **保留业务能力**：`project.tsx` 新建单一页面级 Modal Host；用户必须点击“打开完整编辑器”，`ensureCreativeNodesLoaded` 才会 hydrate 对应节点及既有上游，再渲染完整工作区。重型 `DramaPipelineNodePanel` 通过 `React.lazy` 切成独立 chunk，新增 `workspaceMode` 直接扩展内部表单且不再自建嵌套 Modal。Modal 同时提供只在打开时挂载的 `DramaCreativeScopeBrowser`（剧集单条 CAS）/ `DramaRevisionBrowser`（分镜单条 CAS）侧边区域，保留后端单条事务修订路径。
4. 最大化面板仍使用原来的候选生成与采用、版本确认、阶段校验、场次迁移、视频 Config 和 Shot Group 操作回调；关闭时先等待 `awaitCanvasStorePersistence` 并保留错误提示；用户进入 Config/画布参考选择时解除模态遮挡。打开请求按代次保护，项目切换清理旧面板。浅/深色继承 Canvas `theme.node`。
5. `web/scripts/drama-p1-chrome-e2e.py` 适配新的交互：先验证画布摘要轻量、不挂载完整编辑器；接着通过真实最大化按钮，在侧栏操作剧集单条 CAS、草案与上游确认、候选采用、视频配置和批量镜头组。保留原 P1/P2/P3 断言；`drama-p34b-chrome-perf.py` 适配真正的摘要卡和按集切换，要求无最大化面板挂载。
6. 新增 `web/src/features/canvas-assistant/drama-node-summary-card.test.tsx` 3 项 React 测试，断言只请求 scoped summary+单条、集选择只读当前条以及显式点击才调用完整编辑入口；加入标准 `npm run test:drama-p3`。

## 与旧版真实 Chrome 基线的对照

同一隔离真实后端 fixture：200 个画布节点、100 镜头、50 资产、70 图片/15 视频节点、70 条连线；Chrome 157、RTX 3080/D3D11、2048×1152 CSS、DPR 1.25。测试运行 Vite 开发服务，并非生产构建帧率担保。

| 交互 | P3.4b 原基线 平均 FPS / P95 | P3.4b2 当前 平均 FPS / P95 |
|---|---|---|
| 平移 1 | 96.51 / 37.9 ms | 94.27 / 34.3 ms |
| 平移 2 | 105.67 / 27.4 ms | 113.89 / 26.0 ms |
| 缩放 1 | 90.55 / 32.4 ms | 86.87 / 32.9 ms |
| 缩放 2 | 94.85 / 32.4 ms | 96.78 / 27.3 ms |

初始 compact graph **63,559 字节**、3 项创作正文 pointer；没有内联草案正文。全程按页读取、切换 15 次剧集并操作画布，未打开重型编辑器、无项目写请求和运行时浏览器异常。GC 后 JS Heap 相对初始加载增加约 **4.15 MiB**。分镜摘要通过真实 4 集的索引切换，不再通过在节点内挂载完整 `DramaRevisionBrowser` 浏览。

**性能结论：本轮实现交互隔离与按需挂载，但严格性能目标尚未达标。** 四轮 P95 仍在 26.0–34.3 ms，目标为 ≤18 ms；偶有 Long Task。个别轮次改善，但样本不足以证明整体 FPS 增益，应在同样硬件环境做至少 3 次 A/B 和生产构建测试，并继续 JS CPU Profile / Frame Timeline 定位其他热点。

## 回归与安全边界

- React 单元测试：摘要只取小范围数据、按集切换、显式最大化（3 项）。
- `npm run test:drama-p1-browser`：**真实 Chrome 68/68 PASS**，覆盖简化节点、真正打开剧集/分镜完整编辑器、单条 CAS 修改、候选生成与采用、确认、视频配置、分组、ZIP 恢复；在线 Provider 请求 0，候选场景使用隔离 deterministic mock。
- `npm run test:drama-p1`：35 Node + 11 Vitest 全通过；`test:drama-p2`：74/74；`test:drama-p33`：142/142；`ATELIER_TEST_LOCAL_COMFY=1 npm run test:drama-p3`：15 Node + 19 Vitest，**0 SKIP**，含 3 项真实本地 ComfyUI；`typecheck`、`build` 全通过。
- 生产后端、SQLite schema、CAS、版本确认和现有视频 Job 状态机**没有变动**。13 项用户原有 dirty 路径保持不变，不包含在提交中。

## 后续

- **P3.4b3**：完整工作区进一步按功能 Tab 动态加载，减少 Modal 内完整 `DramaPipelineNodePanel` 对上游数据的整体扫描；补齐真正的选中 episode/shot 深链接与操作中关闭门禁。
- **P3.4b4**：画布摘要轻量编辑，限制字段，复用 `entry-draft`、`shot-draft` 单条 CAS 和 expectedDigest；不得用旧 `dramaDraft` 覆盖全体。
- **P3.4b5**：生产构建 A/B、帧 Timeline/CPU hotspots、FPS/P95/P99/Long Task、内存长期增长和 200/100/50 验收门槛；在指标真正达标前 P3.4b 不能标记全完成。
