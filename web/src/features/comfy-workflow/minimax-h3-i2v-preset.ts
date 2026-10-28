import videoWorkflow from "../../../../workflows/video_minimax_h3_i2v_turbo.json";
import {
    templatePayloadFromGraph, validateComfyApiGraph,
    type ComfyApiGraph, type ComfyTemplatePayload, type ComfyTemplatePort,
} from "./template-schema";

export const MINIMAX_H3_I2V_TEMPLATE_ID = "video-minimax-h3-i2v-turbo";

/** The exact node IDs of the user-supplied MiniMax H3 I2V Turbo API workflow. */
export function isMiniMaxH3I2VWorkflow(graph:ComfyApiGraph):boolean {
    return graph["105_104"]?.class_type==="MiniMaxH3ImageToVideo" &&
        graph["114"]?.class_type==="LoadImage" &&
        graph["115"]?.class_type==="ResolutionSelector" &&
        graph["128"]?.class_type==="PrimitiveFloat" &&
        graph["105_91"]?.class_type==="CreateVideo" &&
        graph["92"]?.class_type==="SaveVideo" &&
        Array.isArray(graph["92"].inputs.video) &&
        graph["92"].inputs.video[0]==="105_91" &&
        graph["92"].inputs.video[1]===0 &&
        Array.isArray(graph["105_104"].inputs.first_frame) &&
        graph["105_104"].inputs.first_frame[0]==="114" &&
        graph["105_104"].inputs.first_frame[1]===0;
}

function scalar(id:string,label:string,kind:"STRING"|"INT"|"FLOAT"|"BOOLEAN",
    nodeId:string,inputName:string,required=false):ComfyTemplatePort {
    return {id,label,direction:"target",valueKind:kind,required,
        inputBinding:{mode:"literal",targets:[{nodeId,inputName}]},
        absentPolicy:{mode:"keep-template"}};
}

/** Only bindings are added; the API graph and model paths are kept byte-equivalent. */
export function buildMiniMaxH3I2VPreset(raw:unknown):ComfyTemplatePayload {
    const graph=validateComfyApiGraph(raw);
    if(!isMiniMaxH3I2VWorkflow(graph))
        throw new Error("This file is not the supported MiniMax H3 I2V Turbo API workflow");
    const payload=templatePayloadFromGraph("MiniMax H3 I2V Turbo · 图生视频",graph);
    payload.ports=[
        {
            id:"first_frame",label:"首帧图片",direction:"target",valueKind:"IMAGE",required:false,
            inputBinding:{mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId:"114",inputName:"image"}]},
            absentPolicy:{mode:"auto-prune"},
        },
        scalar("prompt","视频提示词","STRING","105_104","prompt",true),
        scalar("duration","视频时长（秒）","FLOAT","128","value"),
        scalar("aspect_ratio","画面比例","STRING","115","aspect_ratio"),
        scalar("megapixels","画面大小（MP）","FLOAT","115","megapixels"),
        scalar("seed","随机种子","INT","105_15","noise_seed"),
        scalar("lightning","启用 Lightning LoRA","BOOLEAN","105_126","value"),
        scalar("steps","常规步数","INT","105_124","value"),
        scalar("lightning_steps","Lightning 步数","INT","105_125","value"),
        scalar("lora_strength","LoRA 强度","FLOAT","105_121","strength_model"),
        scalar("fps","视频帧率","INT","105_91","fps"),
        {
            id:"video",label:"生成视频",direction:"source",valueKind:"VIDEO",
            outputBinding:{nodeId:"105_91",outputIndex:0},
            capture:{kind:"video",adapterId:"SaveVideo"},
        },
    ];
    payload.requirements.modelAssets=[...new Set(Object.values(graph)
        .flatMap(node=>Object.entries(node.inputs)
            .filter(([key])=>["unet_name","clip_name","vae_name","lora_name"].includes(key))
            .map(([,value])=>value).filter((value):value is string=>typeof value==="string")))].sort();
    return payload;
}

export function minimaxH3I2VBundledTemplate():ComfyTemplatePayload {
    return buildMiniMaxH3I2VPreset(videoWorkflow);
}
