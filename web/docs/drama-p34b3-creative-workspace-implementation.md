# P3.4b3 实施：页面级创作工作区 Tab 按需加载与草案关闭门禁

实施日期：2026-11-22；基线：`custom` / `a2b8044`。
范围：`drama:episodes` 与 `drama:storyboard`；不变更 SQLite Schema、CAS 原子写入和后端媒体 Job。

## 本轮实现

1. 新增 `drama-creative-workspace.tsx`，在画布页使用 `React.lazy` 按需创建一个页面级 Modal 宿主，分 `剧集编辑/分镜表`、`分页与单条 CAS`、`视频配置`（仅分镜）、`生成候选`、`影响与历史` Tab。未选中 Tab 不挂载局部编辑器 DOM；关闭工作区销毁子树。
2. `DramaNodeSummaryCard` 的显式打开动作携带 `episodeId/sequenceId/shotId`，画布页复用请求代次避免异步打开错节点；`DramaEpisodeFields` 和 `DramaStoryboardFields` 首次挂载时按入口 ID 选中，作用于编辑视图而不修订画布。独立分页浏览器接受入口选中 ID，后端通过 `entryId` 精确定位一条；提供「显示完整列表」退出该筛选。
3. `DramaPipelineNodePanel` 按 `workspaceTab` 挂载编辑正文／视频配置／运行记录／依赖影响。`DramaVideoConfigFields` 独立动态导入，只有进入视频配置时挂载。原有视频预检、生成候选、差异采用、确认和镜头组合并保持原 API 与回调。
4. 剧集/分镜 runs 轮询：常驻画布轻卡没有计时器；完整工作区仅在生成候选 Tab 或本地正在生成／已知运行中任务时触发 3 秒轮询；切换到非运行 Tab、关闭 Modal 后清理定时器。注意后台 Job 自有状态机与本地轮询是独立的。
5. `DramaCreativeScopeBrowser` 的局部标题/简介/场次表单和批量暂存、`DramaRevisionBrowser` 的逐镜草案表单，向宿主注册「当前本地未提交编辑 → 对应 CAS 保存函数」。离开当前 Tab 或关闭 Modal 时三选一：保存草案 / 放弃修改 / 继续编辑。选择保存时逐项 await 后端 CAS；任一保存失败保留编辑界面并显示错误，不自动确认发布；选择继续不卸载表单。完整表单持续按既有写路径更新全局画布，并在真正关闭时调用持久化屏障。
6. 编辑器版本确认、候选采用、依赖检查、视频配置与媒体预检、ZIP 兼容原有 P1/P2/P3 业务行为；`drama:assets` 继续保持既有路径。

## 验证

- `npm run typecheck`：通过。
- `npm run build`：通过；Vite 实际输出独立 `drama-creative-workspace`、`drama-video-config-fields`、`drama-pipeline-node-panel` chunks。主页面历史遗留大 chunk 的优化属于其他阶段。
- `npm run test:drama-p3`：12/15 Node 通过、3 个需要本地 ComfyUI 的用例按默认环境跳过；22/22 Vitest 通过（新增工作区 Tab/关闭保存门禁和 CAS 冲突保留编辑器三项）。
- `npm run test:drama-p1-browser`：76/76 项断言通过，使用真实 Chrome、隔离后端和 deterministic mock。覆盖候选生成和采用、CAS 单条/批量保存、确认与视频配置、镜头组、ZIP 恢复；已适配 P3.4b3 Tab 入口与完整编辑器卸载断言。本轮没有在线 Provider 请求。
- 性能目标 `FPS>=58,P95<=18ms,P99<=33.4ms,longtask=0` 仍须 P3.4b5 使用生产构建及 200/100/50 fixture 做严格 A/B，不用功能测试结果推断性能达标。

## 后续边界与注意事项

- 当前完整编辑业务逻辑仍复用 `DramaPipelineNodePanel`，打开「编辑」Tab 时仍可能解析该节点完整正文和依赖；P3.4b4 可继续把局部字段 CAS 作为主编辑通道，减少整体 draft 更新。当前已通过 Tab、局部 Scope 分页与视频配置 chunk 将可避免的渲染隔离。
- 工作区内的草案门禁保护由两个独立局部编辑器注册的未提交状态；画布完整编辑器自身按原写入机制即时更新 Canvas Store，不作为「本地未提交」处理，关闭依然使用 Canvas Store 保存屏障。
- 项目路由强制切换时仍由画布页清理过期工作区实例；若需跨项目保留尚未提交的局部字段，应在路由级补充导航拦截，不能将当前弹窗离开门禁视为跨路由持久保证。
- 未完成 P3.4b4 轻量卡片内编辑及 P3.4b5 性能达标。不得将 P3.4b3 通过等同于 P3.4b 整体完成。
