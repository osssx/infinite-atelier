# ComfyUI 统一工作流产物架构设计（图片 / 视频 / 音频 / 文本）

> 状态：设计方案，**尚未实现**。适用项目：`infinite-atelier`；基于 2026-10-23 的实际代码。
>
> 核心决策：**一个工作流执行器 + 一份产物清单 + 可插拔的捕获/归档/画布回填适配器**。执行不按媒体类型分叉；媒体类型仅影响输入暂存（若需要）、输出捕获、校验、归档和画布具象化。

## 1. 目标与非目标

- **统一执行**：一个 Comfy API Graph、一次 `POST /prompt`，同一组任务状态、幂等提交、重启恢复、`/history/{promptId}` 轮询和取消语义；无 `imageRunner/videoRunner/audioRunner/textRunner`。
- **四类产物**：`IMAGE` → 图片、`VIDEO` → 视频、`AUDIO` → 音频、`STRING` → 文本；允许一个端口返回多项，一次运行含多个不同类型的输出端口。
- **绑定驱动**：只有预设/节点明确选择的 `source` 端口产生用户产物；不靠文件扩展名猜测模板的主要输出，也不把中间预览文件误算为产物。
- **可恢复性不退化**：冻结模板 revision 与请求快照、上传输入、持久化 compiled graph / capture manifest / submission marker 后才提交 GPU；提交未知时**绝不自动重投**。
- **兼容旧工程**：继续读取 schemaVersion=1、旧 SaveImage 捕获记录和带 `metadata.comfyArtifact` 的 Image 节点；旧画布连线与历史文件不清理。
- **非目标（本阶段）**：多工作流编排（工作流输出连到另一个工作流输入）、多 worker lease、流式中间图像、对任意第三方自定义节点不经适配就承诺可捕获。不改变 Comfy 本身的生成/采样/编码算法。

## 2. 执行主干——完全无媒体分支

```text
Canvas snapshot + pinned template + output port selection
                    |
InputSnapshot / InputStager（按输入类型上传或提供 literal）
                    |
GraphCompiler（解析绑定；由 OutputCaptureRegistry 生成捕获根）
                    |
Validate (/object_info) → persist job + graph + capture manifest
                    |
     submit barrier → POST /prompt （整个图仅一次）
                    |
        queued/running + /history polling
                    |
HistoryCollector → OutputAdapterRegistry → ArtifactStore
                    |
        unified ArtifactManifest[]
                    |
CanvasArtifactImporter（按 artifact.kind 创建节点并连线）
```

`RunScheduler` / `ComfyClient` / `RunStateMachine` 不知道 `image/video/audio/text`；差异只在这些接口：

```ts
interface CaptureAdapter {
  id: string;                            // save-image/core-v1, save-video/core-v1 ...
  artifactKind: "image"|"video"|"audio"|"text";
  compatibleOutputTypes: readonly string[];
  canCapture(source: ComfySocket, objectInfo: ComfyObjectInfo): boolean;
  prepare(graph: ComfyApiGraph, source: ComfySocket, ctx: CaptureContext): CaptureBinding;
  extract(historyOutput: unknown, binding: CaptureBinding): CaptureCandidate[];
  validate(candidate: CaptureCandidate, data: AsyncIterable<Uint8Array>): ArtifactMetadata;
}

interface CanvasArtifactAdapter {
  kind: ArtifactKind;
  import(artifact: ComfyArtifact): Promise<MaterializedNode>;
}
```

注意：`CaptureAdapter.prepare()` 在编译时负责选取已有 Save 节点或插入明确的采集节点；`extract()` 只负责解释已绑定节点的 history 输出，不能把 `/history.outputs` 中所有媒体文件当成所选产物。

## 3. 类型模型

### 3.1 输出端口声明

沿用 `ComfyTemplatePort`，把目前已存在的 `capture.kind`（`image/video/audio/text/none`）作为**绑定契约**，补齐策略并显式列出一个或多个输出根：

