import {canvasApi} from "./canvas-api";
import type {AiConfig} from "@/stores/use-config-store";

type Key="theme"|"model_config";
export type UiSetting<T>={revision:number;value:T};
export const readUiSetting=<T>(key:Key)=>canvasApi<UiSetting<T>>("/api/v1/ui-settings/"+key);
export const saveUiSetting=<T>(key:Key,revision:number,value:T)=>
 canvasApi<UiSetting<T>>("/api/v1/ui-settings/"+key,"PUT",{expectedRevision:revision,value});

/** Only allowlisted preferences are serialized. Any API Key, raw model
 * script or unrecognized imported field is excluded from this projection.
 */
export function publicModelConfig(config:AiConfig):Record<string,unknown>{
 const keys=[
  "channelMode","baseUrl","apiFormat","model","imageModel","videoModel","textModel",
  "audioModel","audioVoice","audioFormat","audioSpeed","audioInstructions","videoSeconds",
  "videoMode","videoRatio","videoReturnLastFrame","vquality","videoGenerateAudio",
  "videoWatermark","systemPrompt","reasoningEffort","models","quality","size","background",
  "count","canvasImageCount","comfyInstanceId","comfyAutoDetect"
 ] as const;
 const result:Record<string,unknown>={};
 for(const k of keys)result[k]=k==="channelMode"?"local":config[k];
 result.channels=config.channels.map(ch=>({
  id:ch.id,name:ch.name,baseUrl:ch.baseUrl,apiFormat:ch.apiFormat,
  models:ch.models.map(model=>({
   name:model.name,capability:model.capability,
   ...(model.videoPreset?{videoPreset:model.videoPreset}:{}),
   ...(model.videoCapabilities?{videoCapabilities:{
    ...(model.videoCapabilities.resolutions?{resolutions:model.videoCapabilities.resolutions}:{}),
    ...(model.videoCapabilities.durations?{durations:model.videoCapabilities.durations}:{}),
    ...(model.videoCapabilities.ratios?{ratios:model.videoCapabilities.ratios}:{}),
    ...(model.videoCapabilities.generateAudio!==undefined?{generateAudio:model.videoCapabilities.generateAudio}:{}),
    ...(model.videoCapabilities.watermark!==undefined?{watermark:model.videoCapabilities.watermark}:{}),
    ...(model.videoCapabilities.returnLastFrame!==undefined?{returnLastFrame:model.videoCapabilities.returnLastFrame}:{})
   }}:{})
  }))
 }));
 return result;
}
/** Legacy portable exports must not contain browser API keys or model scripts. */
export function redactedExportConfig(config:AiConfig):AiConfig{
 const safe=publicModelConfig(config);
 return {...safe,apiKey:"",
  channels:(safe.channels as Array<Record<string,unknown>>).map(channel=>({...channel,apiKey:""}))
 } as AiConfig;
}

