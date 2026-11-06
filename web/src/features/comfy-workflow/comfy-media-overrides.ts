import type {CanvasNodeMetadata} from "@/types/canvas";
import {removeComfyInstanceOverride,setComfyInstanceOverride} from "./instance-parameters";

type Binding=NonNullable<CanvasNodeMetadata["comfyMediaPreset"]>;
type ScalarValue=string|number|boolean;
export const COMFY_MEDIA_PARAMETER_POPUP_CLASS="comfy-media-parameter-select-popup";
export function isComfyMediaParameterPopupTarget(target:EventTarget|null):boolean{
 const element=target as (Element&{closest?:(selector:string)=>Element|null})|null;
 return Boolean(element?.closest?.(`.${COMFY_MEDIA_PARAMETER_POPUP_CLASS}`));
}

export function createComfyMediaOverridePatch(binding:Binding,portId:string,value:ScalarValue):Partial<CanvasNodeMetadata>{
 return {comfyMediaPreset:{...binding,overrides:setComfyInstanceOverride(binding.overrides,portId,value)}};
}
export function createComfyMediaResetPatch(binding:Binding,portId?:string):Partial<CanvasNodeMetadata>{
 return {comfyMediaPreset:{...binding,overrides:portId?removeComfyInstanceOverride(binding.overrides,portId):{}}};
}
