/** Server-side validation for the canvas drama production pipeline.
 *
 * The canvas keeps the editable draft. This module is deliberately pure so
 * the API, job submitters and import/restore checks share the same rules.
 */
export const DRAMA_PIPELINE_STAGES = [
  "source", "assets", "asset_references", "episodes", "storyboard", "first_frames",
];
export const DRAMA_PIPELINE_STAGE_INPUTS = {
  source: [], assets: ["source"], asset_references: ["assets"], episodes: ["source"],
  storyboard: ["assets", "episodes"], first_frames: ["asset_references", "storyboard"],
};
const ASSET_KINDS = new Set(["character", "scene", "prop"]);
const fail = (code, statusCode = 400) => Object.assign(Error(code), {code, statusCode});
const text = (value, max = 50000) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function assetErrors(assets) {
  const errors = [];
  const seen = new Set();
  const variantIds = new Set(assets.map(asset => asset?.id).filter(id));
  for (const asset of assets) {
    if (!asset || !id(asset.id) || seen.has(asset.id) || !ASSET_KINDS.has(asset.kind) ||
      !text(asset.name, 240) || !text(asset.description, 20000) ||
      !Array.isArray(asset.sourceRefs) || asset.sourceRefs.length > 64 ||
      !asset.sourceRefs.every(ref => text(ref, 256))) {
      errors.push({code: "asset_invalid", id: asset?.id ?? null});
      continue;
    }
    seen.add(asset.id);
    const variants = asset.variants ?? [];
    if (!Array.isArray(variants) || variants.length > 32 || variants.some(v =>
      !v || !id(v.id) || !text(v.name, 240) || !text(v.description, 20000))) {
      errors.push({code: "asset_variant_invalid", id: asset.id});
      continue;
    }
    for (const variant of variants) {
      if (variantIds.has(variant.id)) errors.push({code: "asset_variant_duplicate", id: variant.id});
      variantIds.add(variant.id);
    }
  }
  return errors;
}

function referenceErrors(references, assets) {
  const errors = [];
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const variantOwner = new Map(assets.flatMap(asset => (asset.variants ?? []).map(v => [v.id, asset])));
  const seen = new Set();
  for (const ref of references) {
    const key = ref?.variantId ?? ref?.assetId;
    const owner = ref?.variantId ? variantOwner.get(ref.variantId) : byId.get(ref?.assetId);
    if (!ref || !id(ref.assetId) || seen.has(key) || !owner ||
      (ref.variantId !== undefined && (!id(ref.variantId) || !variantOwner.has(ref.variantId) || variantOwner.get(ref.variantId)?.id !== ref.assetId)) ||
      (ref.imageStorageKey !== undefined && !text(ref.imageStorageKey, 512)) ||
      typeof ref.requiredForRendering !== "boolean") {
      errors.push({code: "asset_reference_invalid", id: key ?? null});
      continue;
    }
    seen.add(key);
  }
  return errors;
}

function shotErrors(shots, assets) {
  const errors = [];
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const variantOwner = new Map(assets.flatMap(asset => (asset.variants ?? []).map(v => [v.id, asset])));
  const seen = new Set();
  for (const shot of shots) {
    if (!shot || !id(shot.id) || seen.has(shot.id) || !id(shot.episodeId) ||
      !Number.isSafeInteger(shot.order) || shot.order < 0 || !text(shot.description, 20000) ||
      !Array.isArray(shot.characterVariantIds) || !Array.isArray(shot.propIds) ||
      !Array.isArray(shot.keyPropIds)) {
      errors.push({code: "shot_invalid", id: shot?.id ?? null});
      continue;
    }
    seen.add(shot.id);
    for (const variantId of shot.characterVariantIds) {
      const owner = variantOwner.get(variantId);
      if (!owner || owner.kind !== "character") errors.push({code: "shot_character_invalid", shotId: shot.id, id: variantId});
    }
    if (shot.sceneId !== undefined && (byId.get(shot.sceneId)?.kind !== "scene")) errors.push({code: "shot_scene_invalid", shotId: shot.id, id: shot.sceneId});
    if (shot.sceneVariantId !== undefined && (variantOwner.get(shot.sceneVariantId)?.kind !== "scene" || variantOwner.get(shot.sceneVariantId)?.id !== shot.sceneId)) errors.push({code: "shot_scene_variant_invalid", shotId: shot.id, id: shot.sceneVariantId});
    for (const propId of shot.propIds) if (byId.get(propId)?.kind !== "prop") errors.push({code: "shot_prop_invalid", shotId: shot.id, id: propId});
    for (const propId of shot.keyPropIds) if (!shot.propIds.includes(propId)) errors.push({code: "shot_key_prop_unlinked", shotId: shot.id, id: propId});
  }
  return errors;
}

