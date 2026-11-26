import {modelOptionName,resolveModelChannel,resolveModelScript,type AiConfig} from "@/stores/use-config-store";
import {modelChannelProvider} from "@/features/backend-sync/model-channel-autoroute";
import {resolveMediaCapabilities,supportedMediaModes,supportedMediaParameters} from "@/services/media-capabilities";
import {getComfyTemplate} from "@/features/comfy-workflow/template-registry";
import type {DramaShotProduction,DramaVideoInput} from "./drama-pipeline-media";
import {prepareDramaProduction} from "./drama-media-preflight";
import {resolveDramaVideoTarget,resolveDramaVideoProduction} from "./drama-video-production-resolver";
import type {MediaParameterSpec} from "@/services/media-capabilities";

export const dramaMediaModes=[
    {id:"text_to_video",label:"纯文本"},
    {id:"first_frame",label:"首帧"},
    {id:"first_last_frame",label:"首尾帧"},
    {id:"omni_reference",label:"资产参考图"},
    {id:"grid",label:"分镜网格参考图"},
] as const;
export type DramaMediaModeChoice = typeof dramaMediaModes[number]["id"];
export type DramaProductionModeState={mode:DramaMediaModeChoice;label:string;available:boolean;reason?:string;parameters?:MediaParameterSpec[]};
export type DramaProductionCapabilities={engine:"comfy"|"online";channel:string;model:string;modes:DramaProductionModeState[]};
export type DramaProductionAudit={ready:boolean;input?:DramaVideoInput;error?:string;
    mode:DramaMediaModeChoice;durationSeconds:number;aspectRatio:string;referenceCount:number;
    referenceKeys:string[];missingReferenceIds:string[];prompt:string;engine:string;sourceRevisionId?:string};

const fail=(error:unknown)=>error instanceof Error?error.message:String(error);
/** Reads declared capabilities only. This does not execute a model, mutate a
 * graph or submit any media jobs. Legacy channels are limited by their executor.
 */
export async function listDramaProductionCapabilities(globalConfig:AiConfig,setting?:DramaShotProduction):Promise<DramaProductionCapabilities>{
    let config=globalConfig;
    if(setting?.target&&setting.target.kind!=="inherit"){
        try{config=resolveDramaVideoTarget(globalConfig,setting).config;}
        catch(error){return {engine:setting.target.kind==="comfy"?"comfy":"online",channel:"未配置",model:"",modes:dramaMediaModes.map(item=>({mode:item.id,label:item.label,available:false,reason:fail(error)}))};}
    }
    const comfy=config.comfyWorkflowDefaults?.video;
    let allowed:string[]=[],name="",engine:"online"|"comfy"="online",unavailable="";
    const parameters=new Map<string,MediaParameterSpec[]>();
    if(comfy){
        engine="comfy";
        const template=await getComfyTemplate(comfy.templateId,comfy.templateRevision);
        name=template?.name??"工作流不可用";
        if(!template?.mediaUseCase||template.mediaUseCase.channel!=="video")
            unavailable="默认 ComfyUI 视频工作流不存在或不是视频模板";
        else{
            const resolved=resolveMediaCapabilities({mediaCapabilities:template.mediaUseCase.mediaCapabilities},{kind:"video"});
            if(!resolved.explicit||resolved.unavailable.length)unavailable="视频模板缺少有效的媒体能力声明";
            else {
                const modes=resolved.modes.filter(mode=>template.mediaUseCase?.modeBindings?.[mode.id as keyof typeof template.mediaUseCase.modeBindings]);
                allowed=modes.map(mode=>mode.id);
                for(const mode of modes){
                    const binding=template.mediaUseCase.modeBindings?.[mode.id as keyof typeof template.mediaUseCase.modeBindings];
                    parameters.set(mode.id,mode.parameters.filter(spec=>binding?.parameterPorts?.[spec.id]&&
                        template.ports.some(port=>port.id===binding.parameterPorts?.[spec.id]&&port.direction==="target"&&port.inputBinding?.mode==="literal")) as MediaParameterSpec[]);
                }
            }
        }
    }else{
        const channel=resolveModelChannel(config,config.videoModel);
        const model=channel?.models.find(value=>value.name===modelOptionName(config.videoModel));
        const provider=channel&&modelChannelProvider(channel,"video");
        name=model?.name??"视频模型不可用";
        if(!channel||!provider||!model)unavailable="视频渠道或模型未配置";
        else{
            const executor={provider,kind:"video" as const,customScript:Boolean(resolveModelScript(config,config.videoModel))};
            const modes=supportedMediaModes(executor);
            const resolved=resolveMediaCapabilities(model,{kind:"video",supportedModes:modes,
                supportedParameters:supportedMediaParameters(executor)});
            if(resolved.explicit&&resolved.unavailable.some((item:unknown)=>typeof item==="object"&&item!==null&&"code" in item&&item.code==="media_capability_invalid"))
                unavailable="视频模型媒体能力声明不合法";
            else {allowed=resolved.explicit?resolved.modes.map(mode=>mode.id):modes;
                if(resolved.explicit)for(const mode of resolved.modes)parameters.set(mode.id,mode.parameters as MediaParameterSpec[]);
            }
        }
    }
    const modes=dramaMediaModes.map(({id,label})=>{
        const base=id==="grid"?"omni_reference":id;
        const available=!unavailable&&allowed.includes(base)&&(id!=="grid"||engine==="comfy");
        const reason=available?undefined:unavailable||(id==="grid"&&engine!=="comfy"?
            "分镜网格输入只允许声明了参考图端口的 ComfyUI 视频模板":
            "当前模型或工作流不支持此输入模式（未声明对应媒体能力）");
        return {mode:id,label,available,reason,parameters:available?parameters.get(base):undefined};
    });
    return {engine,channel:comfy?"本地 ComfyUI":resolveModelChannel(config,config.videoModel)?.name??"未配置",
        model:name,modes};
}
/** Full preview of the exact input passed to Config creation. The snapshot
 * contains only CAS keys, prompt and production metadata, never image bytes.
 * The model is never called in this phase.
 */
