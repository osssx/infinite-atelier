export { readStoryboardDraft } from "../../../server/canvas-text-content.mjs";

/** Shared contracts and dependency checks for the canvas drama pipeline. */
export const DRAMA_PIPELINE_STAGES = [
    "source",
    "assets",
    "asset_references",
    "episodes",
    "storyboard",
    "first_frames",
] as const;

export const DRAMA_PIPELINE_NODE_TYPES = Object.fromEntries(
    DRAMA_PIPELINE_STAGES.map(stage => [stage, `drama:${stage}`]),
) as Record<DramaPipelineStage, string>;

export function isInlineDramaNode(type: string) {
    return type === DRAMA_PIPELINE_NODE_TYPES.source ||
        type === DRAMA_PIPELINE_NODE_TYPES.assets || type === DRAMA_PIPELINE_NODE_TYPES.asset_references ||
        type === DRAMA_PIPELINE_NODE_TYPES.episodes || type === DRAMA_PIPELINE_NODE_TYPES.storyboard;
}

export const DRAMA_PIPELINE_STAGE_LABELS: Record<DramaPipelineStage, string> = {
    source: "故事",
    assets: "资产",
    asset_references: "资产参考图",
    episodes: "剧集规划",
    storyboard: "分镜配置",
    first_frames: "首帧渲染",
};

export const DRAMA_PIPELINE_STAGE_INPUTS: Record<DramaPipelineStage, DramaPipelineStage[]> = {
    source: [],
    assets: ["source"],
    asset_references: ["assets"],
    episodes: ["source"],
    storyboard: ["assets", "episodes"],
    first_frames: ["assets", "storyboard"],
};

export type DramaPipelineStage = typeof DRAMA_PIPELINE_STAGES[number];
export type DramaAssetKind = "character" | "scene" | "prop";

export type DramaAsset = {
    id: string;
    kind: DramaAssetKind;
    name: string;
    description: string;
    sourceRefs: string[];
    aliases?: string[];
    variants?: { id: string; name: string; description: string }[];
};

export function readAssetDraft(value: string) {
    let draft:Partial<DramaPipelineSnapshot>|null;
    try { draft=JSON.parse(value.trim().replace(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i, "$1")); } catch { return null; }
    if (!Array.isArray(draft?.assets) || !draft.assets.every(asset => asset &&
        ["character","scene","prop"].includes(asset.kind) && typeof asset.id === "string" &&
        typeof asset.name === "string" && typeof asset.description === "string" &&
        Array.isArray(asset.sourceRefs) && asset.sourceRefs.every(ref => typeof ref === "string") &&
        (asset.variants === undefined || (Array.isArray(asset.variants) && asset.variants.every(variant =>
            variant && typeof variant.id === "string" && typeof variant.name === "string" && typeof variant.description === "string"))))) return null;
    return draft as typeof draft & {assets: NonNullable<typeof draft.assets>};
}

export type DramaAssetReference = {
    assetId: string;
    variantId?: string;
    imageStorageKey?: string;
    imageStorageKeys?: string[];
    requiredForRendering: boolean;
};

export function dramaReferenceImageKeys(reference?: DramaAssetReference) {
    if (Array.isArray(reference?.imageStorageKeys)) return reference.imageStorageKeys;
    return reference?.imageStorageKey ? [reference.imageStorageKey] : [];
}

export function dramaAssetSlots(assets: readonly DramaAsset[]) {
    return assets.flatMap(asset => {
        const variants = asset.variants ?? [];
        // Base character IDs are selectable as the default appearance even
        // when outfits exist. Keep their image slot independent and optional
        // until a shot actually uses that base appearance.
        return [undefined, ...variants].map(variant => ({assetId:asset.id, variantId:variant?.id,
            requiredForRendering:asset.kind !== "prop" && !(asset.kind === "character" && variants.length > 0 && !variant)}));
    });
}

export function referencesForDramaAssets(assets: readonly DramaAsset[], references: readonly DramaAssetReference[]) {
    return dramaAssetSlots(assets).flatMap(slot => {
        const previous = references.find(ref => ref.assetId === slot.assetId && ref.variantId === slot.variantId);
        return previous ? [{...slot,imageStorageKeys:dramaReferenceImageKeys(previous)}] : [];
    });
}

export type DramaShot = {
    id: string;
    episodeId: string;
    order: number;
    description: string;
    characterVariantIds: string[];
    sceneId?: string;
    sceneVariantId?: string;
    propIds: string[];
    keyPropIds: string[];
    shotSize?: string;
    camera?: string;
    action?: string;
    dialogue?: string;
    sequenceId?: string;
    durationSec?: number;
    sourceRefs?: string[];
};

export type DramaPipelineSnapshot = {
    version: 1;
    stage: DramaPipelineStage;
    revision: number;
    inputRevisions: Partial<Record<DramaPipelineStage, number>>;
    assets: DramaAsset[];
    references: DramaAssetReference[];
    shots: DramaShot[];
};

export function validateDramaShotReferences(
    shot: DramaShot,
    assets: readonly DramaAsset[],
): string[] {
    const byId = new Map(assets.map(asset => [asset.id, asset]));
    const errors: string[] = [];
    for (const id of shot.characterVariantIds) {
        const asset = assets.find(item => item.kind === "character" &&
            (item.id === id || item.variants?.some(variant => variant.id === id)));
        if (!asset) errors.push(`角色造型不存在: ${id}`);
    }
    if (shot.sceneId && !byId.has(shot.sceneId)) errors.push(`场景不存在: ${shot.sceneId}`);
    if (shot.sceneVariantId && !assets.some(item => item.kind === "scene" &&
        item.variants?.some(variant => variant.id === shot.sceneVariantId))) {
        errors.push(`场景变体不存在: ${shot.sceneVariantId}`);
    }
    for (const id of shot.propIds) {
        if (byId.get(id)?.kind !== "prop") errors.push(`道具不存在: ${id}`);
    }
    for (const id of shot.keyPropIds) {
        if (!shot.propIds.includes(id)) errors.push(`关键道具未关联到镜头: ${id}`);
    }
    return errors;
}

export function missingDramaShotReferences(
    shot: DramaShot,
    assets: readonly DramaAsset[],
    references: readonly DramaAssetReference[],
): string[] {
    const ids = [...shot.characterVariantIds];
    if (shot.sceneVariantId) ids.push(shot.sceneVariantId);
    else if (shot.sceneId) ids.push(shot.sceneId);
    ids.push(...shot.keyPropIds);
    const selected = new Set(references.filter(item => dramaReferenceImageKeys(item).length).map(item =>
        item.variantId ?? item.assetId));
    return [...new Set(ids)].filter(id => {
        const asset = assets.find(item => item.id === id || item.variants?.some(variant => variant.id === id));
        const referenceId = asset?.variants?.some(variant => variant.id === id) ? id : asset?.id ?? id;
        return !selected.has(referenceId);
    });
}

export function downstreamDramaStages(stage: DramaPipelineStage): DramaPipelineStage[] {
    const index = DRAMA_PIPELINE_STAGES.indexOf(stage);
    return DRAMA_PIPELINE_STAGES.slice(index + 1);
}
