import type { CanvasPortValueKind } from "@/types/canvas";

export type ComfyNode = { class_type: string; inputs: Record<string, unknown>; _meta?: Record<string, unknown> };
export type ComfyApiGraph = Record<string, ComfyNode>;
export type ComfyNodeTarget = { nodeId: string; inputName: string };
export type ComfyInputBinding =
    | { mode: "literal"; targets: ComfyNodeTarget[] }
    | { mode: "media-file"; mediaKind: "IMAGE" | "VIDEO" | "AUDIO"; targets: ComfyNodeTarget[] }
    | { mode: "socket"; replaceInternalLink: boolean; targets: ComfyNodeTarget[] };
export type ComfyAbsentPolicy =
    | { mode: "keep-template" }
    | { mode: "disconnect"; removeInputs: ComfyNodeTarget[]; removeNodes: string[] };
export type ComfyTemplatePort = {
    id: string;
    label: string;
    direction: "source" | "target";
    valueKind: CanvasPortValueKind;
    required?: boolean;
    defaultValue?: unknown;
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
    for (const p of ports) {
        if (!isObject(p) || typeof p.id !== "string" || !safeId(p.id) || portIds.has(p.id) ||
            typeof p.label !== "string" || p.label.length > 90 ||
            (p.direction !== "source" && p.direction !== "target") || !PORT_KINDS.has(p.valueKind)) fail("invalid/duplicate port");
        portIds.add(p.id);
        if (p.direction === "target") {
            const b = p.inputBinding;
            if (p.valueKind === "LATENT" || p.valueKind === "CONDITIONING" || p.valueKind === "MASK" || p.valueKind === "IMAGE" || p.valueKind === "VIDEO" || p.valueKind === "AUDIO") {
                if (b?.mode === "literal") fail("literal mode supports only scalar values");
            }
            if (!isObject(b) || !INPUT_MODES.has(b.mode) || !Array.isArray(b.targets) || !b.targets.length) fail("missing input binding on " + p.id);
            if (b.mode === "socket" && typeof b.replaceInternalLink !== "boolean") fail("socket replace policy required");
            if (b.mode === "media-file" && (!["IMAGE", "VIDEO", "AUDIO"].includes(b.mediaKind) || b.mediaKind !== p.valueKind))
                fail("media-file kind mismatch");
            for (const target of b.targets) {
                if (!isObject(target) || typeof target.nodeId !== "string" || typeof target.inputName !== "string" ||
                    !has(graph, target.nodeId) || !has(graph[target.nodeId].inputs, target.inputName)) fail("input binding target missing");
                const key = target.nodeId + "." + target.inputName;
                if (claimed.has(key)) fail("duplicate input claim: " + key);
                claimed.add(key);
                const existing = graph[target.nodeId].inputs[target.inputName];
                if (b.mode === "socket" && isComfyLink(existing, graph) && !b.replaceInternalLink) fail("socket overwrites internal link");
                if (b.mode === "media-file" && isComfyLink(existing, graph)) fail("file sink is connected to socket");
                if (b.mode === "literal" && isComfyLink(existing, graph)) fail("literal sink is connected to socket");
                const inputMeta = info?.[graph[target.nodeId].class_type]?.input;
                const detail = inputMeta?.required?.[target.inputName] ?? inputMeta?.optional?.[target.inputName];
                const declaredType = Array.isArray(detail) && typeof detail[0] === "string" ? detail[0] : undefined;
                if (b.mode === "media-file" && declaredType && ["IMAGE","VIDEO","AUDIO","LATENT","MASK","CONDITIONING"].includes(declaredType))
                    fail("media-file cannot target a data socket");
                if (declaredType && b.mode === "socket" && declaredType !== p.valueKind) fail("socket type mismatch");
                if (declaredType && b.mode === "literal" && declaredType !== p.valueKind) fail("literal type mismatch");
            }
            if (p.absentPolicy && (p.absentPolicy.mode === "disconnect")) {
                if (p.required || !Array.isArray(p.absentPolicy.removeInputs) || !Array.isArray(p.absentPolicy.removeNodes) ||
                    p.absentPolicy.removeInputs.length + p.absentPolicy.removeNodes.length === 0) fail("invalid absence policy");
                for (const rm of p.absentPolicy.removeInputs) if (!has(graph, rm.nodeId) || !has(graph[rm.nodeId].inputs, rm.inputName)) fail("invalid absent input");
                for (const id of p.absentPolicy.removeNodes) if (!has(graph, id)) fail("invalid absent node");
            } else if (p.absentPolicy && p.absentPolicy.mode !== "keep-template") fail("unknown absence policy");
            if (has(p,"defaultValue") && b.mode === "literal") {
                const dv = p.defaultValue;
                if ((p.valueKind === "STRING" && typeof dv !== "string") ||
                    (p.valueKind === "BOOLEAN" && typeof dv !== "boolean") ||
                    (p.valueKind === "INT" && (!Number.isInteger(dv) || typeof dv !== "number")) ||
                    (p.valueKind === "FLOAT" && (typeof dv !== "number" || !Number.isFinite(dv)))) fail("default value type mismatch");
            }
            if (has(p, "defaultValue") && b.mode === "socket") fail("socket default must come from template graph");
        } else {
            if (p.inputBinding) fail("output cannot have input binding");
            const out = p.outputBinding;
            if (!isObject(out) || typeof out.nodeId !== "string" || !has(graph, out.nodeId) ||
                !Number.isInteger(out.outputIndex) || out.outputIndex < 0) fail("invalid output socket");
            const outputTypes = info?.[graph[out.nodeId].class_type]?.output;
            if (outputTypes && (out.outputIndex >= outputTypes.length || (outputTypes[out.outputIndex] !== p.valueKind && outputTypes[out.outputIndex] !== "*")))
                fail("output socket type mismatch");
            if (!p.capture || !CAPTURE_KINDS.has(p.capture.kind)) fail("capture policy required");
            if (p.capture.kind !== "none") {
                const expected = ({ image:"IMAGE", video:"VIDEO", audio:"AUDIO", text:"STRING" } as Record<string,string>)[p.capture.kind];
                if (expected !== p.valueKind || !p.capture.adapterId?.trim()) fail("capture requires a compatible explicit adapterId");
                if (info && !has(info,p.capture.adapterId)) fail("capture adapter class not installed");
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
