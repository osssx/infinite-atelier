import {decodeChannelModel,encodeChannelModel,modelOptionName,resolveModelChannel,type AiConfig} from "@/stores/use-config-store";
import type {DramaShotProduction,DramaVideoInput,DramaVideoProductionSnapshot,ResolvedDramaVideoTarget} from "./drama-pipeline-media";

// Only execution-relevant, non-secret data is retained in the prepared input.
// Existing unqualified default models are canonicalized to their actual channel.
export function resolveDramaVideoTarget(config:AiConfig,setting?:DramaShotProduction):{config:AiConfig;target:ResolvedDramaVideoTarget}{
 const chosen=setting?.target;
 const workflow=chosen?.kind==="comfy"?chosen:chosen?.kind==="online"?undefined:config.comfyWorkflowDefaults?.video;
 if(chosen&& !["inherit","online","comfy"].includes(chosen.kind))throw Error("视频渠道配置无效");
 if(workflow){
  if(!workflow.templateId||!workflow.templateRevision)throw Error("请选择有效的视频工作流");
  const target={kind:"comfy" as const,templateId:workflow.templateId,templateRevision:workflow.templateRevision};
  return {target,config:{...config,comfyWorkflowDefaults:{...config.comfyWorkflowDefaults,video:{templateId:target.templateId,templateRevision:target.templateRevision}}}};
 }
 const option=chosen?.kind==="online"?chosen.modelOption:config.videoModel;
 if(!option||chosen?.kind==="online"&&!decodeChannelModel(option))throw Error("请选择有效的视频模型渠道");
 const channel=resolveModelChannel(config,option);
 const model=channel?.models.find(item=>item.name===modelOptionName(option)&&item.capability==="video");
 if(!channel||!model)throw Error("所选视频模型已不可用，请重新选择");
 const target={kind:"online" as const,modelOption:encodeChannelModel(channel.id,model.name)};
 return {target,config:{...config,videoModel:target.modelOption,comfyWorkflowDefaults:{...config.comfyWorkflowDefaults,video:undefined}}};
}
export function dramaProductionSettingFingerprint(setting?:DramaShotProduction){
 // Fixed field order, compatible with JSON serialization and legacy absent settings.
 return JSON.stringify([setting?.mode??null,setting?.firstFrame??null,setting?.lastFrame??null,!!setting?.gridInput,setting?.gridImage??null,
  setting?.target?.kind??"inherit",setting?.target?.kind==="online"?setting.target.modelOption:null,
  setting?.target?.kind==="comfy"?[setting.target.templateId,setting.target.templateRevision]:null,
  setting?.promptOverride?[setting.promptOverride.text,setting.promptOverride.sourceFingerprint]:null,
  setting?.durationSec??null,setting?.aspectRatio??null]);
}
export function dramaDefaultProduction(input:DramaVideoInput):DramaShotProduction{
 return {mode:input.referenceImages.length?"omni_reference":"text_to_video"};
}
export function resolveDramaVideoProduction(input:DramaVideoInput,globalConfig:AiConfig,setting?:DramaShotProduction,visualStyle?:string,sourceRevisionId?:string){
 const {config,target}=resolveDramaVideoTarget(globalConfig,setting);
 const automaticPrompt=[input.prompt,visualStyle&&"影片风格："+visualStyle].filter(Boolean).join("\n");
 const promptSourceFingerprint=JSON.stringify([input.prompt,visualStyle??null,input.mode??null,!!input.gridInput]);
 const manual=setting?.promptOverride;
 const prompt=manual?.text??automaticPrompt;
 if(typeof prompt!=="string"||!prompt.trim()||prompt.length>24000)throw Error("请输入有效的视频提示词（最多 24000 字符）");
 if(manual&&/@\[node:/.test(prompt))throw Error("请通过参考素材绑定图片，不要在提示词中输入内部节点引用");
 const durationSec=setting?.durationSec??input.shot.durationSec??(Number(config.videoSeconds)||6);
 const aspectRatio=setting?.aspectRatio??config.videoRatio;
 if(!Number.isFinite(durationSec)||durationSec<=0)throw Error("镜头时长必须大于零");
 if(typeof aspectRatio!=="string"||!aspectRatio.trim())throw Error("请选择视频画幅");
 const snapshot:DramaVideoProductionSnapshot={target,prompt,durationSec,aspectRatio,sourceRevisionId,
  settingFingerprint:dramaProductionSettingFingerprint(setting),promptSourceFingerprint,manualPrompt:!!manual};
 return {config:{...config,videoRatio:aspectRatio,videoSeconds:String(durationSec)},input:{...input,productionSnapshot:snapshot},snapshot,automaticPrompt,
  promptOutdated:!!manual&&manual.sourceFingerprint!==promptSourceFingerprint};
}
