import bundledKrea2Workflow from "../../../../workflows/image_krea2_turbo_t2i_int8.json";
import {
    templatePayloadFromGraph,
    validateComfyApiGraph,
    type ComfyApiGraph,
    type ComfyTemplatePayload,
    type ComfyTemplatePort,
} from "./template-schema";

export const KREA2_TURBO_TEMPLATE_ID = "image-krea2-turbo-t2i-int8";

/**
 * These IDs are verified against the actual workflow checked into /workflows/.
 * In particular ResolutionSelector(49) is disconnected: don't offer it as an
 * operative resolution parameter. Actual sampling dimensions are 30:5.width/height.
 */
export function isKrea2TurboT2IWorkflow(graph: ComfyApiGraph): boolean {
    return graph["30:10"]?.class_type === "UNETLoader" &&
        graph["30:10"].inputs.unet_name === "krea2_turbo_int8_convrot.safetensors" &&
        graph["55"]?.class_type === "PrimitiveStringMultiline" &&
        graph["30:3"]?.class_type === "KSampler" &&
        graph["30:5"]?.class_type === "EmptyLatentImage" &&
        graph["30:8"]?.class_type === "VAEDecode" &&
        graph["29"]?.class_type === "SaveImage" &&
        Array.isArray(graph["29"].inputs.images) &&
        graph["29"].inputs.images[0] === "30:8" &&
        graph["29"].inputs.images[1] === 0;
}

const scalar = (
    id: string, label: string, kind: "STRING"|"INT"|"FLOAT"|"BOOLEAN",
    nodeId: string, inputName: string, required = false,
): ComfyTemplatePort => ({
    id, label, direction:"target", valueKind:kind, required,
    inputBinding:{mode:"literal",targets:[{nodeId,inputName}]},
    absentPolicy:{mode:"keep-template"},
});

/** No changes to the Comfy graph, including the system prompt and model/LoRA paths. */
export function buildKrea2TurboTemplate(graphInput:unknown):ComfyTemplatePayload {
    const graph = validateComfyApiGraph(graphInput);
    if(!isKrea2TurboT2IWorkflow(graph)) throw new Error("This file is not the supported Krea 2 Turbo INT8 API-format workflow");
    const payload = templatePayloadFromGraph("Krea 2 Turbo INT8 · Text to Image",graph);
    payload.ports = [
        scalar("prompt","提示词","STRING","55","value",true),
        scalar("width","宽度","INT","30:5","width"),
        scalar("height","高度","INT","30:5","height"),
        scalar("seed","随机种子","INT","30:3","seed"),
        scalar("steps","采样步数","INT","30:3","steps"),
        scalar("cfg","CFG","FLOAT","30:3","cfg"),
        scalar("batch_size","批量数量","INT","30:5","batch_size"),
        scalar("refine_prompt","提示词增强","BOOLEAN","30:24","value"),
        scalar("enable_lora","启用附加 LoRA","BOOLEAN","30:23","value"),
        scalar("lora_strength","LoRA 强度","FLOAT","30:15","strength_model"),
        scalar("refine_temperature","增强温度","FLOAT","30:16","sampling_mode.temperature"),
        {
            id:"image",label:"生成图像",direction:"source",valueKind:"IMAGE",
            outputBinding:{nodeId:"30:8",outputIndex:0},
            capture:{kind:"image",adapterId:"SaveImage"},
        },
    ];
    payload.requirements.modelAssets = [...new Set(
        Object.values(graph).flatMap((node)=>
            Object.entries(node.inputs).filter(([name])=>["unet_name","clip_name","vae_name","lora_name"].includes(name))
                .map(([,name])=>name).filter((name):name is string=>typeof name==="string"),
        ),
    )].sort();
    return payload;
}

/** Used by one-click preset and when re-importing the original user workflow. */
export function krea2TurboBundledTemplate():ComfyTemplatePayload {
    return buildKrea2TurboTemplate(bundledKrea2Workflow);
}