```ts
type ArtifactKind = "image" | "video" | "audio" | "text";
type ArtifactSocketType = "IMAGE" | "VIDEO" | "AUDIO" | "STRING";

type CaptureConfigV2 = {
  kind: ArtifactKind;
  adapterId: string;                // 例如 core/save-video@1
  strategy: "reuse-sink" | "inject-sink";
  required?: boolean;              // 默认 true
  format?: string;                  // 用户明确指定，非强制统一 png
  // adapter 自有、经严格白名单校验的可序列化选项
  options?: Record<string, unknown>;
};

type WorkflowOutputPortV2 = {
  id: string;
  label: string;
  direction: "source";
  valueKind: ArtifactSocketType;
  outputBinding: { nodeId: string; outputIndex: number };
  capture: CaptureConfigV2;
};
```

- 现有 Krea：`IMAGE / SaveImage`；现有 MiniMax H3 I2V：`VIDEO / CreateVideo[0] / SaveVideo`。
- Comfy `STRING` 映射为 **artifact.kind=text**，不用伪造一个 Comfy 输出类型 `TEXT`。
- 一个端口的 `valueKind` 是 Comfy 数据流类型，`artifact.kind` 是应用级可保存资源类型；两者通过 adapter 映射，不依赖 MIME/文件扩展名推断。
- `capture.kind=none` 仍允许作为“不回填”内部辅助端口，但不能被选为必须回传的 `rootOutputs`。

### 3.2 请求 V2 与兼容规则

```ts
type RunRequestV2 = {
  schemaVersion: 2;
  projectId: string;
  instanceId: string;
  idempotencyKey: string;
  canvasRevision: string;
  nodes: [{id:string;templateId:string;templateRevision:string;
           inputOverrides:Record<string,unknown>}]; // 当前仍单工作流节点
  rootOutputs: Array<{nodeId:string;portId:string}>; // 1..N，去重、全为 source
  externalInputs: ExternalInputSnapshot[];
  edges: ExplicitCanvasInputEdge[];
  runOptions: Record<string,unknown>;
};
```

- 仍是一份不可变模板、一个节点，多个输出只是**一个 Comfy 图中的多个根**；绝非多次 `POST /prompt`。
- `fingerprintRequest()` 包含选择的端口列表及其绑定配置快照；`rootOutputs` 排序规范化，避免顺序变化被误判为不同请求；`idempotencyKey` 与 transient `canvasRevision` 延续当前规则。
- 旧 schemaVersion=1 的 `rootOutputs.length === 1`、`IMAGE/SaveImage` 按原逻辑解释；新 schemaVersion=2 引入多类型，多输出；不可直接改写旧 revision 的 hash。
- V2 的多端口数设硬上限（建议 16）；编译后节点上限继续 500。若实际业务要求“一次仅选一个输出端口”，UI 可先维持单选，协议仍支持多选。

### 3.3 CaptureManifest：提交之前即冻结

```ts
type CaptureBinding = {
  workflowNodeId: string;
  portId: string;
  kind: ArtifactKind;
  valueKind: ArtifactSocketType;
  source: {nodeId:string;outputIndex:number};
  captureNodeId: string;
  adapterId: string;
  adapterVersion: number;
  required: boolean;
  // 用什么策略解析 /history 对应 captureNodeId 的数据
  selector: string;
};
```

编译输出 `{graph, graphHash, captureMap: CaptureBinding[]}`。**先注入/复用所有捕获根，再从全部根求依赖并集裁剪，最后校验图**；不可按第一个 IMAGE 根单独裁剪，否则会丢失 VIDEO/AUDIO/TEXT 的分支。独立输出可同时保存多个文件，采样图只执行一次。

`reuse-sink`：当原图已有 `SaveVideo` / `SaveImage` 等输出节点，且其输入准确指向绑定源时，**复用原节点**作为捕获根，避免重复编码/重复保存。否则 `inject-sink` 由适配器按照实时 `/object_info` 安全构造。不能假定任意第三方“Save”节点的字段名相同。必要时在绑定编辑器显示“不具备可捕获的适配器”。

## 4. 四种捕获适配器

