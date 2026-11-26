import type { ReferenceImage } from "@/types/image";
import type { DramaAsset, DramaAssetReference, DramaPipelineSnapshot, DramaShot } from "./canvas-drama-pipeline";
import { dramaReferenceImageKeys } from "./canvas-drama-pipeline";

export type DramaVideoTarget={kind:"inherit"}|{kind:"online";modelOption:string}|{kind:"comfy";templateId:string;templateRevision:string};
export type DramaPromptOverride={text:string;sourceFingerprint:string};
export type ResolvedDramaVideoTarget=Exclude<DramaVideoTarget,{kind:"inherit"}>;
export type DramaVideoProductionSnapshot={
    target:ResolvedDramaVideoTarget;prompt:string;durationSec:number;aspectRatio:string;
    sourceRevisionId?:string;settingFingerprint:string;promptSourceFingerprint:string;manualPrompt:boolean;
};

export type DramaVideoInput = {
    shot: DramaShot;
    prompt: string;
    referenceImages: ReferenceImage[];
    mode?: "text_to_video"|"first_frame"|"first_last_frame"|"omni_reference";
    /** Explicit user-provided storyboard grid image, never inferred from a regular reference. */
    gridInput?:boolean;
    comfyBinding?: NonNullable<import("@/types/canvas").CanvasNodeMetadata["comfyMediaPreset"]>;
    productionSnapshot?:DramaVideoProductionSnapshot;
};
export type DramaShotProduction = {mode:NonNullable<DramaVideoInput["mode"]>;firstFrame?:string;lastFrame?:string;gridInput?:boolean;gridImage?:string;target?:DramaVideoTarget;promptOverride?:DramaPromptOverride;durationSec?:number;aspectRatio?:string};

export function applyDramaProduction(input:DramaVideoInput,settings?:DramaShotProduction):DramaVideoInput{
    if(!settings)return input;
    if(settings.gridInput){
        if(!settings.gridImage||!/^cas:[a-f0-9]{64}$/.test(settings.gridImage))throw Error("请先选择分镜网格图");
        return {...input,gridInput:true,mode:"omni_reference",prompt:input.prompt+"\n参考图是一张分镜网格。按从左到右、从上到下的顺序展开连续镜头，输出完整连续视频画面。",
            referenceImages:[{id:`${input.shot.id}-grid`,name:"分镜网格",type:"image/png",dataUrl:"",storageKey:settings.gridImage}]};
    }
    if(settings.mode==="text_to_video")return {...input,gridInput:false,mode:settings.mode,referenceImages:[]};
    if(settings.mode==="omni_reference")return {...input,gridInput:false,mode:settings.mode};
    const keys=settings.mode==="first_frame"?[settings.firstFrame]:[settings.firstFrame,settings.lastFrame];
    if(keys.some(key=>!key||!/^cas:[a-f0-9]{64}$/.test(key)))throw Error("请先绑定所需首帧和尾帧");
    if(new Set(keys).size!==keys.length)throw Error("首帧和尾帧需要选择不同图片");
    return {...input,gridInput:false,mode:settings.mode,referenceImages:keys.map((storageKey,index)=>({
        id:`${input.shot.id}-frame-${index}`,name:index?"尾帧":"首帧",type:"image/png",dataUrl:"",storageKey,
    }))};
}

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
