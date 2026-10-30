import type { CanvasPortValueKind } from "@/types/canvas";
import {inspectComfyInputSpec} from "./comfy-input-spec";

export type ComfyNode = { class_type: string; inputs: Record<string, unknown>; _meta?: Record<string, unknown> };
export type ComfyApiGraph = Record<string, ComfyNode>;
export type ComfyNodeTarget = { nodeId: string; inputName: string };
/** Optional UI-only enum choices. Comfy receives the selected scalar, never this list. */
export type ComfyScalarChoice = {label:string;value:string|number};
export type ComfyInputBinding =
    | { mode: "literal"; targets: ComfyNodeTarget[] }
    | { mode: "media-file"; mediaKind: "IMAGE" | "VIDEO" | "AUDIO"; targets: ComfyNodeTarget[] }
    | { mode: "socket"; replaceInternalLink: boolean; targets: ComfyNodeTarget[] };
export type ComfyAbsentPolicy =
    | { mode: "keep-template" }
    /** Optional media input: remove its Comfy socket or loader branch if no asset is connected. */
    | { mode: "auto-prune" }
    | { mode: "disconnect"; removeInputs: ComfyNodeTarget[]; removeNodes: string[] };
export type ComfyTemplatePort = {
    id: string;
    label: string;
    direction: "source" | "target";
    valueKind: CanvasPortValueKind;
    required?: boolean;
    /** Omitted means visible; only optional, connectable inputs may hide their socket. */
    canvasVisible?: boolean;
    defaultValue?: unknown;
    choices?: ComfyScalarChoice[];
    inputBinding?: ComfyInputBinding;
    absentPolicy?: ComfyAbsentPolicy;
    outputBinding?: { nodeId: string; outputIndex: number };
    capture?: { kind: "none" | "image" | "video" | "audio" | "text"; adapterId?: string };
};
export type ComfyRequirements = { classTypes: string[]; modelAssets?: string[] };
export type ComfyTemplatePayload = {
    name: string;
    apiGraph: ComfyApiGraph;
    ports: ComfyTemplatePort[];
    requirements: ComfyRequirements;
};
export type ComfyWorkflowTemplate = ComfyTemplatePayload & { id: string; revision: string };

/** A subset of the ComfyUI /object_info schema used for static capability checks. */
export type ComfyObjectInfo = Record<string, {
    input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
    output?: string[];
}>;
const PORT_KINDS = new Set(["STRING", "INT", "FLOAT", "BOOLEAN", "IMAGE", "MASK", "LATENT", "CONDITIONING", "VIDEO", "AUDIO", "JSON"]);
const CAPTURE_KINDS = new Set(["none", "image", "video", "audio", "text"]);
const INPUT_MODES = new Set(["literal", "media-file", "socket"]);
const MAX_GRAPH_NODES = 500, MAX_PORTS = 64, MAX_PAYLOAD_BYTES = 2_000_000;
const safeId = (s: string) => /^[a-zA-Z0-9_:\-.]{1,128}$/.test(s);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function fail(msg: string): never { throw new Error("Invalid ComfyUI workflow: " + msg); }
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
/** Structured context for template binding errors, so editors can navigate to
 * the exact port and ComfyUI input without parsing an English error message.
 * String/prompt values are never included in diagnostics.
 */
export class ComfyTemplateBindingError extends Error {
    readonly portId: string;
    readonly nodeId?: string;
    readonly inputName?: string;
    constructor(reason: string, port: ComfyTemplatePort, graph: ComfyApiGraph, target?: ComfyNodeTarget, detail?: string) {
        const portName = JSON.stringify(port.label.slice(0, 90));
        const node = target ? graph[target.nodeId] : undefined;
        const location = target
            ? `；ComfyUI 节点 ${target.nodeId}（${node?.class_type ?? "未知节点"}）参数 ${target.inputName}`
            : "";
        super(`Invalid ComfyUI workflow: ${reason}；画布端口 ${portName}（${port.id}）${location}${detail ? "；"+detail : ""}`);
        this.name = "ComfyTemplateBindingError";
        this.portId = port.id;
        this.nodeId = target?.nodeId ?? (port.direction === "source" ? port.outputBinding?.nodeId : undefined);
        this.inputName = target?.inputName;
    }
}


