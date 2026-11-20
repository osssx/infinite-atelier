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

export const DRAMA_PIPELINE_STAGE_LABELS: Record<DramaPipelineStage, string> = {
    source: "原文",
    assets: "资产规划",
    asset_references: "资产参考图",
    episodes: "剧集规划",
    storyboard: "分镜表",
    first_frames: "首帧渲染",
};

export const DRAMA_PIPELINE_STAGE_INPUTS: Record<DramaPipelineStage, DramaPipelineStage[]> = {
    source: [],
    assets: ["source"],
    asset_references: ["assets"],
    episodes: ["source"],
    storyboard: ["assets", "episodes"],
    first_frames: ["asset_references", "storyboard"],
};

export type DramaPipelineStage = typeof DRAMA_PIPELINE_STAGES[number];
export type DramaAssetKind = "character" | "scene" | "prop";

export type DramaAsset = {
    id: string;
    kind: DramaAssetKind;
    name: string;
    description: string;
    sourceRefs: string[];
    variants?: { id: string; name: string; description: string }[];
};

export type DramaAssetReference = {
    assetId: string;
    variantId?: string;
    imageStorageKey?: string;
    requiredForRendering: boolean;
};

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
    const selected = new Set(references.filter(item => item.imageStorageKey).map(item =>
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
