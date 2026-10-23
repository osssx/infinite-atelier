import type { CanvasConnection, CanvasNodeData, CanvasPortValueKind } from "@/types/canvas";
import { resolveCanvasInputValue, type InputValueDecision } from "@/lib/canvas/canvas-external-input-snapshot";
import type { ComfyTemplatePort, ComfyWorkflowTemplate } from "./template-schema";

export type ComfyScalarKind = Extract<CanvasPortValueKind, "STRING" | "INT" | "FLOAT" | "BOOLEAN">;
const scalarKinds = new Set<CanvasPortValueKind>(["STRING", "INT", "FLOAT", "BOOLEAN"]);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export type ComfyInstanceScalarField = {
    port: ComfyTemplatePort;
    connectedFrom?: { nodeId: string; portId?: string };
    connectionCount: number;
    localValue: InputValueDecision;
    source: InputValueDecision["source"];
    /** True when internal template targets start with different values and no override/default exists. */
    mixedTemplateValues: boolean;
};

function templateFieldValue(template: ComfyWorkflowTemplate, port: ComfyTemplatePort): {exists: boolean; value?: unknown; mixed: boolean} {
    const targets = port.inputBinding?.targets ?? [];
    if (!targets.length) return { exists:false, mixed:false };
    let first:unknown;
    let firstFound = false;
    let mixed = false;
    for (const target of targets) {
        const node = template.apiGraph[target.nodeId];
        if (!node || !own(node.inputs, target.inputName)) return {exists:false,mixed:false};
        const value = node.inputs[target.inputName];
        if (!firstFound) { first = value; firstFound = true; }
        else if (!Object.is(first, value)) mixed = true;
    }
    return { exists:true,value:first,mixed };
}

/** Reads the pinned revision's literal input ports; no Comfy GPU or browser registry needed. */
export function getComfyInstanceScalarFields(
    template: ComfyWorkflowTemplate,
    node: CanvasNodeData,
    connections: readonly CanvasConnection[],
): ComfyInstanceScalarField[] {
    const overrides = node.metadata?.comfyWorkflow?.inputOverrides ?? {};
    const incoming = new Map<string, CanvasConnection[]>();
    for (const connection of connections) {
        if (connection.toNodeId !== node.id || !connection.toPortId) continue;
        const list = incoming.get(connection.toPortId);
        if (list) list.push(connection);
        else incoming.set(connection.toPortId, [connection]);
    }
    return template.ports.filter((port) => port.direction === "target" &&
        port.inputBinding?.mode === "literal" && scalarKinds.has(port.valueKind)).map((port) => {
        const templateCandidate = templateFieldValue(template, port);
        const defaults: Record<string, unknown> = {};
        const values: Record<string, unknown> = {};
        if (own(port, "defaultValue")) defaults[port.id] = port.defaultValue;
        if (templateCandidate.exists && !templateCandidate.mixed) values[port.id] = templateCandidate.value;
        const localValue = resolveCanvasInputValue(port.id, {
            overrides, defaults, template:values, absentPolicy:port.absentPolicy?.mode,
        });
        const links = incoming.get(port.id) ?? [];
        const connectedFrom = links[0]
            ? { nodeId:links[0].fromNodeId, portId:links[0].fromPortId }
            : undefined;
        const effective = resolveCanvasInputValue(port.id, {
            overrides, defaults, template:values,
            absentPolicy:port.absentPolicy?.mode,
            edge:connectedFrom ? {value:connectedFrom} : undefined,
        });
        return {
            port, connectedFrom, connectionCount:links.length, localValue, source:effective.source,
            mixedTemplateValues:templateCandidate.mixed,
        };
    });
}

export function parseComfyScalarOverride(
    kind:ComfyScalarKind,
    raw:string | boolean,
): {ok:true;value:string|number|boolean} | {ok:false;error:string} {
    if (kind === "BOOLEAN") {
        if (typeof raw !== "boolean") return {ok:false,error:"布尔参数必须为开启或关闭"};
        return {ok:true,value:raw};
    }
    if (typeof raw !== "string") return {ok:false,error:"请输入有效的参数值"};
    if (kind === "STRING") {
        if (raw.length > 16000) return {ok:false,error:"文本不能超过 16000 个字符"};
        return {ok:true,value:raw};
    }
    const trimmed = raw.trim();
    if (!trimmed) return {ok:false,error:"请输入数值"};
    if (kind === "INT") {
        if (!/^[+-]?\d+$/.test(trimmed)) return {ok:false,error:"请输入整数"};
        const value = Number(trimmed);
        if (!Number.isSafeInteger(value)) return {ok:false,error:"整数超出 JavaScript 安全范围（±9007199254740991）"};
        return {ok:true,value};
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return {ok:false,error:"请输入有限浮点数"};
    return {ok:true,value};
}

/** Only touches the currently selected canvas node's override map. */
export function setComfyInstanceOverride(
    overrides: Readonly<Record<string,unknown>>,
    portId:string, value:string|number|boolean,
): Record<string,unknown> {
    return {...overrides,[portId]:value};
}
export function removeComfyInstanceOverride(
    overrides: Readonly<Record<string,unknown>>, portId:string,
): Record<string,unknown> {
    const next = {...overrides};
    delete next[portId];
    return next;
}

export function generateComfySafeSeed():number {
    const random = new Uint32Array(2);
    crypto.getRandomValues(random);
    return (random[0] & 0x1fffff) * 0x100000000 + random[1];
}