export function canonicalComfyJson(value: unknown): string {
    const canonical = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(canonical);
        if (isObject(v)) {
            const result: Record<string, unknown> = {};
            for (const key of Object.keys(v).sort()) {
                if (key === "__proto__" || key === "constructor" || key === "prototype") fail("unsafe key");
                if (v[key] !== undefined) result[key] = canonical(v[key]);
            }
            return result;
        }
        if (typeof v === "function" || typeof v === "bigint" || (typeof v === "number" && !Number.isFinite(v)))
            fail("unsupported JSON value");
        return v;
    };
    return JSON.stringify(canonical(value));
}
export async function comfySha256(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const result = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(result), (n) => n.toString(16).padStart(2, "0")).join("");
}
export function isComfyLink(input: unknown, graph: ComfyApiGraph): input is [string, number] {
    return Array.isArray(input) && input.length === 2 && typeof input[0] === "string" &&
        has(graph, input[0]) && Number.isInteger(input[1]) && input[1] >= 0;
}
/** V3 autogrow: a declared marker expands to dotted leaves, never a literal parent value. */
function comfyAutogrowSlots(spec: unknown): { names: string[]; min: number } | null {
    if (!Array.isArray(spec) || spec[0] !== "COMFY_AUTOGROW_V3") return null;
    const template = isObject(spec[1]) ? spec[1].template : undefined;
    if (!isObject(template)) fail("invalid autogrow schema");
    const min = template.min;
    const names = Array.isArray(template.names) ? template.names :
        typeof template.prefix === "string" && Number.isInteger(template.max) &&
        (template.max as number) >= 1 && (template.max as number) <= 100
            ? Array.from({ length: template.max as number }, (_, i) => template.prefix + String(i)) : null;
    if (!Number.isInteger(min) || (min as number) < 0 || !names || names.length > 100 ||
        (min as number) > names.length || names.some((name:unknown) => typeof name !== "string" || !safeId(name)) ||
        new Set(names).size !== names.length) fail("invalid autogrow schema");
    return { names: names as string[], min: min as number };
}
function comfyDeclaredInput(node: ComfyNode, info: ComfyObjectInfo[string], key: string): boolean {
    const direct = info.input?.required?.[key] ?? info.input?.optional?.[key];
    if (direct !== undefined) return comfyAutogrowSlots(direct) === null;
    const dot = key.indexOf(".");
    if (dot <= 0) return false;
    const root = key.slice(0,dot), leaf = key.slice(dot+1);
    const spec = info.input?.required?.[root] ?? info.input?.optional?.[root];
    const autogrow = comfyAutogrowSlots(spec);
    if (autogrow) return autogrow.names.includes(leaf);
    if (!Array.isArray(spec) || spec[0] !== "COMFY_DYNAMICCOMBO_V3" ||
        typeof node.inputs[root] !== "string") return false;
    const details = isObject(spec[1]) ? spec[1] : null;
    const choices = Array.isArray(details?.options) ? details.options : [];
    const selected = choices.find((choice:unknown) => isObject(choice) && choice.key === node.inputs[root]);
    const fields = isObject(selected) && isObject(selected.inputs) ? selected.inputs : null;
    return Boolean(fields && (
        isObject(fields.required) && has(fields.required,leaf) ||
        isObject(fields.optional) && has(fields.optional,leaf)
    ));
}
export function validateComfyApiGraph(raw: unknown, info?: ComfyObjectInfo): ComfyApiGraph {
    if (!isObject(raw) || Object.keys(raw).length === 0 || Object.keys(raw).length > MAX_GRAPH_NODES) fail("invalid API format graph size");
    if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_PAYLOAD_BYTES) fail("graph too large");
    const graph = raw as ComfyApiGraph;
    for (const [id, node] of Object.entries(graph)) {
        if (!safeId(id) || !isObject(node) || !isObject(node.inputs) || typeof node.class_type !== "string" || !safeId(node.class_type))
            fail("invalid node at " + id + "; use Save (API Format), not UI workflow JSON");
        if (info && !has(info, node.class_type)) fail("missing ComfyUI class: " + node.class_type);
        for (const [key, value] of Object.entries(node.inputs)) {
            if (!safeId(key)) fail("unsafe input field");
            if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1])) {
                if (!has(graph, value[0])) fail("dangling link " + id + "." + key);
                if (value[1] < 0) fail("invalid output slot");
                const outputs = info?.[graph[value[0]].class_type]?.output;
                if (outputs && value[1] >= outputs.length) fail("output slot out of range");
            }
            if (info && !comfyDeclaredInput(node,info[node.class_type],key))
                fail("unknown input " + id + "." + key);
        }
        const required = info?.[node.class_type]?.input?.required;
        if (required) for (const [key,spec] of Object.entries(required)) {
            const autogrow = comfyAutogrowSlots(spec);
            if (autogrow) {
                for (const name of autogrow.names.slice(0,autogrow.min))
                    if (!has(node.inputs,key+"."+name)) fail("required field missing: " + id + "." + key + "." + name);
            } else if (!has(node.inputs,key)) fail("required field missing: " + id + "." + key);
        }
    }
    // Comfy execution links form a DAG, not a graph with feedback loops.
    const visiting = new Set<string>(), done = new Set<string>();
    const visit = (id: string) => {
        if (visiting.has(id)) fail("workflow contains a cycle");
        if (done.has(id)) return;
        visiting.add(id);
        for (const value of Object.values(graph[id].inputs)) if (isComfyLink(value, graph)) visit(value[0]);
        visiting.delete(id); done.add(id);
    };
    for (const id of Object.keys(graph)) visit(id);
    return graph;
}

