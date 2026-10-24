import { normalizeConnection } from "@/lib/canvas/canvas-node-geometry";
import { getCanvasNodePorts, getCanvasPort, getCanvasResourceOutputPort, isPortAwareCanvasNode } from "@/lib/canvas/canvas-ports";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ConnectionHandle } from "@/types/canvas";

export type CanvasPortConnectionError =
    | "missing_node" | "invalid_handle" | "missing_port" | "incompatible_port_type"
    | "multiple_sources_for_input" | "duplicate" | "cycle" | "legacy_target_not_supported";
export type CanvasPortConnectionResult = { connection?: Omit<CanvasConnection, "id">; error?: CanvasPortConnectionError };

function createsCycle(from: string, to: string, connections: readonly CanvasConnection[]): boolean {
    const out = new Map<string, string[]>();
    for (const c of connections) {
        const list = out.get(c.fromNodeId);
        if (list) list.push(c.toNodeId);
        else out.set(c.fromNodeId, [c.toNodeId]);
    }
    const visited = new Set<string>();
    const stack = [to];
    while (stack.length) {
        const current = stack.pop()!;
        if (current === from) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        stack.push(...(out.get(current) || []));
    }
    return false;
}

/** Legacy edges retain old normalization and node-pair de-duplication unchanged. */
export function prepareCanvasPortConnection(
    first: ConnectionHandle,
    second: ConnectionHandle,
    nodes: readonly CanvasNodeData[],
    existing: readonly CanvasConnection[],
): CanvasPortConnectionResult {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const a = nodeById.get(first.nodeId), b = nodeById.get(second.nodeId);
    if (!a || !b) return { error: "missing_node" };
    if (a.id === b.id || first.handleType === second.handleType) return { error: "invalid_handle" };
    const aAware = isPortAwareCanvasNode(a), bAware = isPortAwareCanvasNode(b);
    if (!aAware && !bAware) {
        const oriented = normalizeConnection(first.nodeId, second.nodeId, [...nodes], first.handleType);
        if (!oriented) return { error: "invalid_handle" };
        if (existing.some((c) => c.fromNodeId === oriented.fromNodeId && c.toNodeId === oriented.toNodeId))
            return { error: "duplicate" };
        return { connection: oriented };
    }
    const srcHandle = first.handleType === "source" ? first : second;
    const dstHandle = first.handleType === "target" ? first : second;
    const src = nodeById.get(srcHandle.nodeId)!, dst = nodeById.get(dstHandle.nodeId)!;
    if (!isPortAwareCanvasNode(dst)) {
        // Generated images are materialized outputs of a durable Comfy run, not
        // arbitrary workflow inputs. Their provenance permits a typed visual
        // connection to the normal image node's left legacy handle.
        const provenance = dst.metadata?.comfyArtifact;
        const targetKind = getCanvasResourceOutputPort(dst)?.valueKind;
        const sourcePort = getCanvasPort(src, "source", srcHandle.portId);
        const originKind=provenance?({image:"IMAGE",video:"VIDEO",audio:"AUDIO",text:"STRING"} as const)[provenance.kind]:undefined;
        if (!provenance || !sourcePort || !targetKind || sourcePort.valueKind!==targetKind ||
            originKind!==targetKind || !Number.isInteger(provenance.index) || provenance.index<0 ||
            provenance.workflowNodeId!==src.id || provenance.portId!==sourcePort.id ||
            !isPortAwareCanvasNode(src)) return { error: "legacy_target_not_supported" };
        const candidate = {fromNodeId:src.id,fromPortId:sourcePort.id,toNodeId:dst.id,toPortId:"comfy-artifact"};
        if(existing.some(c=>c.fromNodeId===candidate.fromNodeId && c.fromPortId===candidate.fromPortId &&
            c.toNodeId===candidate.toNodeId && c.toPortId===candidate.toPortId)) return {error:"duplicate"};
        if(existing.some(c=>c.toNodeId===dst.id)) return {error:"multiple_sources_for_input"};
        if(createsCycle(src.id,dst.id,existing)) return {error:"cycle"};
        return {connection:candidate};
    }
    const srcPort = isPortAwareCanvasNode(src)
        ? getCanvasPort(src, "source", srcHandle.portId)
        : getCanvasResourceOutputPort(src);
    const dstPort = getCanvasPort(dst, "target", dstHandle.portId);
    if (!srcPort || !dstPort || !getCanvasNodePorts(dst).length) return { error: "missing_port" };
    if (srcPort.valueKind !== dstPort.valueKind) return { error: "incompatible_port_type" };
    const candidate = { fromNodeId: src.id, fromPortId: srcPort.id, toNodeId: dst.id, toPortId: dstPort.id };
    if (existing.some((c) => c.fromNodeId === candidate.fromNodeId && c.fromPortId === candidate.fromPortId
        && c.toNodeId === candidate.toNodeId && c.toPortId === candidate.toPortId)) return { error: "duplicate" };
    if (existing.some((c) => c.toNodeId === dst.id && c.toPortId === dstPort.id)) return { error: "multiple_sources_for_input" };
    if (createsCycle(src.id, dst.id, existing)) return { error: "cycle" };
    return { connection: candidate };
}

/** Repair only new typed Comfy provenance edges for all four artifact kinds.
 * Idempotent for retries, hydration and multi-item fan-out.
 */
export function reconcileComfyArtifactConnections(
    nodes: readonly CanvasNodeData[],
    existing: readonly CanvasConnection[],
    makeId: () => string,
): CanvasConnection[] {
    let result: CanvasConnection[] = [...existing];
    const byId=new Map(nodes.map(n=>[n.id,n]));
    for(const target of nodes) {
        const origin=target.metadata?.comfyArtifact;
        if(!origin || !["image","video","audio","text"].includes(origin.kind))continue;
        const source=byId.get(origin.workflowNodeId);
        if(!source)continue;
        const link=prepareCanvasPortConnection(
            {nodeId:source.id,handleType:"source",portId:origin.portId},
            {nodeId:target.id,handleType:"target"},nodes,result);
        if(link.connection)result=[...result,{id:makeId(),...link.connection}];
    }
    return result;
}

/** Reject malformed persisted/imported port-aware graphs before any eventual execution. */
export function validateCanvasPortConnections(nodes: readonly CanvasNodeData[], connections: readonly CanvasConnection[]) {
    const errors: Array<{ connectionId: string; error: CanvasPortConnectionError }> = [];
    const accepted: CanvasConnection[] = [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const connection of connections) {
        const src = byId.get(connection.fromNodeId), dst = byId.get(connection.toNodeId);
        if (!src || !dst) { errors.push({ connectionId: connection.id, error: "missing_node" }); continue; }
        if (!isPortAwareCanvasNode(src) && !isPortAwareCanvasNode(dst)) { accepted.push(connection); continue; }
        if (!connection.toPortId || (isPortAwareCanvasNode(src) && !connection.fromPortId)) {
            errors.push({ connectionId: connection.id, error: "missing_port" }); continue;
        }
        const result = prepareCanvasPortConnection(
            { nodeId: src.id, handleType: "source", portId: connection.fromPortId },
            { nodeId: dst.id, handleType: "target", portId: connection.toPortId },
            nodes, accepted);
        if (result.error) errors.push({ connectionId: connection.id, error: result.error });
        else accepted.push(connection);
    }
    return errors;
}