| 产物 | Comfy 输出 socket | 首选捕获节点 | 解码/存储 | 画布落点 |
|---|---|---|---|---|
| 图片 | `IMAGE` | `SaveImage` | PNG/JPEG/WebP 的文件条目，验证 magic + MIME | `CanvasNodeType.Image` |
| 视频 | `VIDEO` | `SaveVideo`（优先复用模板已有） | MP4/WebM/MKV 等已确认格式；流式写盘、容器头校验 | `CanvasNodeType.Video` |
| 音频 | `AUDIO` | `SaveAudio` / 实例支持的已注册 sink | WAV/FLAC/MP3/OGG 等经适配验证的格式 | `CanvasNodeType.Audio` |
| 文本 | `STRING` | `SaveText` / 能返回明确字符串或 txt 文件的适配器 | UTF-8，保存为 `text/plain`；可选 `application/json` 语义解析但不必转 JSON 节点 | `CanvasNodeType.Text` |

**重要：Comfy `/history` 的字段名不等于资源类型。** 已有 MiniMax H3 工作流的 `SaveVideo` 可能将 `.mp4` 文件引用放在 `outputs[captureNodeId].images[]`，并带 `animated` 标志；如果依赖固定 `images→IMAGE` 会误识别为图片。须由注册的 SaveVideo adapter 识别该节点响应，并基于声明的 `kind=video` 做格式验证。

音频和文本保存节点的 history 形状取决于 Comfy 核心版本及所安装自定义节点：仅凭 `/object_info` 存在类名，不代表它按 `audio[]` / `text[]` 返回结果。适配器必须含**明确的 history extractor 和 fixtures**，找不到可验证的数据源就返回 `capture_adapter_unsupported`，而不是生成空文件或从任意上游输入冒充模型输出。文本如果直接通过 history 返回字符串，可进行带格式/长度限制的内联归档；否则强制文件 sink，不能假设文字自动进入 history。

建议先内置这四个 adapter 的能力契约和静态探测，实际选择需比对当前实例 `/object_info`：

```ts
const captureRegistry = new Map([
  ["core/SaveImage@1", imageCaptureAdapter],
  ["core/SaveVideo@1", videoCaptureAdapter],
  ["core/SaveAudio@1", audioCaptureAdapter],
  ["core/SaveText@1", textCaptureAdapter],
]);
```

对于不同版本或第三方节点（`VHS_VideoCombine`、WAS 等）添加 adapter 文件，不改 `RunScheduler`、`RunStore` 的状态机。自定义节点允许进入原始 graph；**允许执行某个 class ≠ 允许它的任意 history JSON 作为产物**。

## 5. 统一持久化 ArtifactManifest

```ts
type ComfyArtifactV2 = {
  artifactId: string;
  runId: string;
  workflowNodeId: string;
  portId: string;                 // 哪个用户可见的画布输出端口
  itemKey: string;                // adapter 生成的稳定条目键（同一批的第 N 项）
  index: number;                  // 同一端口内的顺序
  kind: ArtifactKind;
  mimeType: string;
  byteSize: number;
  sha256: string;
  url: string;                    // 项目网关自己的受控下载 URL
  filename?: string;              // 展示用的安全名字
  metadata?: {
    width?: number;height?: number;
    durationMs?: number;fps?: number;
    sampleRate?: number;channels?: number;
    textEncoding?: "utf-8";
  };
};
```

- V1 `artifacts` 表已存 `run_id,workflow_node_id,port_id,capture_node_id,file_key,mime,sha256,size,path`；V2 加 `kind,index,metadata_json,adapter_id` 等列，不移除旧列，老数据迁移为 `kind=image`。
- 幂等主键建议 `UNIQUE(run_id,port_id,item_key)`；`itemKey` 来自当前绑定的 history file descriptor 或 inline 文本项的稳定索引/摘要。重复轮询和中途重启不能新增重复资源。
- 底层统一按字节流存储（文本也以 UTF-8 字节归档），先临时文件写入 + hash + size + fsync + 原子 rename，再提交 SQLite 记录，失败可重试。下载统一 `GET /api/comfy/runs/:id/artifacts/:artifactId`，只根据 MIME 正确返回 Content-Type / Content-Disposition，绝不暴露任意本地路径。
- 图片可以多图、音频多段、视频多条、文本多条；`run.artifacts` 为全局扁平数组，但带 `portId/index/kind`，UI 可以按端口分组。
- 不将二进制媒体或超长文本内联进 SQLite；文本内容如 UI 需要预览，可只返回定长、安全转义的 `preview`，完整文本从归档下载/读取。

