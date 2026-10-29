import type { CanvasPortValueKind } from "@/types/canvas";
import type { ComfyApiGraph, ComfyInputBinding, ComfyNodeTarget, ComfyObjectInfo, ComfyTemplatePort } from "./template-schema";
import {inspectComfyInputSpec} from "./comfy-input-spec";

export type ComfyGraphItem = {
    id: string;
    classType: string;
    title: string;
    fields: Array<{name:string;value:unknown;declaredType?:string}>;
    outputs: Array<{index:number;valueKind:string}>;
};
export const bindingTargetKey = (t: ComfyNodeTarget) => JSON.stringify([t.nodeId,t.inputName]);

/** Clicking an already-selected canvas port deselects it; a subsequent
 * click on a ComfyUI input then creates a separate canvas port.
 */
export function toggleComfyPortSelection(selectedId:string|null,clickedId:string):string|null {
    return selectedId===clickedId?null:clickedId;
}

/** Keep existing bindings unique while allowing a deliberate multi-map. */
export function resolveComfyInputBindingAction(
    ports:readonly ComfyTemplatePort[],selectedId:string|null,target:ComfyNodeTarget,
):{kind:"existing"|"append"|"create";portId?:string} {
    const existing=usedComfyInputTarget(ports,target);
    if(existing)return {kind:"existing",portId:existing};
    const selected=ports.find(p=>p.id===selectedId);
    if(selected?.direction==="target")return {kind:"append",portId:selected.id};
    return {kind:"create"};
}


/** Safe even if a custom Comfy node ID or an input name contains a dot. */
export function parseBindingTargetKey(key:string): ComfyNodeTarget {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((v)=>typeof v!=="string")) {
        throw new Error("Invalid Comfy binding selection");
    }
    return {nodeId:parsed[0],inputName:parsed[1]};
}

export function enumerateComfyGraphItems(graph:ComfyApiGraph, objectInfo?:ComfyObjectInfo): ComfyGraphItem[] {
    return Object.entries(graph).map(([id,node]) => {
        const spec = objectInfo?.[node.class_type];
        const title = typeof node._meta?.title === "string" && node._meta.title.trim() ? node._meta.title.trim() : node.class_type;
        const fields = Object.entries(node.inputs).map(([name,value]) => {
            const meta = spec?.input?.required?.[name] ?? spec?.input?.optional?.[name];
            const descriptor=inspectComfyInputSpec(meta);
            const declaredType=descriptor.declaredType==="COMBO"&&descriptor.valueKind
                ? `COMBO (${descriptor.valueKind})`:descriptor.declaredType;
            return {name,value,declaredType};
        });
        return {id,classType:node.class_type,title,fields,outputs:(spec?.output||[]).map((valueKind,index)=>({index,valueKind}))};
    });
}

export function filterComfyGraphItems(items:readonly ComfyGraphItem[], query:string):ComfyGraphItem[] {
    const q=query.trim().toLocaleLowerCase();
    if (!q) return [...items];
    return items.filter((item)=>[item.id,item.title,item.classType,...item.fields.map((f)=>f.name)]
        .some((v)=>v.toLocaleLowerCase().includes(q)));
}

export function inferComfyInputKind(value:unknown, declaredType?:string):CanvasPortValueKind {
    const recognized:CanvasPortValueKind[]=["STRING","INT","FLOAT","BOOLEAN","IMAGE","MASK","LATENT","CONDITIONING","VIDEO","AUDIO","JSON"];
    if (declaredType && recognized.includes(declaredType as CanvasPortValueKind)) return declaredType as CanvasPortValueKind;
    if (typeof value==="boolean") return "BOOLEAN";
    if (typeof value==="number") return Number.isInteger(value)?"INT":"FLOAT";
    if (typeof value==="string") return "STRING";
    return "IMAGE"; // With missing /object_info, linked sockets have unknown type; user must confirm.
}
export function inferComfyBindingMode(value:unknown):ComfyInputBinding["mode"] {
    return Array.isArray(value) && value.length===2 && typeof value[0]==="string" && Number.isInteger(value[1]) ? "socket" : "literal";
}

/** The same internal Comfy field cannot be claimed by two canvas input ports. */
export function appendComfyInputTarget(ports:readonly ComfyTemplatePort[],portId:string,target:ComfyNodeTarget):ComfyTemplatePort[] {
    if (!ports.some((p)=>p.id===portId && p.direction==="target")) throw new Error("Choose a canvas input port first");
    if (ports.some((p)=>p.id!==portId && p.direction==="target" &&
        p.inputBinding?.targets.some((t)=>bindingTargetKey(t)===bindingTargetKey(target)))) {
        throw new Error("This Comfy input is already assigned to another canvas port");
    }
    return ports.map((p)=>{
        if (p.id!==portId || p.direction!=="target" || !p.inputBinding) return p;
        if (p.inputBinding.targets.some((t)=>bindingTargetKey(t)===bindingTargetKey(target))) return p;
        return {...p,inputBinding:{...p.inputBinding,targets:[...p.inputBinding.targets,target]}};
    });
}
export function removeComfyInputTarget(ports:readonly ComfyTemplatePort[],portId:string,target:ComfyNodeTarget):ComfyTemplatePort[] {
    return ports.map((p)=>p.id===portId && p.direction==="target" && p.inputBinding
        ? {...p,inputBinding:{...p.inputBinding,targets:p.inputBinding.targets.filter((t)=>bindingTargetKey(t)!==bindingTargetKey(target))}}
        :p);
}
export function usedComfyInputTarget(ports:readonly ComfyTemplatePort[],target:ComfyNodeTarget):string|undefined {
    return ports.find((p)=>p.direction==="target" &&
        p.inputBinding?.targets.some((t)=>bindingTargetKey(t)===bindingTargetKey(target)))?.id;
}
