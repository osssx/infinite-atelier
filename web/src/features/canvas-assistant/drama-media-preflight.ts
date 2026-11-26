import {modelOptionName,resolveModelChannel,resolveModelScript,type AiConfig} from "@/stores/use-config-store";
import {modelChannelProvider} from "@/features/backend-sync/model-channel-autoroute";
import {resolveMediaCapabilities,supportedMediaModes,supportedMediaParameters,validateMediaRequest} from "@/services/media-capabilities";
import type {DramaVideoInput} from "./drama-pipeline-media";
import {getComfyTemplate} from "@/features/comfy-workflow/template-registry";

const casKey=/^cas:[a-f0-9]{64}$/;
function assertDramaReferences(input:DramaVideoInput){
    const mode=input.mode??(input.referenceImages.length?"omni_reference":"text_to_video");
    const references=input.referenceImages;
    const required=mode==="text_to_video"?0:mode==="first_frame"?1:mode==="first_last_frame"?2:undefined;
    if(required!==undefined&&references.length!==required)
        throw Error("所选视频模式需要 "+required+" 张图片，实际为 "+references.length+" 张");
    if(mode==="omni_reference"&&!references.length)throw Error("资产参考图模式需要至少一张图片");
    if(references.some(item=>!item.storageKey||!casKey.test(item.storageKey)))
        throw Error("视频输入素材必须是已保存到本地的 CAS 图片");
    if(input.gridInput&&(mode!=="omni_reference"||references.length!==1))
        throw Error("分镜网格输入需要一张独立的 CAS 网格图片");
    return mode;
}
export async function prepareDramaProduction(input:DramaVideoInput,config:AiConfig):Promise<DramaVideoInput>{
    const mode=input.mode??(input.referenceImages.length?"omni_reference":"text_to_video");
    const selected=config.comfyWorkflowDefaults?.video;
    if(!selected){
        if(input.gridInput)throw Error("分镜网格输入仅支持声明了参考图端口的 ComfyUI 视频工作流");
        preflightDramaVideo(input,config);return input;
    }
    const template=await getComfyTemplate(selected.templateId,selected.templateRevision);
    if(!template?.mediaUseCase||template.mediaUseCase.channel!=="video")throw Error("默认视频工作流不可用");

    const mapping=template.mediaUseCase.modeBindings?.[mode];
    const capabilities=template.mediaUseCase.mediaCapabilities;
    if(!capabilities||!mapping||!capabilities.modes.some(item=>item.id===mode&&item.enabled))
        throw Error("默认视频工作流未声明所选输入模式，请在模板中配置媒体能力");
    assertDramaReferences(input);
    const parameters:Record<string,unknown>={};
    const overrides:Record<string,unknown>={};
    const comfyParameterPorts:NonNullable<DramaVideoInput["comfyParameterPorts"]>={};
    const declaration=capabilities.modes.find(item=>item.id===mode&&item.enabled);
    for(const parameter of declaration?.parameters??[]){
        const portId=mapping.parameterPorts?.[parameter.id];
        const port=template.ports.find(item=>item.id===portId);
        const desired=parameter.id==="duration_seconds"?(input.productionSnapshot?.durationSec??input.shot.durationSec):
            parameter.id==="aspect_ratio"?config.videoRatio:undefined;
        parameters[parameter.id]=desired??port?.defaultValue??parameter.defaultValue??parameter.fixedValue;
        if(desired!==undefined&&portId){
            // Capability enums and actual Comfy literal choices must agree. Do
            // not report ready when the compiler would reject the scalar.
            if(port?.choices&&!port.choices.some(choice=>Object.is(choice.value,desired))||
                port?.valueKind==="INT"&&!Number.isInteger(desired))
                throw Error("工作流输入预检失败 media_parameter_invalid");
            overrides[portId]=desired;
        }
        if(portId&&port?.inputBinding?.mode==="literal"&&(parameter.id==="duration_seconds"||parameter.id==="aspect_ratio"))comfyParameterPorts[parameter.id]=portId;
    }
    const errors=validateMediaRequest({mode,references:input.referenceImages.map((reference,index)=>({kind:"image",
        role:mode==="first_frame"?"first_frame":mode==="first_last_frame"?(index?"last_frame":"first_frame"):"reference_image",
        mimeType:reference.type})),parameters},resolveMediaCapabilities({mediaCapabilities:capabilities},{kind:"video"}));
    if(errors.length)throw Error("工作流输入预检失败 "+errors.map(item=>item.code+(item.role?" · "+item.role:"")).join("，"));
    const slots:Record<string,{nodeId:string}>={};
    input.referenceImages.forEach((reference,index)=>{
        const role=mode==="first_frame"?"first_frame":mode==="first_last_frame"?(index?"last_frame":"first_frame"):"reference_image";
        const portId=mapping.rolePorts?.[role]?.[mode==="omni_reference"?index:0];
        const port=template.ports.find(item=>item.id===portId);
        if(!portId||port?.direction!=="target"||port.valueKind!=="IMAGE"||slots[portId])
            throw Error("视频工作流缺少所选 "+role+" 图像端口绑定，不能创建不完整的视频配置");
        slots[portId]={nodeId:reference.id};
    });
    return {...input,comfyParameterPorts,comfyBinding:{...selected,mediaMode:mode,overrides,slots}};
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
    assertDramaReferences(input);
    if(mode==="omni_reference"&&!input.referenceImages.length)throw Error("资产参考图模式需要至少一张图片");
    const resolved=resolveMediaCapabilities(model,{kind:"video",supportedModes:supported,
        supportedParameters:supportedMediaParameters(executor)});
    const errors=validateMediaRequest({mode,references:input.referenceImages.map((reference,index)=>({
        kind:"image",role:mode==="first_frame"?"first_frame":mode==="first_last_frame"?
            (index?"last_frame":"first_frame"):"reference_image",mimeType:reference.type,
    })),parameters:{duration_seconds:input.productionSnapshot?.durationSec??input.shot.durationSec??(Number(config.videoSeconds)||6),
        aspect_ratio:config.videoRatio}},resolved);
    if(errors.length)throw Error("视频输入预检失败 "+errors.map(error=>error.code+(error.role?" · "+error.role:"")).join("，"));
}
