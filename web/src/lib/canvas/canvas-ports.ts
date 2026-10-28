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
/** Presentation only: Comfy INT/FLOAT/BOOLEAN inputs are editable in the
 * parameter inspector but have no matching canvas resource source nodes.
 * STRING inputs, including those with dropdown choices, stay connectable.
 * Keep all descriptors in metadata and the connection validator so imported
 * or older projects retain any existing typed links.
 */
export function getVisibleComfyWorkflowPorts(ports: readonly CanvasPortDescriptor[]): CanvasPortDescriptor[] {
    return ports.filter(port=>port.direction!=="target" ||
        (port.valueKind!=="INT" && port.valueKind!=="FLOAT" && port.valueKind!=="BOOLEAN"));
}
export function getCanvasVisiblePorts(node: CanvasNodeData): readonly CanvasPortDescriptor[] {
    const ports=getCanvasNodePorts(node);
    return node.type===COMFY_WORKFLOW_MOCK_TYPE?getVisibleComfyWorkflowPorts(ports):ports;
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

/**
 * Dense Comfy inputs must remain separately hit-testable. The old 48px hit regions
 * overlapped when 11 ports were squeezed into a 265px node (roughly 18px apart).
 * New bindings expand the node; older persisted nodes get collision-free hit regions.
 */
export const CANVAS_PORT_MIN_PITCH = 30;
export const CANVAS_PORT_HIT_MAX = 28;
export const CANVAS_PORT_HIT_GAP = 2;
/** Equal top/bottom inset centers every typed port group on the legacy handle's Y midpoint. */
export const CANVAS_PORT_EDGE_PADDING = 40;

export function getMinimumCanvasPortNodeHeight(ports: readonly CanvasPortDescriptor[]): number {
    const inputs = ports.filter((port) => port.direction === "target").length;
    const outputs = ports.filter((port) => port.direction === "source").length;
    const maxCount = Math.max(inputs, outputs);
    return Math.max(160, CANVAS_PORT_EDGE_PADDING * 2 + Math.max(0, maxCount - 1) * CANVAS_PORT_MIN_PITCH);
}

export function getCanvasPortHitSize(node: CanvasNodeData, direction: "source" | "target"): number {
    const count = getCanvasVisiblePorts(node).filter((port) => port.direction === direction).length;
    if (count <= 1) return CANVAS_PORT_HIT_MAX;
    const pitch = Math.max(0, node.height - CANVAS_PORT_EDGE_PADDING * 2) / (count - 1);
    // Never let one port's hover hitbox cover its neighbour on compact old nodes.
    return Math.max(1, Math.min(CANVAS_PORT_HIT_MAX, pitch - CANVAS_PORT_HIT_GAP));
}

/** Shared DOM + SVG port layout: no DOM measurement, stable during pan/zoom. */
export function getCanvasPortOffset(node: CanvasNodeData, direction: "source" | "target", portId: string): number {
    const ports = getCanvasVisiblePorts(node).filter((port) => port.direction === direction);
    const index = ports.findIndex((port) => port.id === portId);
    if (index < 0) return node.height / 2;
    // A single typed port uses exactly the same Y anchor as an ordinary node.
    if (ports.length === 1) return node.height / 2;
    const space = Math.max(0, node.height - CANVAS_PORT_EDGE_PADDING * 2);
    // Symmetric distribution: (first + last) / 2 == node.height / 2.
    return node.height / 2 - space / 2 + (space * index) / (ports.length - 1);
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
    const ports = getCanvasVisiblePorts(node).filter((port) => port.direction === direction);
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
