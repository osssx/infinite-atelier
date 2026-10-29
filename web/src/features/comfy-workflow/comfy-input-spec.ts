import type {CanvasPortValueKind} from "@/types/canvas";
import type {ComfyScalarChoice} from "./template-schema";

const scalarKinds=new Set<CanvasPortValueKind>(["STRING","INT","FLOAT","BOOLEAN","IMAGE","MASK","LATENT","CONDITIONING","VIDEO","AUDIO","JSON"]);
const isObject=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);

/** ComfyUI exposes enum widgets as either [values, options] or
 * ["COMBO", {options: values}]. Canvas ports carry the selected scalar,
 * not the widget's COMBO descriptor.
 */
export function inspectComfyInputSpec(spec:unknown):{
    declaredType?:string;
    valueKind?:CanvasPortValueKind;
    options?:readonly (string|number)[];
    choices?:ComfyScalarChoice[];
}{
    if(!Array.isArray(spec))return {};
    const [raw,properties]=spec;
    const options=Array.isArray(raw)?raw:
        raw==="COMBO"&&isObject(properties)&&Array.isArray(properties.options)?properties.options:undefined;
    const declaredType=Array.isArray(raw)?"COMBO":typeof raw==="string"?raw:undefined;
    if(options){
        const strings=options.length>0&&options.every((v:unknown)=>typeof v==="string");
        const integers=options.length>0&&options.every((v:unknown)=>Number.isSafeInteger(v));
        const numbers=options.length>0&&options.every((v:unknown)=>typeof v==="number"&&Number.isFinite(v));
        const valueKind:CanvasPortValueKind|undefined=strings?"STRING":integers?"INT":numbers?"FLOAT":undefined;
        // The dropdown editor caps its choice list at 64. Large model lists
        // remain bindable as ordinary scalars without copying the whole catalog.
        const choices=valueKind&&options.length<=64&&options.every((v:unknown)=>
            typeof v==="string"?v.length>0&&v.length<=90&&!/[|\r\n]/.test(v):
                typeof v==="number"&&Number.isFinite(v))?
            options.map((value:string|number)=>({label:String(value),value})):undefined;
        return {declaredType,valueKind,options:valueKind?options:undefined,choices};
    }
    return {declaredType,valueKind:scalarKinds.has(raw as CanvasPortValueKind)?raw as CanvasPortValueKind:undefined};
}
