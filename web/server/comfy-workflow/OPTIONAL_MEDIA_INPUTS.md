# ComfyUI 预设：可选媒体输入自动裁剪

该功能不推断 t2v、i2v、fl2v 或 ref2v，也不按模式重接生成分支。具体模式完全由 ComfyUI 模型对提示词和实际输入的媒体参数决定。

## 使用

在预设工作流的输入绑定面板，将图片、视频或音频输入端口（IMAGE / VIDEO / AUDIO）绑定到 ComfyUI 的 media-file 上传字段，或模型的图片 socket。勾选“未提供媒体时动态裁剪输入”，即可为该端口保存 absentPolicy: { mode: auto-prune }。

没有该端口的有效连接时，编译器检查实例 /object_info：

- 若绑定的是可选 socket 或可选文件字段，则直接删除该字段。
- 若绑定的是媒体加载节点的必填文件字段（如 LoadImage.image），则追踪引用，断开下游声明为 optional 的输入，再通过原有可达性裁剪去除孤立加载器和中间处理节点。
- 若最终仍保留了依赖缺失文件的必填节点，或缺少合法的 optional 消费者，则在 /prompt 前拒绝编译；不提交空字符串或预设中的旧文件名。
- 输入存在则按现有逻辑上传并替换绑定，不会改变模型执行模式。

注意：端口允许动态裁剪不等于任意 ComfyUI 节点的必填字段都可以删除。目标模型必须支持缺少该媒体参数，通常表现为 /object_info 中将其声明为 optional。对于媒体加载器，可选性位于其下游的模型输入。

旧版 absentPolicy.keep-template 和手动 disconnect 保持兼容，旧版 SHA-256 版本也不改变。开启该选项后保存将形成新的预设版本。多个参考图使用多个独立 IMAGE 输入端口配置，不引入服务端模式路由。

## 验收

- node --test web/server/comfy-workflow/optional-media-pruning.test.mjs
- node --test web/server/comfy-workflow/comfy-workflow.test.mjs web/server/backend/comfy-v2-adapter.test.mjs
- 在 web 下执行 npm run typecheck 与 npm run build，并对目标模型做真实 ComfyUI 运行验证。
