import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasPortValueKind } from "@/types/canvas";
import { getCanvasResourceOutputPort, isPortAwareCanvasNode } from "./canvas-ports";

/** Immutable scalar contents captured at one canvas revision. Asset bytes are frozen separately on upload. */
export type PreparedExternalScalar = Readonly<{
    kind: "scalar";
    sourceNodeId: string;
    sourcePortId: "text";
    valueKind: "STRING";
    value: string;
}>;
export type PreparedExternalAsset = Readonly<{
    kind: "asset";
    sourceNodeId: string;
    sourcePortId: string;
    valueKind: "IMAGE" | "VIDEO" | "AUDIO";
    storageKey?: string;
    url?: string;
    imageId?: string;
    mimeType?: string;
}>;
export type PreparedExternalInput = PreparedExternalScalar | PreparedExternalAsset;

/**
 * Snapshot values for EXPLICIT typed edges only. Never concatenate ordinary canvas references.
 * This is a pure, local preparation step; run submission must first upload each asset Blob
 * and replace the locator with a server-issued immutable {assetId,sha256}.
 */
export function prepareCanvasExternalInputSnapshot(
    nodes: readonly CanvasNodeData[],
    connections: readonly CanvasConnection[],
): PreparedExternalInput[] {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const inputs = new Map<string, PreparedExternalInput>();
    for (const edge of connections) {
        if (!edge.toPortId) continue;
        const source = nodeById.get(edge.fromNodeId);
        const target = nodeById.get(edge.toNodeId);
        if (!source || !target || !isPortAwareCanvasNode(target)) throw new Error("external_source_missing");
        if (isPortAwareCanvasNode(source)) continue; // internal Comfy link, not an external asset
        const port = getCanvasResourceOutputPort(source);
        if (!port || port.id !== edge.fromPortId) throw new Error("external_source_port_invalid");
        const key = source.id + "\0" + port.id;
        if (inputs.has(key)) continue;
        const meta = source.metadata;
        if (source.type === CanvasNodeType.Text) {
            const value = Object.hasOwn(meta ?? {}, "content") ? meta?.content : meta?.prompt;
            inputs.set(key, Object.freeze({
                kind: "scalar" as const, sourceNodeId: source.id, sourcePortId: "text" as const,
                valueKind: "STRING" as const, value: value ?? "",
            }));
            continue;
        }
        let storageKey = meta?.storageKey;
        let url = meta?.content;
        let mimeType = meta?.mimeType;
        let imageId: string | undefined;
        if (source.type === CanvasNodeType.Image && meta?.images?.length) {
            const selected = meta.primaryImageId
                ? meta.images.find((image) => image.id === meta.primaryImageId)
                : meta.images.length === 1 ? meta.images[0] : undefined;
            if (!selected) throw new Error("primary_image_not_selected");
            storageKey = selected.storageKey;
            url = selected.content;
            mimeType = selected.mimeType;
            imageId = selected.id;
        }
        if (!storageKey && !url) throw new Error("external_asset_unavailable");
        const kind = port.valueKind as Extract<CanvasPortValueKind, "IMAGE" | "VIDEO" | "AUDIO">;
        inputs.set(key, Object.freeze({
            kind: "asset" as const, sourceNodeId: source.id, sourcePortId: port.id,
            valueKind: kind, storageKey, url, imageId, mimeType,
        }));
    }
    return [...inputs.values()];
}

export type InputValueDecision =
    | { source: "edge"; value: unknown }
    | { source: "override"; value: unknown }
    | { source: "default"; value: unknown }
    | { source: "template"; value: unknown }
    | { source: "disconnect" };

/** Same precedence as the backend contract. Presence, never truthiness, determines a value. */
export function resolveCanvasInputValue(
    portId: string,
    options: {
        edge?: { value: unknown };
        overrides: Readonly<Record<string, unknown>>;
        defaults: Readonly<Record<string, unknown>>;
        template: Readonly<Record<string, unknown>>;
        absentPolicy?: "keep-template" | "disconnect";
    },
): InputValueDecision {
    if (options.edge !== undefined) return { source: "edge", value: options.edge.value };
    if (Object.hasOwn(options.overrides, portId)) return { source: "override", value: options.overrides[portId] };
    if (Object.hasOwn(options.defaults, portId)) return { source: "default", value: options.defaults[portId] };
    if (options.absentPolicy === "disconnect") return { source: "disconnect" };
    if (Object.hasOwn(options.template, portId)) return { source: "template", value: options.template[portId] };
    return { source: "disconnect" };
}