export function validateDramaPipelineSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !DRAMA_PIPELINE_STAGES.includes(snapshot.stage) ||
    !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 ||
    !Array.isArray(snapshot.assets) || !Array.isArray(snapshot.references) || !Array.isArray(snapshot.shots)) {
    throw fail("drama_pipeline_snapshot_invalid");
  }
  const errors = assetErrors(snapshot.assets);
  if (errors.length) return {valid: false, errors};
  errors.push(...referenceErrors(snapshot.references, snapshot.assets), ...shotErrors(snapshot.shots, snapshot.assets));
  if (errors.length) return {valid: false, errors};
  if (snapshot.stage === "first_frames") {
    const refs = new Set(snapshot.references.filter(item => item.imageStorageKey).map(item => item.variantId ?? item.assetId));
    const variantOwner = new Map(snapshot.assets.flatMap(asset => (asset.variants ?? []).map(v => [v.id, asset])));
    for (const shot of snapshot.shots) {
      const required = [...shot.characterVariantIds, ...(shot.sceneVariantId ? [shot.sceneVariantId] : shot.sceneId ? [shot.sceneId] : []), ...shot.keyPropIds];
      for (const item of required) if (!refs.has(item)) errors.push({code: "render_reference_missing", shotId: shot.id, id: item, kind: variantOwner.get(item)?.kind ?? snapshot.assets.find(a => a.id === item)?.kind});
    }
  }
  return {valid: errors.length === 0, errors};
}

export function normalizeDramaPipelineSnapshot(snapshot) {
  const result = validateDramaPipelineSnapshot(snapshot);
  if (!result.valid) throw fail("drama_pipeline_snapshot_invalid", 422);
  return JSON.parse(JSON.stringify(snapshot));
}

/** Build the bounded user prompt used by the dedicated stage endpoint. */
export function buildDramaStagePrompt({stage, sourceText = "", targetEpisodes = 1, context = ""} = {}) {
  if (!DRAMA_PIPELINE_STAGES.includes(stage) || stage === "source" || stage === "asset_references" || stage === "first_frames") {
    throw fail("drama_pipeline_stage_not_text_generable");
  }
  if (!text(sourceText, 98304) && !text(context, 48000)) throw fail("drama_pipeline_source_required");
  const numberedSource = sourceText.split(/\r?\n/).map((line, index) => line.trim() ? `[p${index + 1}] ${line}` : "").join("\n");
  const input = [sourceText && `<source>\n${numberedSource}\n</source>`, context && `<confirmed-context>\n${context}\n</confirmed-context>`].filter(Boolean).join("\n");
  const instructions = {
    assets: "提取角色、场景和道具资产。每项给出稳定的短名称、可用于绘图的完整描述、原文段落引用。角色补充关系和造型变体，场景补充地点、时间天气变体，道具标记关键道具。",
    episodes: `把剧情事件重排为恰好 ${Math.max(1, Math.min(100, Number(targetEpisodes) || 1))} 集。每集给出梗概、有序事件、原文段落引用和结尾。不要删掉关键事件。`,
    storyboard: "为确认的剧集生成可编辑镜头表。每镜给出稳定镜头编号、景别、机位或运镜、地点、动作、对白、出镜角色造型、可见道具和原文段落引用。",
  }[stage];
  const shapes = {
    assets: '{"assets":[{"id":"character_1","kind":"character","name":"名称","description":"完整外观","sourceRefs":["p1"],"variants":[{"id":"outfit_1","name":"默认造型","description":"造型描述"}]}]}',
    episodes: '{"episodes":[{"id":"ep_1","title":"标题","synopsis":"梗概","events":["事件"],"sourceRefs":["p1"],"ending":"结尾"}]}',
    storyboard: '{"shots":[{"id":"shot_1","episodeId":"ep_1","order":1,"description":"自包含首帧画面描述","shotSize":"景别","camera":"机位或运镜","action":"动作","dialogue":"对白","sourceRefs":["p1"],"characterVariantIds":["outfit_1"],"sceneId":"scene_1","propIds":[],"keyPropIds":[]}]}',
  };
  return `你是短剧制作流水线助手。只依据资料创作，输出一个 JSON 对象，不要使用 Markdown。所有 ID 全局唯一且只含英文字母、数字、下划线或短横线。每个角色都应有至少一个造型。分镜复用上下文中的集、造型、场景和道具 ID；无场景时省略 sceneId，无变体时省略 sceneVariantId；关键道具必须出现在 propIds 中。段落出处使用输入中的 p 编号。\n${instructions}\n结构示例：${shapes[stage]}\n${input}`;
}
