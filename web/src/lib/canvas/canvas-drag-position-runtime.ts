import type { CanvasNodeData, Position } from "@/types/canvas";

/** Per-frame drag translations stay outside persistent node data. */
export type CanvasDragPositionOverrides = ReadonlyMap<string, Position>;

export function canvasDragDeltaFromPointer(start: Position, client: Position, scale: number): Position {
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    return { x: (client.x - start.x) / safeScale, y: (client.y - start.y) / safeScale };
}

/** A blur/cancel often carries no coordinates; keep the newest already-recorded pointermove. */
export function resolveCanvasDragFinishDelta(
    start: Position,
    client: Position | null,
    latestDelta: Position,
    scale: number,
): Position {
    return client ? canvasDragDeltaFromPointer(start, client, scale) : latestDelta;
}

let currentOverrides: CanvasDragPositionOverrides = new Map();
let version = 0;
const listeners = new Set<() => void>();
const elementsByNodeId = new Map<string, Set<HTMLElement>>();

function applyElementOverride(element: HTMLElement, delta: Position | undefined) {
    if (!delta || (delta.x === 0 && delta.y === 0)) {
        element.style.removeProperty("translate");
        return;
    }
    element.style.setProperty("translate", `${delta.x}px ${delta.y}px`);
}

function sameOverrides(left: CanvasDragPositionOverrides, right: CanvasDragPositionOverrides) {
    if (left.size !== right.size) return false;
    for (const [id, delta] of left) {
        const other = right.get(id);
        if (!other || other.x !== delta.x || other.y !== delta.y) return false;
    }
    return true;
}

export function getCanvasDragPositionOverrides(): CanvasDragPositionOverrides {
    return currentOverrides;
}

export function getCanvasDragPositionVersion(): number {
    return version;
}

export function subscribeCanvasDragPositionOverrides(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function setCanvasDragPositionOverrides(next: CanvasDragPositionOverrides): void {
    if (sameOverrides(currentOverrides, next)) return;
    const changedIds = new Set([...currentOverrides.keys(), ...next.keys()]);
    for (const id of [...changedIds]) {
        const previous = currentOverrides.get(id);
        const upcoming = next.get(id);
        if (previous?.x === upcoming?.x && previous?.y === upcoming?.y) changedIds.delete(id);
    }
    currentOverrides = new Map(next);
    for (const nodeId of changedIds) {
        const elements = elementsByNodeId.get(nodeId);
        if (!elements) continue;
        const delta = currentOverrides.get(nodeId);
        for (const element of elements) applyElementOverride(element, delta);
    }
    version += 1;
    listeners.forEach((listener) => listener());
}

export function clearCanvasDragPositionOverrides(): void {
    setCanvasDragPositionOverrides(new Map());
}

/** Register both the compact and full LOD roots so either stays aligned during a handoff. */
export function registerCanvasDragPositionElement(nodeId: string, element: HTMLElement): () => void {
    let elements = elementsByNodeId.get(nodeId);
    if (!elements) {
        elements = new Set();
        elementsByNodeId.set(nodeId, elements);
    }
    elements.add(element);
    applyElementOverride(element, currentOverrides.get(nodeId));
    return () => {
        const registered = elementsByNodeId.get(nodeId);
        registered?.delete(element);
        if (!registered?.size) elementsByNodeId.delete(nodeId);
        applyElementOverride(element, undefined);
    };
}

/** Merge a drag delta into the latest node state, preserving concurrent metadata updates. */
export function applyCanvasDragDelta(
    nodes: CanvasNodeData[],
    initialPositions: ReadonlyMap<string, Position>,
    delta: Position,
): CanvasNodeData[] {
    return nodes.map((node) => {
        const initial = initialPositions.get(node.id);
        return initial ? { ...node, position: { x: initial.x + delta.x, y: initial.y + delta.y } } : node;
    });
}
