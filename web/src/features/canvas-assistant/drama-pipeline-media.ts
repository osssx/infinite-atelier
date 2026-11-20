import type { ReferenceImage } from "@/types/image";
import type { DramaAsset, DramaAssetReference, DramaPipelineSnapshot, DramaShot } from "./canvas-drama-pipeline";
import { dramaReferenceImageKeys } from "./canvas-drama-pipeline";

export type DramaVideoInput = {
    shot: DramaShot;
    prompt: string;
    referenceImages: ReferenceImage[];
};

function assetForId(assets: readonly DramaAsset[], id: string) {
    return assets.find(asset => asset.id === id || asset.variants?.some(variant => variant.id === id));
}

function refForId(references: readonly DramaAssetReference[], assets: readonly DramaAsset[], id: string) {
    const asset = assetForId(assets, id);
    if (!asset) return undefined;
    const variant = asset.variants?.find(item => item.id === id);
    return references.find(reference => reference.assetId === asset.id &&
        (variant ? reference.variantId === variant.id : !reference.variantId));
}

/** Converts the confirmed asset references used by a shot into trusted image
 * inputs for startSqliteModelGeneration. Data URLs are intentionally omitted.
 */
export function buildDramaVideoInput(snapshot: DramaPipelineSnapshot, shot: DramaShot): DramaVideoInput {
    const ids = [...shot.characterVariantIds,
        ...(shot.sceneVariantId ? [shot.sceneVariantId] : shot.sceneId ? [shot.sceneId] : []),
        ...shot.propIds];
    const seen = new Set<string>();
    const referenceImages: ReferenceImage[] = [];
    for (const id of ids) {
        const reference = refForId(snapshot.references, snapshot.assets, id);
        for (const storageKey of dramaReferenceImageKeys(reference)) {
            if (seen.has(storageKey)) continue;
            seen.add(storageKey);
            referenceImages.push({
                id: `${shot.id}-${id}-${referenceImages.length + 1}`,
                name: assetForId(snapshot.assets, id)?.name ?? id,
                type: "image/png",
                dataUrl: "",
                storageKey,
            });
        }
    }
    const propDescriptions = shot.propIds.flatMap(id => {
        const prop = assetForId(snapshot.assets, id);
        return prop ? [`${prop.name}：${prop.description}`] : [];
    });
    const prompt = [shot.description, propDescriptions.length ? `可见道具：${propDescriptions.join("；")}` : ""].filter(Boolean).join("\n");
    return {
        shot,
        referenceImages,
        prompt: [
            prompt,
            shot.shotSize?.trim() && `景别：${shot.shotSize}`,
            shot.camera?.trim() && `机位 / 运镜：${shot.camera}`,
            shot.action?.trim() && `动作：${shot.action}`,
            shot.dialogue?.trim() && `对白：${shot.dialogue}`,
        ].filter(Boolean).join("\n"),
    };
}

export function dramaVideoMissingReferenceIds(snapshot: DramaPipelineSnapshot, shot: DramaShot): string[] {
    const ids = [...shot.characterVariantIds,
        ...(shot.sceneVariantId ? [shot.sceneVariantId] : shot.sceneId ? [shot.sceneId] : []),
        ...shot.keyPropIds];
    return ids.filter(id => !dramaReferenceImageKeys(refForId(snapshot.references, snapshot.assets, id)).length);
}
