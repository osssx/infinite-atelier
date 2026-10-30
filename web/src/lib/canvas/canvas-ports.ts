import { CanvasNodeType, type CanvasNodeData, type CanvasPortDescriptor, type CanvasPortValueKind, type ConnectionHandle } from "@/types/canvas";
/** No registry/i18n import here: geometry, culling and overview paths run in pure/node test environments. */
const portResolvers = new Map<string, (node: CanvasNodeData) => readonly CanvasPortDescriptor[]>();

export function registerCanvasPortResolver(type: string, resolve?: (node: CanvasNodeData) => readonly CanvasPortDescriptor[]) {
    if (resolve) portResolvers.set(type, resolve);
    else portResolvers.delete(type);
}

/** Stable internal node type. Port descriptors become available after template binding. */
export const COMFY_WORKFLOW_MOCK_TYPE = "comfy:workflow";

/** Legacy test fixtures only. Never expose these placeholder ports on new nodes. */
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
    // Historical unbound nodes may still carry placeholder comfyPorts in saved
    // metadata. Never render or accept connections to those phantom sockets.
    if (node.type === COMFY_WORKFLOW_MOCK_TYPE &&
        (!node.metadata?.comfyWorkflow?.templateId || !node.metadata.comfyWorkflow.templateRevision)) return [];
    return portResolvers.get(node.type)?.(node) || [];
}
/** Presentation only: Comfy INT/FLOAT/BOOLEAN inputs are editable in the
 * parameter inspector but have no matching canvas resource source nodes.
 * STRING inputs, including those with dropdown choices, stay connectable.
 * Keep all descriptors in metadata and the connection validator so imported
 * or older projects retain any existing typed links.
 */
export function canToggleComfyInputPortVisibility(port: Pick<CanvasPortDescriptor, "direction" | "valueKind">): boolean {
    return port.direction === "target" && !["INT", "FLOAT", "BOOLEAN"].includes(port.valueKind);
}
export function getVisibleComfyWorkflowPorts(ports: readonly CanvasPortDescriptor[]): CanvasPortDescriptor[] {
    return ports.filter(port => port.direction !== "target" ||
        (canToggleComfyInputPortVisibility(port) && (port.required || port.canvasVisible !== false)));
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

/** Workflow ports form a centered stack with a stable pitch regardless of
 * node height. For old compact persisted nodes, compress only as much as fits.
 * Other port-aware node types keep the original full-height distribution.
 */
function getCanvasPortPitch(node: CanvasNodeData, count: number): number {
    if (count <= 1) return 0;
    const available = Math.max(0, node.height - CANVAS_PORT_EDGE_PADDING * 2);
    const fittedPitch = available / (count - 1);
    return node.type === COMFY_WORKFLOW_MOCK_TYPE
        ? Math.min(CANVAS_PORT_MIN_PITCH, fittedPitch)
        : fittedPitch;
}

export function getMinimumCanvasPortNodeHeight(ports: readonly CanvasPortDescriptor[]): number {
    const inputs = ports.filter((port) => port.direction === "target").length;
    const outputs = ports.filter((port) => port.direction === "source").length;
    const maxCount = Math.max(inputs, outputs);
    return Math.max(160, CANVAS_PORT_EDGE_PADDING * 2 + Math.max(0, maxCount - 1) * CANVAS_PORT_MIN_PITCH);
}

export function getCanvasPortHitSize(node: CanvasNodeData, direction: "source" | "target"): number {
    const count = getCanvasVisiblePorts(node).filter((port) => port.direction === direction).length;
    if (count <= 1) return CANVAS_PORT_HIT_MAX;
    const pitch = getCanvasPortPitch(node, count);
    // Match the actual rendered centers, including compact legacy nodes.
    // Never let one port's hover hitbox cover its neighbour.
    return Math.max(1, Math.min(CANVAS_PORT_HIT_MAX, pitch - CANVAS_PORT_HIT_GAP));
}

/** Shared DOM + SVG port layout: no DOM measurement, stable during pan/zoom. */
export function getCanvasPortOffset(node: CanvasNodeData, direction: "source" | "target", portId: string): number {
    const ports = getCanvasVisiblePorts(node).filter((port) => port.direction === direction);
    const index = ports.findIndex((port) => port.id === portId);
    if (index < 0) return node.height / 2;
    // A single typed port uses exactly the same Y anchor as an ordinary node.
    if (ports.length === 1) return node.height / 2;
    const pitch = getCanvasPortPitch(node, ports.length);
    // The left and right groups center independently. Expanding the node
    // moves the whole group with its midpoint but does not spread its ports.
    return node.height / 2 + (index - (ports.length - 1) / 2) * pitch;
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