export async function auditDramaProduction(input:DramaVideoInput,config:AiConfig,
 {setting,missingReferenceIds=[],visualStyle,sourceRevisionId}:{
    setting?:DramaShotProduction;missingReferenceIds?:string[];
    visualStyle?:string;sourceRevisionId?:string;
 }={}):Promise<DramaProductionAudit>{
    const mode:DramaMediaModeChoice=setting?.gridInput?"grid":input.mode??"text_to_video";
    const durationSeconds=setting?.durationSec??input.shot.durationSec??(Number(config.videoSeconds)||6);
    const keys=input.referenceImages.flatMap(item=>item.storageKey?[item.storageKey]:[]);
    const base={mode,durationSeconds,aspectRatio:setting?.aspectRatio??config.videoRatio,referenceCount:keys.length,
        referenceKeys:keys,missingReferenceIds,sourceRevisionId,
        prompt:setting?.promptOverride?.text??(input.prompt+(visualStyle?"\n影片风格："+visualStyle:"")),engine:""};
    try{
        const resolved=resolveDramaVideoProduction(input,config,setting,visualStyle,sourceRevisionId);
        const capabilities=await listDramaProductionCapabilities(resolved.config);
        const selected=capabilities.modes.find(item=>item.mode===mode);
        if(!selected?.available)throw Error(selected?.reason??"当前模式不可用");
        if(mode==="omni_reference"&&missingReferenceIds.length)
            throw Error("缺少所选角色/场景/关键道具的参考图："+missingReferenceIds.join("、"));
        if(!Number.isFinite(durationSeconds)||durationSeconds<=0)throw Error("镜头时长必须大于零");
        const prepared=await prepareDramaProduction(resolved.input,resolved.config);
        return {...base,engine:capabilities.engine,referenceCount:prepared.referenceImages.length,
            referenceKeys:prepared.referenceImages.flatMap(item=>item.storageKey?[item.storageKey]:[]),
            prompt:resolved.snapshot.prompt,input:prepared,ready:true};
    }catch(error){return {...base,ready:false,error:fail(error)};}
}
