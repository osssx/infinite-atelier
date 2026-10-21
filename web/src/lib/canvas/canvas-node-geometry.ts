import { CanvasNodeType, type CanvasNodeData, type ConnectionHandle, type ViewportTransform } from "@/types/canvas";

export function nodeBounds(nodes: CanvasNodeData[]) {
    return nodes.reduce(
        (acc, node) => ({
            left: Math.min(acc.left, node.position.x),
            top: Math.min(acc.top, node.position.y),
            right: Math.max(acc.right, node.position.x + node.width),
            bottom: Math.max(acc.bottom, node.position.y + node.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
}

// Screen pixels kept clear on every side when fitting the canvas to its nodes. Symmetric by
// necessity: asymmetric padding would stop the content from ending up centred. 80 clears the
// 64px CanvasTopBar; the floating zoom dock / toolbar / minimap at the bottom-left can still
// overlap content, which is a known trade-off rather than something padding can solve.
export const FIT_VIEW_PADDING = 80;

/** Viewport that shows every node, centred, never zoomed in past 100%. */
export function fitViewportToNodes(nodes: CanvasNodeData[], size: { width: number; height: number }, padding = FIT_VIEW_PADDING): ViewportTransform {
    const bounds = nodeBounds(nodes);
    // nodeBounds returns ±Infinity for no nodes at all, and the midpoint of that is NaN rather
    // than Infinity — the divisors below are guarded, this term is not, so bail out first.
    if (!Number.isFinite(bounds.left)) return { x: size.width / 2, y: size.height / 2, k: 1 };
    // max(..., 1) also absorbs a degenerate zero/negative width, where right < left.
    const width = Math.max(bounds.right - bounds.left, 1);
    const height = Math.max(bounds.bottom - bounds.top, 1);
    // The 0.05 floor is shared with wheel/slider zoom, so a spread wider than 20x the container
    // still overflows rather than being fully fitted. Lowering it only here would put the zoom
    // slider out of range and snap on the next wheel event.
    const k = Math.min(Math.max(Math.min((size.width - 2 * padding) / width, (size.height - 2 * padding) / height), 0.05), 1);
    return { x: size.width / 2 - ((bounds.left + bounds.right) / 2) * k, y: size.height / 2 - ((bounds.top + bounds.bottom) / 2) * k, k };
}

/**
 * Wrap an existing multi-selection in a new group without moving its nodes.
 *
 * Coordinates are absolute in this canvas, so the group is placed behind the
 * selected contents and each child receives only a parent group ID.
 * Group nesting is not supported by the current drag/reparent system.
 */
export function groupSelectedCanvasNodes(
    nodes: readonly CanvasNodeData[],
    selectedIds: ReadonlySet<string>,
    groupTemplate: CanvasNodeData,
): { nodes: CanvasNodeData[]; group: CanvasNodeData } | null {
    if (groupTemplate.type !== CanvasNodeType.Group || nodes.some((node) => node.id === groupTemplate.id)) return null;
    const selected = nodes.filter((node) => selectedIds.has(node.id));
    if (selected.length < 2 || selected.length !== selectedIds.size || selected.some((node) => node.type === CanvasNodeType.Group)) return null;
    const bounds = nodeBounds(selected);
    if (![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite)) return null;

    const horizontalPadding = 36;
    const topPadding = 80; // Keep space for the group header.
    const bottomPadding = 36;
    const group: CanvasNodeData = {
        ...groupTemplate,
        position: { x: bounds.left - horizontalPadding, y: bounds.top - topPadding },
        width: Math.max(260, bounds.right - bounds.left + horizontalPadding * 2),
        height: Math.max(180, bounds.bottom - bounds.top + topPadding + bottomPadding),
    };
    const updated = nodes.map((node) => selectedIds.has(node.id)
        ? { ...node, metadata: { ...node.metadata, groupId: group.id } }
        : node);
    return { nodes: [...updated, group], group };
}

export function findGroupDropTarget(movedIds: Set<string>, nodes: CanvasNodeData[]) {
    if (nodes.some((node) => movedIds.has(node.id) && node.type === CanvasNodeType.Group)) return null;
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return null;
    return (
        [...nodes].reverse().find((group) => {
            if (group.type !== CanvasNodeType.Group || movedIds.has(group.id)) return false;
            return movingNodes.some((node) => {
                const centerX = node.position.x + node.width / 2;
                const centerY = node.position.y + node.height / 2;
                return centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height;
            });
        }) || null
    );
}

/**
 * Same result as `findGroupDropTarget`, but without materialising a preview copy of every node:
 * the caller supplies the nodes being dragged (at their original positions), the candidate groups
 * already reversed, and the drag delta. Used on the per-frame drag path, where rebuilding the full
 * node array and rescanning it was O(N x M) per frame.
 *
 * Must stay behaviourally identical to `findGroupDropTarget` — see the equivalence test.
 */
export function findGroupDropTargetFromDelta(movedNodes: readonly CanvasNodeData[], reversedCandidateGroups: readonly CanvasNodeData[], dx: number, dy: number) {
    // Dragging a group itself never re-parents it.
    if (movedNodes.some((node) => node.type === CanvasNodeType.Group)) return null;
    const movingNodes = movedNodes.filter((node) => node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return null;
    return (
        reversedCandidateGroups.find((group) =>
            movingNodes.some((node) => {
                const centerX = node.position.x + dx + node.width / 2;
                const centerY = node.position.y + dy + node.height / 2;
                return centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height;
            }),
        ) || null
    );
}

export function snapNodesIntoGroup(movedIds: Set<string>, nodes: CanvasNodeData[], group: CanvasNodeData) {
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return nodes;
    const pad = 24;
    const bounds = nodeBounds(movingNodes);
    const left = group.position.x + pad;
    const top = group.position.y + pad;
    const right = group.position.x + group.width - pad;
    const bottom = group.position.y + group.height - pad;
    const dx = bounds.right - bounds.left > right - left ? left - bounds.left : bounds.left < left ? left - bounds.left : bounds.right > right ? right - bounds.right : 0;
    const dy = bounds.bottom - bounds.top > bottom - top ? top - bounds.top : bounds.top < top ? top - bounds.top : bounds.bottom > bottom ? bottom - bounds.bottom : 0;
    return nodes.map((node) => {
        if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
        return { ...node, position: { x: node.position.x + dx, y: node.position.y + dy }, metadata: { ...node.metadata, groupId: group.id } };
    });
}

export function findContainingGroupId(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const centerX = node.position.x + node.width / 2;
    const centerY = node.position.y + node.height / 2;
    return (
        [...nodes]
            .reverse()
            .find((group) => group.type === CanvasNodeType.Group && group.id !== node.id && centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height)?.id ||
        undefined
    );
}

export function getConnectionTargetAnchor(node: CanvasNodeData, current: ConnectionHandle) {
    return {
        x: current.handleType === "source" ? node.position.x : node.position.x + node.width,
        y: node.position.y + node.height / 2,
    };
}

export function normalizeConnection(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target") {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    if (!first || !second) return null;
    return orientConnection(first, second, firstHandleType);
}

/** Index-backed variant — no linear scan. Used on the per-mousemove connect-drag path. */
export function normalizeConnectionFromIndex(nodeById: ReadonlyMap<string, CanvasNodeData>, firstNodeId: string, secondNodeId: string, firstHandleType: "source" | "target") {
    const first = nodeById.get(firstNodeId);
    const second = nodeById.get(secondNodeId);
    if (!first || !second) return null;
    return orientConnection(first, second, firstHandleType);
}

/** Shared decision table, so the array and index entry points cannot drift apart. */
function orientConnection(first: CanvasNodeData, second: CanvasNodeData, firstHandleType: "source" | "target") {
    if (first.id === second.id) return null;
    if (first.type === CanvasNodeType.Group || second.type === CanvasNodeType.Group) return null;
    if (first.type === CanvasNodeType.Config && second.type === CanvasNodeType.Config) return null;
    if (second.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    if (first.type === CanvasNodeType.Config && firstHandleType === "target") return { fromNodeId: second.id, toNodeId: first.id };
    if (first.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    return { fromNodeId: first.id, toNodeId: second.id };
}