export function validateComfyTemplatePayload(raw: unknown, info?: ComfyObjectInfo): ComfyTemplatePayload {
    if (!isObject(raw) || typeof raw.name !== "string" || raw.name.trim().length < 1 || raw.name.length > 160 ||
        !Array.isArray(raw.ports) || raw.ports.length > MAX_PORTS) fail("invalid template metadata or port count");
    const graph = validateComfyApiGraph(raw.apiGraph, info);
    const claimed = new Set<string>(), portIds = new Set<string>();
    const ports = raw.ports as ComfyTemplatePort[];
    function failBinding(reason:string, port:ComfyTemplatePort, target?:ComfyNodeTarget, detail?:string):never {
        throw new ComfyTemplateBindingError(reason, port, graph, target, detail);
    }
    const valueDescription = (value:unknown):string => {
        if(typeof value === "string") return `字符串（长度 ${value.length}，内容已隐藏）`;
        if(typeof value === "boolean") return `BOOLEAN（${value}）`;
        if(typeof value === "number") return `${Number.isInteger(value)?"整数":"小数"}（${Number.isFinite(value)?String(value):"非有限数"}）`;
        if(value===null)return "null";
        return Array.isArray(value)?"数组":"对象";
    };

    for (const p of ports) {
        if (!isObject(p) || typeof p.id !== "string" || !safeId(p.id) || portIds.has(p.id) ||
            typeof p.label !== "string" || p.label.length > 90 ||
            (p.direction !== "source" && p.direction !== "target") || !PORT_KINDS.has(p.valueKind)) fail("invalid/duplicate port");
        portIds.add(p.id);
        if (p.canvasVisible !== undefined && typeof p.canvasVisible !== "boolean") fail("invalid port visibility");
        if (p.canvasVisible === false && (p.direction !== "target" || p.required || ["INT","FLOAT","BOOLEAN"].includes(p.valueKind)))
            fail("only optional canvas-connectable inputs can be hidden");
        if (p.direction === "target") {
            const b = p.inputBinding;
            if (p.valueKind === "LATENT" || p.valueKind === "CONDITIONING" || p.valueKind === "MASK" || p.valueKind === "IMAGE" || p.valueKind === "VIDEO" || p.valueKind === "AUDIO") {
                if (b?.mode === "literal") failBinding("literal mode supports only scalar values",p,undefined,`当前端口类型 ${p.valueKind} 不支持常量绑定`);
            }
            if (!isObject(b) || !INPUT_MODES.has(b.mode) || !Array.isArray(b.targets) || !b.targets.length) failBinding("missing input binding",p);
            if (b.mode === "socket" && typeof b.replaceInternalLink !== "boolean") fail("socket replace policy required");
            if (b.mode === "media-file" && (!["IMAGE", "VIDEO", "AUDIO"].includes(b.mediaKind) || b.mediaKind !== p.valueKind))
                failBinding("media-file kind mismatch",p,undefined,`端口类型 ${p.valueKind}，绑定媒体类型 ${b.mediaKind}`);
            for (const target of b.targets) {
                if (!isObject(target) || typeof target.nodeId !== "string" || typeof target.inputName !== "string" ||
                    !has(graph, target.nodeId) || !has(graph[target.nodeId].inputs, target.inputName)) failBinding("input binding target missing",p,isObject(target) && typeof target.nodeId === "string" && typeof target.inputName === "string" ? target as ComfyNodeTarget : undefined);
                const key = target.nodeId + "." + target.inputName;
                if (claimed.has(key)) failBinding("duplicate input claim: " + key,p,target);
                claimed.add(key);
                const existing = graph[target.nodeId].inputs[target.inputName];
                if (b.mode === "socket" && isComfyLink(existing, graph) && !b.replaceInternalLink) failBinding("socket overwrites internal link",p,target);
                if (b.mode === "media-file" && isComfyLink(existing, graph)) failBinding("file sink is connected to socket",p,target);
                if (b.mode === "literal" && isComfyLink(existing, graph)) failBinding("literal sink is connected to socket",p,target);
                const inputMeta = info?.[graph[target.nodeId].class_type]?.input;
                const detail = inputMeta?.required?.[target.inputName] ?? inputMeta?.optional?.[target.inputName];
                const descriptor=inspectComfyInputSpec(detail);
                const declaredType=descriptor.declaredType;
                const expectedType=descriptor.valueKind ?? declaredType;
                if (b.mode === "media-file" && declaredType && ["IMAGE","VIDEO","AUDIO","LATENT","MASK","CONDITIONING"].includes(declaredType))
                    failBinding("media-file cannot target a data socket",p,target,`节点声明类型 ${declaredType}；当前端口类型 ${p.valueKind}`);
                if (expectedType && b.mode === "socket" && expectedType !== p.valueKind) failBinding("socket type mismatch",p,target,`节点要求 ${expectedType}，当前端口设置为 ${p.valueKind}`);
                if (expectedType && b.mode === "literal" && expectedType !== p.valueKind) failBinding("literal type mismatch",p,target,`节点要求 ${expectedType}${declaredType==="COMBO"?"（COMBO 枚举值）":""}，当前端口设置为 ${p.valueKind}；工作流原值：${valueDescription(existing)}。请调整画布端口数据类型或输入映射`);
            }
            if (p.absentPolicy?.mode === "auto-prune") {
                if (p.required || !["IMAGE","VIDEO","AUDIO"].includes(p.valueKind) ||
                    !["socket","media-file"].includes(b.mode) || has(p,"defaultValue"))
                    fail("automatic pruning requires an optional IMAGE, VIDEO or AUDIO input without a default");
            }
            if (p.absentPolicy && (p.absentPolicy.mode === "disconnect")) {
                if (p.required || !Array.isArray(p.absentPolicy.removeInputs) || !Array.isArray(p.absentPolicy.removeNodes) ||
                    p.absentPolicy.removeInputs.length + p.absentPolicy.removeNodes.length === 0) fail("invalid absence policy");
                for (const rm of p.absentPolicy.removeInputs) if (!has(graph, rm.nodeId) || !has(graph[rm.nodeId].inputs, rm.inputName)) fail("invalid absent input");
                for (const id of p.absentPolicy.removeNodes) if (!has(graph, id)) fail("invalid absent node");
            } else if (p.absentPolicy && !["keep-template","auto-prune"].includes(p.absentPolicy.mode)) fail("unknown absence policy");
            if (has(p,"defaultValue") && b.mode === "literal") {
                const dv = p.defaultValue;
                if ((p.valueKind === "STRING" && typeof dv !== "string") ||
                    (p.valueKind === "BOOLEAN" && typeof dv !== "boolean") ||
                    (p.valueKind === "INT" && (!Number.isInteger(dv) || typeof dv !== "number")) ||
                    (p.valueKind === "FLOAT" && (typeof dv !== "number" || !Number.isFinite(dv)))) failBinding("default value type mismatch",p,b.targets[0],`端口要求 ${p.valueKind}，默认值为 ${valueDescription(dv)}`);
            }
            if (has(p, "defaultValue") && b.mode === "socket") fail("socket default must come from template graph");
            if (has(p,"choices")) {
                if (b.mode!=="literal" || !["STRING","INT","FLOAT"].includes(p.valueKind) ||
                    !Array.isArray(p.choices) || p.choices.length<1 || p.choices.length>64)
                    failBinding("enum choices require a STRING, INT or FLOAT literal input (1–64 choices)",p);
                const seen=new Set<string>();
                for(const option of p.choices){
                    if(!isObject(option)||typeof option.label!=="string"||
                        !option.label.trim()||option.label.length>90 || /[|\r\n]/.test(option.label) ||
                        (p.valueKind==="STRING" ? typeof option.value!=="string"||option.value.length>16000||/[\r\n]/.test(option.value) :
                         p.valueKind==="INT" ? !Number.isSafeInteger(option.value) :
                         typeof option.value!=="number"||!Number.isFinite(option.value)))
                        failBinding("enum choice label/value type mismatch",p,undefined,`候选项类型应为 ${p.valueKind}`);
                    const key=typeof option.value+":"+String(option.value);
                    if(seen.has(key))failBinding("duplicate enum choice value",p);
                    seen.add(key);
                }
                if(has(p,"defaultValue") && !p.choices.some(o=>Object.is(o.value,p.defaultValue)))
                    failBinding("enum default value must match one of the choices",p,undefined,`默认值为 ${valueDescription(p.defaultValue)}`);
            }
        } else {
            if (p.inputBinding) failBinding("output cannot have input binding",p);
            if(has(p,"choices"))failBinding("output cannot have enum choices",p);
            const out = p.outputBinding;
            if (!isObject(out) || typeof out.nodeId !== "string" || !has(graph, out.nodeId) ||
                !Number.isInteger(out.outputIndex) || out.outputIndex < 0) failBinding("invalid output socket",p);
            const outputTypes = info?.[graph[out.nodeId].class_type]?.output;
            if (outputTypes && (out.outputIndex >= outputTypes.length || (outputTypes[out.outputIndex] !== p.valueKind && outputTypes[out.outputIndex] !== "*")))
                failBinding("output socket type mismatch",p,undefined,`ComfyUI 节点 ${out.nodeId}（${graph[out.nodeId].class_type}）输出 [${out.outputIndex}]：节点类型 ${outputTypes?.[out.outputIndex]??"不存在"}，当前端口设置为 ${p.valueKind}`);
            if (!p.capture || !CAPTURE_KINDS.has(p.capture.kind)) failBinding("capture policy required",p);
            if (p.capture.kind !== "none") {
                const expected = ({ image:"IMAGE", video:"VIDEO", audio:"AUDIO", text:"STRING" } as Record<string,string>)[p.capture.kind];
                if (expected !== p.valueKind || !p.capture.adapterId?.trim()) failBinding("capture requires a compatible explicit adapterId",p,undefined,`捕获类型 ${p.capture.kind} 对应 ${expected}，当前端口类型 ${p.valueKind}`);
                if (info && !has(info,p.capture.adapterId)) failBinding("capture adapter class not installed",p,undefined,`缺少捕获节点 ${p.capture.adapterId}`);
            }
        }
    }
    if (ports.filter((p)=>p.direction==="source").length === 0) fail("template needs at least one output port");
    const types = [...new Set(Object.values(graph).map((node) => node.class_type))].sort();
    if (!isObject(raw.requirements) || !Array.isArray(raw.requirements.classTypes) ||
        raw.requirements.classTypes.length !== types.length || raw.requirements.classTypes.some((name: string, index: number) => name !== types[index]))
        fail("requirements classTypes do not match graph");
    if (raw.requirements.modelAssets && (!Array.isArray(raw.requirements.modelAssets) ||
        raw.requirements.modelAssets.some((v: unknown) => typeof v !== "string" || !v.trim() || v.length > 256)))
        fail("invalid model dependencies");
    // Identity/revision are NOT part of content-addressed payload. Ignore extra supplied metadata.
    return JSON.parse(canonicalComfyJson({name:raw.name,apiGraph:graph,ports,requirements:raw.requirements})) as ComfyTemplatePayload;
}
export function templatePayloadFromGraph(name: string, raw: unknown, info?: ComfyObjectInfo): ComfyTemplatePayload {
    const graph = validateComfyApiGraph(raw, info);
    return { name, apiGraph: graph, ports: [], requirements: {
        classTypes: [...new Set(Object.values(graph).map((n) => n.class_type))].sort(),
    } };
}
export async function createComfyTemplate(id: string, raw: unknown, info?: ComfyObjectInfo): Promise<ComfyWorkflowTemplate> {
    if (!safeId(id)) fail("invalid template id");
    const payload = validateComfyTemplatePayload(raw, info);
    const revision = await comfySha256(canonicalComfyJson(payload));
    return { id, revision, ...payload };
}
export async function verifyComfyTemplate(template: ComfyWorkflowTemplate): Promise<void> {
    const actual = await createComfyTemplate(template.id, template);
    if (template.revision !== actual.revision) fail("template revision SHA-256 mismatch");
}
