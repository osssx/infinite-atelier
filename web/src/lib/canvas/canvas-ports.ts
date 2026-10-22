import { CanvasNodeType, type CanvasNodeData, type CanvasPortDescriptor, type CanvasPortValueKind, type ConnectionHandle } from "@/types/canvas";
/** No registry/i18n import here: geometry, culling and overview paths run in pure/node test environments. */
const portResolvers = new Map<string, (node: CanvasNodeData) => readonly CanvasPortDescriptor[]>();

export function registerCanvasPortResolver(type: string, resolve?: (node: CanvasNodeData) => readonly CanvasPortDescriptor[]) {
    if (resolve) portResolvers.set(type, resolve);
    else portResolvers.delete(type);
}

/** The mock type is intentionally not executable; later phases replace ports from template revisions. */
export const COMFY_WORKFLOW_MOCK_TYPE = "comfy:workflow";

export const MOCK_COMFY_PORTS: CanvasPortDescriptor[] = [
    { id: "prompt", label: "Prompt", direction: "target", valueKind: "STRING", required: true },
    { id: "image", label: "Image", direction: "target", valueKind: "IMAGE" },
    { id: "strength", label: "Strength", direction: "target", valueKind: "FLOAT" },
    { id: "result", label: "Result", direction: "source", valueKind: "IMAGE" },
    { id: "mask", label: "Mask", direction: "source", valueKind: "MASK" },
];

const RESOURCE_PORTS: Partial<Record<CanvasNodeType, CanvasPortDescriptor>> = {
    [CanvasNodeType.Text]: { id: "text", label: "Text", direction: "source", valueKind: "STRING" },
    [CanvasNodeType.Image]: { id: "image", label: "Image", direction: "source", valueKind: "IMAGE" },
    [CanvasNodeType.Video]: { id: "video", label: "Video", direction: "source", valueKind: "VIDEO" },
    [CanvasNodeType.Audio]: { id: "audio", label: "Audio", direction: "source", valueKind: "AUDIO" },
};

export function isPortAwareCanvasNode(node: CanvasNodeData): boolean {
    return portResolvers.has(node.type);
}

export function getCanvasNodePorts(node: CanvasNodeData): readonly CanvasPortDescriptor[] {
    return portResolvers.get(node.type)?.(node) || [];
}

export function getCanvasResourceOutputPort(node: CanvasNodeData): CanvasPortDescriptor | undefined {
    return RESOURCE_PORTS[node.type as CanvasNodeType];
}

export function getCanvasPort(node: CanvasNodeData, direction: "source" | "target", portId: string | undefined): CanvasPortDescriptor | undefined {
    if (!portId) return undefined;
    const ports = getCanvasNodePorts(node);
    if (ports.length) return ports.find((port) => port.id === portId && port.direction === direction);
    return direction === "source" && getCanvasResourceOutputPort(node)?.id === portId ? getCanvasResourceOutputPort(node) : undefined;
}

/** Shared DOM + SVG port layout: no DOM measurement, stable during pan/zoom. */
export function getCanvasPortOffset(node: CanvasNodeData, direction: "source" | "target", portId: string): number {
    const ports = getCanvasNodePorts(node).filter((port) => port.direction === direction);
    const index = ports.findIndex((port) => port.id === portId);
    if (index < 0) return node.height / 2;
    const top = Math.min(65, Math.max(22, node.height * 0.22));
    const space = Math.max(0, node.height - top - 22);
    return top + (ports.length === 1 ? space / 2 : (space * index) / (ports.length - 1));
}

export function getCanvasPortAnchor(node: CanvasNodeData, direction: "source" | "target", portId?: string) {
    return {
        x: direction === "source" ? node.position.x + node.width : node.position.x,
        y: portId && isPortAwareCanvasNode(node) && getCanvasPort(node, direction, portId)
            ? node.position.y + getCanvasPortOffset(node, direction, portId)
            : node.position.y + node.height / 2,
    };
}

export function pickCanvasDropHandle(node: CanvasNodeData, current: ConnectionHandle, worldY: number): ConnectionHandle | null {
    const direction = current.handleType === "source" ? "target" : "source";
    if (!isPortAwareCanvasNode(node)) return { nodeId: node.id, handleType: direction };
    const ports = getCanvasNodePorts(node).filter((port) => port.direction === direction);
    if (!ports.length) return null;
    let best = ports[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const port of ports) {
        const distance = Math.abs(node.position.y + getCanvasPortOffset(node, direction, port.id) - worldY);
        if (distance < bestDistance) { best = port; bestDistance = distance; }
    }
    return { nodeId: node.id, handleType: direction, portId: best.id };
}

export function getHandleValueKind(node: CanvasNodeData, handle: ConnectionHandle): CanvasPortValueKind | undefined {
    const port = getCanvasPort(node, handle.handleType, handle.portId);
    return port?.valueKind || (handle.handleType === "source" && !isPortAwareCanvasNode(node) ? getCanvasResourceOutputPort(node)?.valueKind : undefined);
}
