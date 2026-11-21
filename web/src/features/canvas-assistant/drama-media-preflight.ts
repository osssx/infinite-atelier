import {modelOptionName,resolveModelChannel,resolveModelScript,type AiConfig} from "@/stores/use-config-store";
import {modelChannelProvider} from "@/features/backend-sync/model-channel-autoroute";
import {resolveMediaCapabilities,supportedMediaModes,supportedMediaParameters,validateMediaRequest} from "@/services/media-capabilities";
import type {DramaVideoInput} from "./drama-pipeline-media";
import {getComfyTemplate} from "@/features/comfy-workflow/template-registry";

export async function prepareDramaProduction(input:DramaVideoInput,config:AiConfig):Promise<DramaVideoInput>{
    const selected=config.comfyWorkflowDefaults?.video;
    if(!selected){preflightDramaVideo(input,config);return input;}
    const template=await getComfyTemplate(selected.templateId,selected.templateRevision);
    if(!template?.mediaUseCase||template.mediaUseCase.channel!=="video")throw Error("默认视频工作流不可用");
    const mode=input.mode??(input.referenceImages.length?"omni_reference":"text_to_video");
    const capabilities=template.mediaUseCase.mediaCapabilities;
    const mapping=template.mediaUseCase.modeBindings?.[mode];
    if(!capabilities||!mapping)throw Error("默认视频工作流未声明所选输入模式，请在模板中配置媒体能力");
    const parameters:Record<string,unknown>={};
    const overrides:Record<string,unknown>={};
    const declaration=capabilities.modes.find(item=>item.id===mode&&item.enabled);
    for(const parameter of declaration?.parameters??[]){
        const portId=mapping.parameterPorts?.[parameter.id];
        const port=template.ports.find(item=>item.id===portId);
        const desired=parameter.id==="duration_seconds"?input.shot.durationSec:
            parameter.id==="aspect_ratio"?config.videoRatio:undefined;
        parameters[parameter.id]=desired??port?.defaultValue??parameter.defaultValue??parameter.fixedValue;
        if(desired!==undefined&&portId)overrides[portId]=desired;
    }
    const errors=validateMediaRequest({mode,references:input.referenceImages.map((reference,index)=>({kind:"image",
        role:mode==="first_frame"?"first_frame":mode==="first_last_frame"?(index?"last_frame":"first_frame"):"reference_image",
        mimeType:reference.type})),parameters},resolveMediaCapabilities({mediaCapabilities:capabilities},{kind:"video"}));
    if(errors.length)throw Error("工作流输入预检失败 "+errors.map(item=>item.code+(item.role?" · "+item.role:"")).join("，"));
    const slots:Record<string,{nodeId:string}>={};
    input.referenceImages.forEach((reference,index)=>{
        const role=mode==="first_frame"?"first_frame":mode==="first_last_frame"?(index?"last_frame":"first_frame"):"reference_image";
        const portId=mapping.rolePorts?.[role]?.[mode==="omni_reference"?index:0];
        if(portId)slots[portId]={nodeId:reference.id};
    });
    return {...input,comfyBinding:{...selected,mediaMode:mode,overrides,slots}};
}

export function preflightDramaVideo(input:DramaVideoInput,config:AiConfig){
    const channel=resolveModelChannel(config,config.videoModel);
    if(!channel)throw Error("请先配置视频模型渠道");
    const model=channel.models.find(model=>model.name===modelOptionName(config.videoModel));
    const provider=modelChannelProvider(channel,"video");
    if(!provider)throw Error("视频渠道格式暂不支持此生产入口");
    if(!model)throw Error("当前视频模型已从渠道移除");
    const executor={provider,kind:"video" as const,customScript:Boolean(resolveModelScript(config,config.videoModel))};
    const mode=input.mode??(input.referenceImages.length?"omni_reference":"text_to_video");
    const supported=supportedMediaModes(executor);
    if(!supported.includes(mode))throw Error("当前视频渠道不支持所选输入模式，请选择可用模式或更换模型");
    if(mode==="omni_reference"&&!input.referenceImages.length)throw Error("资产参考图模式需要至少一张图片");
    const resolved=resolveMediaCapabilities(model,{kind:"video",supportedModes:supported,
        supportedParameters:supportedMediaParameters(executor)});
    const errors=validateMediaRequest({mode,references:input.referenceImages.map((reference,index)=>({
        kind:"image",role:mode==="first_frame"?"first_frame":mode==="first_last_frame"?
            (index?"last_frame":"first_frame"):"reference_image",mimeType:reference.type,
    })),parameters:{duration_seconds:input.shot.durationSec??(Number(config.videoSeconds)||6),
        aspect_ratio:config.videoRatio}},resolved);
    if(errors.length)throw Error("视频输入预检失败 "+errors.map(error=>error.code+(error.role?" · "+error.role:"")).join("，"));
}
