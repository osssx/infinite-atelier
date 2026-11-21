# Drama P2.2：影响范围联动与候选差异选择性采用

状态：P2.2 第一轮已实施，依赖 P2.1 提交 4254368。**本轮不代表 P2 全部完成。**

## 操作链路

打开分镜节点的「检查上游更新」，可直接预选受影响的剧集、场次或镜头。预选只是客户端状态更新，只有用户再次点击「生成分镜候选」才实际提交模型请求。已有的按集、场、镜冻结输入及中断续跑接口保持不变。

打开运行候选后，调用新的只读路由：

    GET /api/v1/projects/:id/drama-pipeline/runs/:runId/preview

基于同一运行的冻结草案、模型候选和当前最新画布，计算逐镜差异：

- 新增 added、替换 replaced、删除 deleted、纯重排 reordered、未变 unchanged；同时提供 before、after、current 简短片段。
- 逐项展示 changed、conflict、adopted 状态。预览还包括 summary、manualExtraIds、sourceChanged 和 fullAdoptBlocked。
- 原有采用路由仍接受 shotIds 数组，但现在既能包含模型候选的镜头 ID，也能包含旧镜头被删除的 ID。
- 已采用的删除写入 candidate.adoptedRemovedShotIds，随原有 Run JSON 和 ZIP 归档往返；不需要迁移 SQLite Schema。

## 数据保护与兼容

预览严格只读；采用仍进入同一个 SQLite 事务，重读原确认的上游输入以及目标范围当前草案，进行逐项冲突校验。人工在生成期间更改的镜头不能覆盖；其他无冲突项目仍可以逐项采用。整批采用额外检测运行期间人工新插入的镜头，避免其被整体替换时意外丢失。

删除只影响明确选择的旧镜头。更新在原节点槽位就地替换，新镜头按同集镜头 order 临近插入，避免部分采用全部堆积在图表末尾。历史视频 Config、参考图、连线及其他集的内容维持原状，不自动触发生成。

画布面板新增「选择全部无冲突差异」「采用所选差异」「刷新差异与冲突」，以及逐项的原文本与候选文本。被冲突和已采用的项禁用选择。旧的全部采用入口对已知不安全的全量覆盖禁用，但服务端仍然独立复核。

## 验收

在 web/ 目录运行：

    npm run test:drama-p2
    npm run typecheck
    npm run test:drama-p1
    npm run test:drama-p1-browser

新增 server/backend/drama-run-diff.test.mjs 覆盖新增/替换/删除/重排、人工改动冲突、人工新镜头保护、部分采用幂等、选择旧镜头删除、跨集保留、Run ZIP 往返与真实 HTTP 授权路由。原 P1 Chrome 隔离夹具进一步检验 React 画布真实渲染了候选差异，并继续保护人工视频 Config 与归档恢复。

## 后续 P2 工作

当前的按镜头 ID 选择仍不表达多场拆分合并、一对多镜头迁移及跨场重排的所有业务语义。下一步需为场次和剧情事件增加稳定身份和迁移差异，并补齐跨重启多场候选 + 局部删除/重排的综合验收。参考图引用原子重写、美术设定定向更新及 P3 媒体输入/尾帧传播仍未纳入本轮。
