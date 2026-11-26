# 分镜视频配置编辑器重构

## 目标与实施顺序
- P1 统一镜头级生产配置解析、预检、创建与工作流归档。
- P2 生成设置 Tab：渠道、模型或工作流选择、输入模式联动；不修改全局默认。
- P3 提示词 Tab：只读/手动编辑/恢复自动生成，保存取消和未保存保护。
- P4 参考素材 Tab：名称/造型/缩略图/补齐入口、中文预检反馈，不展示内部 ID/CAS Key。
- P5 批量配置及已创建节点更新审核、旧项目兼容和完整恢复。
- P6 Chrome 深浅主题、真实本地 ComfyUI 工作流及异常验收。

## P1 实施记录
- 扩展既有 metadata.dramaShotProduction 每镜头可选 target（inherit / online modelOption / comfy templateId+templateRevision）、promptOverride（完整文字及自动提示词来源 fingerprint）、durationSec、aspectRatio。旧字段保留，不新增 SQLite 表；在线模型只保存渠道限定标识，不保存凭证。
- drama-video-production-resolver.ts 负责有效 target、提示词、参数、来源指纹和设置指纹。在线选择明确清除本次有效配置的全局 Comfy 默认；Comfy 显式选择固定模板版本；继承在创建时解析并固化。缺失/非法显式模型拒绝预检，不退回默认。手工提示词为完整文字，不再次自动附加影片风格，图像节点引用仍由 graph builder 生成；禁止手工输入内部 node 标识。promptOutdated 供 P3 展示，手工文本不会随分镜重新生成被覆盖。
- 统一 auditDramaProduction 在原 applyDramaProduction 媒体转换后调用 resolver；单镜头、旧批量入口和工作区批量入口共享 audit。能力检查依据镜头 target；时长/画幅传到参数校验与映射。prepared input 保留原确认 shot，另带 productionSnapshot，包含已检查 target、文字、时长、画幅、确认版本、指纹和人工标记，不包含 AiConfig 或凭证。新配置节点使用快照，不再重新从全局 ratio/style 拼接；在线设置 model，Comfy 通过既有显式 binding。系统维护素材 @ 引用和端口，不属于手动文字。
- 单镜头预检 key 增加全局 config 变化；批量已有逐镜头 key 包含 setting。创建 graph 前校验确认镜头内容、确认版本及已保存生产设置指纹，拒绝旧快照。原来没有 productionSnapshot 的旧调用仍兼容。对于已创建的分镜配置，明确的在线模型移除后普通生成入口拒绝，不回退到默认 Comfy。旧配置更新仍走原显式选择机制，人工提示词增加 overwrite 防护；完整刷新/上游差异语义在 P5 处理。
- project-archive 收集镜头级显式 Comfy 版本，即使尚未创建 Config 节点，也嵌入 ZIP 并恢复到另一 SQLite 库。无数据库 schema 迁移。模板无法找到时保持 archive_template_missing 原有语义。
- 当前 P1 仅建立基础链路，尚未开放编辑控件，不宣称完成 P2–P6。Comfy 模板未声明/未映射的时长和画幅不能承诺实际执行可调整；P2 依据模板能力展示可编辑参数，P6 实际执行核对。旧配置更新、批量 UI 和 GUID 隐藏在后续阶段。真实在线/本地媒体未执行，本轮不产生媒体或模型费用。

## P1 验收
- 相关 Vitest 31 文件 243/243；专项 17/17。新增在线覆盖默认 Comfy、手工 prompt 精确创建、独立工作流、非法/移除渠道、设置或确认版本变化拦截、人工覆盖保护等验证。
- 模板 ZIP 独立数据库往返专项通过，包含未创建视频配置的镜头生产设置。
- 真实 Chrome（scripts/drama-storyboard-p5-chrome-e2e.py）82/82，200 节点/200 镜头，深浅主题、15 条分页、首帧图片暂存/保存/取消、未保存导航保护、重开、预检及实际 Config 图持久化均通过；浏览器异常 0，无生成任务。使用隔离 SQLite/CAS 与测试模板，不是实际 ComfyUI 生成验收。
- TypeScript 检查、生产构建（11.04s）通过。已有未提交候选标题布局不属于本次变更，不混入本次提交。
