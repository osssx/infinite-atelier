import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { dramaReferenceImageKeys, type DramaAssetReference } from "./canvas-drama-pipeline";

function readLegacyReferences(node: CanvasNodeData): DramaAssetReference[] | undefined {
    const text = node.metadata?.dramaDraft?.trim() || node.metadata?.dramaConfirmed?.trim();
    if (!text) return [];
    try {
        const {references} = JSON.parse(text);
        if (!Array.isArray(references)) return undefined;
        const slots = new Set<string>();
        for (const ref of references) {
            if (!ref || typeof ref.assetId !== "string" || !ref.assetId ||
                (ref.variantId !== undefined && typeof ref.variantId !== "string") ||
                typeof ref.requiredForRendering !== "boolean" ||
                (ref.imageStorageKeys !== undefined && !Array.isArray(ref.imageStorageKeys)) ||
                (ref.imageStorageKey !== undefined && typeof ref.imageStorageKey !== "string")) return undefined;
            const slot = JSON.stringify([ref.assetId, ref.variantId]);
            if (slots.has(slot) || dramaReferenceImageKeys(ref).some(key => typeof key !== "string" || !/^cas:[a-f0-9]{64}$/.test(key))) return undefined;
            slots.add(slot);
        }
        return references.map(ref => ({
            assetId:ref.assetId, variantId:ref.variantId, requiredForRendering:ref.requiredForRendering,
            imageStorageKeys:[...new Set(dramaReferenceImageKeys(ref))],
        }));
    } catch { return undefined; }
}

export function mergeLegacyDramaAssets(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const byId = new Map(nodes.map(node => [node.id,node]));
    const replacements = new Map<string, CanvasNodeData>();
    const removed = new Map<string,string>();
    for (const node of nodes) {
        if (node.type !== "drama:asset_references") continue;
        const incoming = connections.filter(edge => edge.toNodeId === node.id);
        const outgoing = connections.filter(edge => edge.fromNodeId === node.id);
        const parent = byId.get(incoming[0]?.fromNodeId);
        if (incoming.length !== 1 || parent?.type !== "drama:assets" || parent.metadata?.dramaAssetReferences ||
            parent.metadata?.groupId !== node.metadata?.groupId ||
            connections.filter(edge => edge.fromNodeId === parent.id && byId.get(edge.toNodeId)?.type === node.type).length !== 1 ||
            [...incoming,...outgoing].some(edge => edge.fromPortId || edge.toPortId)) continue;
        if (outgoing.some(edge => {
            const target = byId.get(edge.toNodeId);
            if (target?.type !== "drama:first_frames" && target?.type !== "image") return true;
            return connections.some(other => other.toNodeId === target.id && other.fromNodeId !== node.id &&
                (other.fromNodeId === parent.id || (target.type === "drama:first_frames" &&
                ["drama:assets","drama:asset_references"].includes(byId.get(other.fromNodeId)?.type ?? ""))));
        })) continue;
        const references = readLegacyReferences(node);
        if (!references) continue;
        replacements.set(parent.id, {...parent, title: parent.title === "资产规划" ? "资产" : parent.title,
            metadata:{...parent.metadata, dramaAssetReferences:references}});
        removed.set(node.id,parent.id);
    }
    if (!removed.size) return {nodes, connections, changed:false};
    return {
        nodes:nodes.filter(node => !removed.has(node.id)).map(node => replacements.get(node.id) ?? node),
        connections:connections.filter(edge => !removed.has(edge.toNodeId)).map(edge => {
            const parent = removed.get(edge.fromNodeId);
            return parent ? {...edge,fromNodeId:parent} : edge;
        }),
        changed:true,
    };
}