## 6. HistoryCollector 的统一收集算法

```ts
async function collectCompletedRun(run: RunRecord) {
  const history = await comfy.getHistory(run.promptId);
  const entry = history?.[run.promptId];
  if (!entry || !historyCompleted(entry)) return; // 各类工作流一样

  for (const capture of run.captureMap) {
    const adapter = captureRegistry.require(capture.adapterId);
    const candidates = adapter.extract(entry.outputs?.[capture.captureNodeId], capture);
    if (!candidates.length && capture.required)
      throw new RecoverableOrTerminalCaptureError(capture.portId);

    for (const [index, candidate] of candidates.entries()) {
      const itemKey = adapter.stableKey(candidate, index);
      if (store.hasArtifact(run.id, capture.portId, itemKey)) continue;
      const bytes = await comfy.streamCapturedItem(candidate); // 文件或受限内联 text
      await store.persistArtifact(run, capture, itemKey, index, bytes, adapter);
    }
  }

  if (store.allRequiredCapturesDurable(run.id, run.captureMap))
    store.cas(run.id, "collecting", "succeeded");
}
```

- 任务失败（Comfy history status=error）直接记 GPU 执行失败；**产物回收失败**仍保持 `collecting`（可按退避策略重试），**不重新 POST /prompt**。
- 所有 required 端口至少得到一项且所有声明的条目已持久化才能 `succeeded`。可选端口的 `missing` 应形成显式状态；首版不默认产生 `partial` 成功，避免“视频没有生成却显示成功”。
- 区分 `capture_missing`、`capture_adapter_unsupported`、`invalid_media`、`download_failed`、`quota_exceeded` 等错误。下载 404 可能是临时文件被 Comfy 清理，按受限次数重试后标记可操作错误，不无限锁定队列。
- **不依赖文件名扩展判定 type**：捕获类型来自 adapter，文件扩展名/MIME/magic 三者互相校验；对重名、跨端口同源资源按各自 `portId` 保留引用。
- GPU 执行进度不受输出格式影响；可继续沿用 polling，后续通过 Comfy WS 事件获取节点级执行百分比，但 WS 与捕获类型无关。

## 7. 大视频/音频需要的资源控制

当前 `service.mjs upstream()` 的 `expectBinary` 限额为 **40 MB** 且拼成 Buffer；视频产物不可直接复制这套逻辑。

- `/view` 改为流式接收和 hash、长度累计与 backpressure；单产物可配置上限（例：图片 40 MB、视频 2 GB、音频 500 MB、文本 2 MB，实际由部署配置决定），并设置 run 总容量和磁盘配额。
- HTTP 下载启用 `Range`（浏览器 Video/Audio seek），按 `artifactId` 授权，校验 MIME、长度、文件内容；拒绝重定向、非法 subfolder、任意绝对路径、HTML/SVG/脚本伪装为媒体。
- 对 `text/plain` 验 UTF-8、限制控制字符；显示时按纯文本渲染，不把模型输出解释为 HTML。
- 对 codec 不受浏览器支持的视频，存原始产物且明确标记“无法直接预览”；转码应是独立**后处理任务**，不属于 Comfy 工作流执行主干。
- 产物持久化与前端 IndexedDB 双存策略要明确配额、超时和清理；`GET` 支持浏览器缓存时依用户授权隔离。多个网关进程共用单 SQLite 目录仍不是目标。

## 8. 画布回填统一入口

