import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import i18n from "@/i18n";
import { buildCanvasGraphIndex, type CanvasGraphIndex } from "@/lib/canvas/canvas-graph-index";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type CanvasResourceKind = "image" | "video" | "audio" | "text";

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    text?: string;
    active: boolean;
};

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return buildNodeMentionReferencesFromIndex(buildCanvasGraphIndex(nodes, connections), node.id);
}

/** Index-backed variant — O(degree) instead of O(N+E) per call. */
export function buildNodeMentionReferencesFromIndex(index: CanvasGraphIndex, nodeId: string) {
    return labelResourceNodes(getMentionResourceNodesFromIndex(index, nodeId), true);
}

export function buildCanvasResourceReferences(nodes: CanvasNodeData[]) {
    return labelResourceNodes(nodes, true);
}

export async function resolveCanvasReferenceImages(references: CanvasResourceReference[], nodes: CanvasNodeData[]) {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    return Promise.all(references.filter((reference) => reference.kind === "image").map(async (reference) => {
        const node = nodesById.get(reference.nodeId);
        if (!node) throw new Error(i18n.t("agent.composer.mentions.resourceMissing", { title: reference.title }));
        const metadata = node.metadata;
        const dataUrl = await imageToDataUrl({ storageKey: metadata?.storageKey, url: reference.previewUrl });
        if (!dataUrl.startsWith("data:image/")) throw new Error(i18n.t("agent.composer.mentions.imageReadFailed", { title: reference.title }));
        const meta = metadata?.naturalWidth && metadata.naturalHeight
            ? { width: metadata.naturalWidth, height: metadata.naturalHeight, mimeType: metadata.mimeType || dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" }
            : await readImageMeta(dataUrl);
        return {
            id: `canvas:${node.id}`,
            name: reference.title,
            type: metadata?.mimeType || meta.mimeType,
            size: metadata?.bytes || getDataUrlByteSize(dataUrl),
            width: meta.width,
            height: meta.height,
            url: reference.previewUrl || dataUrl,
            dataUrl,
        };
    }));
}

export function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return getMentionResourceNodesFromIndex(buildCanvasGraphIndex(nodes, connections), nodeId);
}

export function getMentionResourceNodesFromIndex(index: CanvasGraphIndex, nodeId: string) {
    const configInputs = getConnectedConfigResourceNodesFromIndex(index, nodeId);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextResourceNodesFromIndex(index, nodeId);
    if (ownInputs.length) return ownInputs;
    const node = index.nodeById.get(nodeId);
    return node && isResourceNode(node) ? [node] : [];
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return getGenerationResourceNodesFromIndex(buildCanvasGraphIndex(nodes, connections), nodeId);
}

/**
 * Same three tiers as the mention variant, minus the last one: generation has no self fallback.
 * The two must stay separate — folding them together would change what gets sent for generation.
 */
export function getGenerationResourceNodesFromIndex(index: CanvasGraphIndex, nodeId: string) {
    const configInputs = getConnectedConfigResourceNodesFromIndex(index, nodeId);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextResourceNodesFromIndex(index, nodeId);
    if (ownInputs.length) return ownInputs;
    return [];
}

/** Inbound resource nodes, in `connections` array order — that order drives the reference labels. */
function getContextResourceNodesFromIndex(index: CanvasGraphIndex, nodeId: string) {
    const inbound = index.inboundByNodeId.get(nodeId);
    if (!inbound) return [];
    const result: CanvasNodeData[] = [];
    for (const connection of inbound) {
        const node = index.nodeById.get(connection.fromNodeId);
        if (node && isResourceNode(node)) result.push(node);
    }
    return result;
}

function getConnectedConfigResourceNodesFromIndex(index: CanvasGraphIndex, nodeId: string) {
    // First matching outbound edge wins, preserving the old `connections.find` semantics.
    const configConnection = index.outboundByNodeId.get(nodeId)?.find((connection) => index.nodeById.get(connection.toNodeId)?.type === CanvasNodeType.Config);
    if (!configConnection) return [];
    return getContextResourceNodesFromIndex(index, configConnection.toNodeId).filter((node) => node.id !== nodeId);
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0 };
    return nodes.flatMap((node): CanvasResourceReference[] => {
        const kind = resourceKind(node);
        if (!kind) return [];
        const resource = getNodeDefinition(node.type)?.resource?.(node);
        const index = counts[kind]++;
        const label = labelForKind(kind, index);
        return [
            {
                id: node.id,
                nodeId: node.id,
                kind,
                label,
                title: node.title || label,
                previewUrl: node.metadata?.content || resource?.url,
                text: resourceText(node),
                active,
            },
        ];
    });
}

function labelForKind(kind: CanvasResourceKind, index: number) {
    if (kind === "image") return imageReferenceLabel(index);
    if (kind === "video") return i18n.t("canvas.configNode.videoReferences") + ` ${index + 1}`;
    if (kind === "audio") return i18n.t("canvas.configNode.audioReferences") + ` ${index + 1}`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

export function isResourceNode(node: CanvasNodeData) {
    return Boolean(resourceKind(node));
}

function resourceText(node: CanvasNodeData): string | undefined {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt;
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    return resource?.kind === "text" ? resource.text : undefined;
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return "image";
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return "video";
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return "audio";
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
    // Plugin nodes declare their input eligibility through definition.resource.
    return getNodeDefinition(node.type)?.resource?.(node)?.kind || null;
}
