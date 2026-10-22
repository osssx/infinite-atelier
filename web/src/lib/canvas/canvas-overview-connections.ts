import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { connectionControlPoints } from "./canvas-connection-culling";

export type OverviewCurve = {
    id: string;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    x3: number;
    y3: number;
};

export type OverviewPaths = {
    ordinary: string;
    highlighted: string;
    hit: string;
    curves: OverviewCurve[];
};

/** Builds a small number of SVG paths without losing the exact existing Bézier geometry. */
export function buildOverviewConnectionPaths(
    connections: readonly CanvasConnection[],
    nodeById: ReadonlyMap<string, CanvasNodeData>,
    selectedId: string | null,
    highlightedIds: ReadonlySet<string>,
): OverviewPaths {
    const ordinary: string[] = [];
    const highlighted: string[] = [];
    const hit: string[] = [];
    const curves: OverviewCurve[] = [];
    for (const connection of connections) {
        if (connection.id === selectedId) continue; // Selected edge retains its own delete button.
        const from = nodeById.get(connection.fromNodeId);
        const to = nodeById.get(connection.toNodeId);
        if (!from || !to) continue;
        const p = connectionControlPoints(from, to, connection);
        const d = `M ${p.startX} ${p.startY} C ${p.control1X} ${p.control1Y}, ${p.control2X} ${p.control2Y}, ${p.endX} ${p.endY}`;
        (highlightedIds.has(connection.id) ? highlighted : ordinary).push(d);
        hit.push(d);
        curves.push({
            id: connection.id, x0: p.startX, y0: p.startY, x1: p.control1X,
            y1: p.control1Y, x2: p.control2X, y2: p.control2Y, x3: p.endX, y3: p.endY,
        });
    }
    return { ordinary: ordinary.join(" "), highlighted: highlighted.join(" "), hit: hit.join(" "), curves };
}

function distanceSqToSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, (dx * (x - ax) + dy * (y - ay)) / (dx * dx + dy * dy || 1)));
    return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2;
}

/** Called on pointer click/context menu only, never while painting or panning. */
export function findOverviewConnectionAtPoint(
    curves: readonly OverviewCurve[], x: number, y: number, maxDistance = 8,
): string | null {
    let closest: string | null = null;
    let closestSq = maxDistance * maxDistance;
    for (const c of curves) {
        // Conservative cubic hull; avoids sampling distant edges on a crowded canvas.
        const minX = Math.min(c.x0, c.x1, c.x2, c.x3) - maxDistance;
        const maxX = Math.max(c.x0, c.x1, c.x2, c.x3) + maxDistance;
        const minY = Math.min(c.y0, c.y1, c.y2, c.y3) - maxDistance;
        const maxY = Math.max(c.y0, c.y1, c.y2, c.y3) + maxDistance;
        if (x < minX || x > maxX || y < minY || y > maxY) continue;
        let px = c.x0, py = c.y0;
        // Very long edges need extra samples to maintain the original 16-world-unit hit width.
        // This is only evaluated on click/context menu, never during pan or render.
        const steps = Math.min(256, Math.max(32, Math.ceil((Math.abs(c.x3 - c.x0) + Math.abs(c.y3 - c.y0)) / 500)));
        for (let i = 1; i <= steps; i++) {
            const t = i / steps, u = 1 - t;
            const nx = u ** 3 * c.x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x3;
            const ny = u ** 3 * c.y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y3;
            const d = distanceSqToSegment(x, y, px, py, nx, ny);
            if (d <= closestSq) { closestSq = d; closest = c.id; }
            px = nx; py = ny;
        }
    }
    return closest;
}