```ts
const nodeTypeByArtifactKind = {
  image: CanvasNodeType.Image,
  video: CanvasNodeType.Video,
  audio: CanvasNodeType.Audio,
  text:  CanvasNodeType.Text,
} as const;

async function importComfyArtifacts(run: RunStateV2): Promise<void> {
  for (const artifact of run.artifacts) {
    if (canvas.hasProvenance(artifact.artifactId)) continue;
    const importer = canvasArtifactRegistry.require(artifact.kind);
    const created = await importer.createNode(artifact);
    // 保留原有 {runId,artifactId,workflowNodeId,portId} 溯源
    await canvas.upsertGeneratedNodeAndProvenanceEdge(created, artifact);
  }
}
```

- 图片：沿用 `uploadImage`、原生大小和现有 `Image` 布局。
- 视频：使用项目现有 Video 节点媒体存储/视频元数据服务（`durationMs, mimeType, poster`），不要强制转成 GIF 或图片。
- 音频：使用项目现有 Audio 节点存储/波形能力，按实际格式保留 MIME。
- 文本：Text 节点使用 **Comfy 实际输出内容** 的 UTF-8 文本，不能误用请求提示词作为输出。
- 统一溯源结构 `metadata.comfyArtifact` 仍含 `artifactId,runId,workflowNodeId,portId`，新增 `kind/index` 可选字段；更新 `prepareCanvasPortConnection` 和 `reconcileComfyArtifactConnections`：工作流 `IMAGE/VIDEO/AUDIO/STRING` 输出只能连接由本次捕获产生且类型匹配的对应资源节点；原有图片连线仍有效。
- 图片、视频、音频、文本混合输出按端口分组排布，不互相覆盖；节点数量、内存及异步导入需增量处理，不能把整段大视频解为内存中的 data URL。
- **前端回填失败独立于 GPU run 状态**：服务端 `succeeded` 表示所有产物可靠归档；前端每个 `artifactId` 有 `importing/imported/failed` 状态，可逐项重试，不重新发 GPU 任务。关闭面板、重载画布也可继续未完成回填。

## 9. 需修改的现有文件

| 路径 | 主要改动 |
|---|---|
| `web/server/comfy-workflow/compiler.mjs` | `compileSingleWorkflow` 拆为共享绑定编译与 `captureRegistry`，多 root union 剪枝，不再检查 `single_image_capture_required` |
| `web/server/comfy-workflow/service.mjs` | `prepareSubmit` 继续只 POST 一次；`collect()` 改按 capture manifest 遍历 adapter；媒体流式下载 |
| `web/server/comfy-workflow/store.mjs` | `artifacts.kind/index/metadata` 迁移、按 `portId+itemKey` 幂等保存，保留旧图片记录 |
| `web/src/features/comfy-workflow/template-schema.ts` | 已有 image/video/audio/text 类型契约扩展捕获策略；既有模板 revision 不变 |
| `web/src/features/comfy-workflow/run-client.ts` | `RunRequestV2`、`ComfyArtifactV2`、按媒体类型分发上传；图执行请求统一 |
| `web/src/pages/canvas/project.tsx` | `handleComfyArtifacts` 变四类型 `importComfyArtifacts`，支持多端口回填与逐项恢复 |
| `web/src/lib/canvas/canvas-port-connections.ts` | 类型化来源连线与四类资源节点修复 |
| `web/src/features/comfy-workflow/comfy-workflow-instance-panel.tsx` | 不再仅选择 IMAGE 输出；显示产物集合、按类型计数与进度 |
| `web/src/features/comfy-workflow/minimax-h3-i2v-preset.ts` | 已声明 `VIDEO/SaveVideo`，无需重新为视频编写执行器 |

新增建议：
- `web/server/comfy-workflow/capture-adapters/{image,video,audio,text}.mjs`
- `web/server/comfy-workflow/artifact-collector.mjs`
- `web/src/features/comfy-workflow/artifact-importers/{image,video,audio,text}.ts`
- `web/src/features/comfy-workflow/artifact-contract.ts`（或前后端共有的无 DOM/Node 依赖协议文件）

## 10. 实施顺序与验收标准

| 阶段 | 变更 | 验收 |
|---|---|---|
| **P0：协议与兼容** | 四类型 `ArtifactKind` / `CaptureBinding` / SQLite 迁移；IMAGE 通过旧流程等价回归；可创建多 root 但先不开放 UI | 旧图片 run、历史项目、idempotency 和恢复测试不退化 |
| **P1：VIDEO 端到端** | `SaveVideo` history adapter、`/view` 媒体流式下载、Video 回填与连线；开放 MiniMax H3 I2V 的执行按钮 | **仅一次 POST /prompt**、保存完整 mp4、Video 节点可播放、断网后只恢复下载不再采样 |
| **P2：AUDIO + TEXT** | `SaveAudio`/音频 adapter、`SaveText` 或明确输出约定、对应资源节点 | 同一 executor 可跑音频或文本预设；空文本、长文本、多个文件均有确定语义 |
| **P3：混合多端口** | 同时捕获 IMAGE + VIDEO + AUDIO + TEXT；并集裁剪；逐项导入 | 一次 prompt 产出四类、保留各自 source port、缺项不虚报成功 |
| **P4：资源和回归** | 磁盘配额、Range、超时、adapter 插件契约与修复工具 | 大视频内存峰值受控；重启/错误/删除/重复导入/恶意路径测试通过 |

**必须具备的自动测试**：
1. 编译 4 个 root：只有 1 次 `/prompt`，图包含全部 capture sink；剪枝后不丢任何输出链。
2. SaveVideo 的 `history.outputs[saveId].images[]` 包含 `.mp4`：解为 `kind=video`，不再走图片签名检查。
3. 音频/文本适配器对不存在、不匹配的 `/object_info` 或 history 形状**明确报错**，不能出现静默成功。
4. 多文件 batch、同名不同端口、轮询重复和 worker 重启：artifactId 与画布节点均不重复。
5. `/prompt` 已到 Comfy 但响应丢失：`submission_unknown`，**不重投**；只允许用已保存 promptId 恢复 history。
6. 视频大文件边下载边 SHA-256 校验；中断后恢复 `collecting`，不再触发 GPU。
7. `status=succeeded` 但前端 IndexedDB 保存失败：仅修复导入，不降低服务器状态也不重新生成。
8. 四种节点创建正确、类型化溯源连线和老 Image 项目迁移正确；恶意文件名/超大文本/伪造 MIME 被拒绝。

## 11. 已确认的项目约束

当前 `service.mjs` 的 `upstream(expectBinary)` 将文件拼为 Buffer 并限制 40 MB，`collect()` 固定从 `images[]` 获取 PNG/JPEG/WebP；`compiler.mjs` 固定 `IMAGE/SaveImage`；`store.mjs` 把未知 MIME 默认当 webp 后缀；`project.tsx` 固定 `uploadImage` + `CanvasNodeType.Image`；前端 `run-client.ts` 只暂存 IMAGE 输入，另有 `Text` scalar。以上全部是**适配器边界**，无需复制 Comfy GPU 运行任务流程。

已读取实际 `workflows/video_minimax_h3_i2v_turbo.json`，输出链是 `105_91:CreateVideo[0] → 92:SaveVideo`，正适合优先以 **reuse-sink** 验证 VIDEO 路径。

参考：
- ComfyUI SaveVideo 官方说明：https://docs.comfy.org/zh-CN/built-in-nodes/SaveVideo
- ComfyUI SaveText 官方嵌入文档：https://github.com/Comfy-Org/embedded-docs/blob/main/comfyui_embedded_docs/docs/SaveText/en.md
- MiniMax H3 API 对 SaveVideo history 的实例说明：https://github.com/TheTerrasque/minimax-h3-frontend/blob/main/resources/COMFYUI_API_GUIDE.md

**结论**：改变的是 `capturing / materializing` 两侧，不是 `executing` 中间。四类产物应共享一个稳定的 `Run → ArtifactManifest[]` 协议，不要出现四条独立的 ComfyUI 后端执行链。
