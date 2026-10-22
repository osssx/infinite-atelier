import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import { getCanvasPortAnchor } from "./canvas-ports";

export type WorldRect = { left: number; top: number; right: number; bottom: number };

/**
 * World-space rectangle covering what the viewport can show, optionally grown by `margin`.
 * `margin` is in world units — divide CSS pixels by `viewport.k` before passing them in.
 */
export function worldViewRect(viewport: ViewportTransform, size: { width: number; height: number }, margin = 0): WorldRect {
    const left = -viewport.x / viewport.k - margin;
    const top = -viewport.y / viewport.k - margin;
    return {
        left,
        top,
        right: left + size.width / viewport.k + margin * 2,
        bottom: top + size.height / viewport.k + margin * 2,
    };
}

/**
 * Control points of the cubic drawn by ConnectionPath, mirrored here so culling and rendering
 * cannot drift apart:
 *   M start C (start.x + curvature, start.y), (end.x - curvature, end.y), end
 * where curvature = max(|end.x - start.x| / 2, 50).
 */
export function connectionControlPoints(from: CanvasNodeData, to: CanvasNodeData, connection?: CanvasConnection) {
    const start = getCanvasPortAnchor(from, "source", connection?.fromPortId);
    const end = getCanvasPortAnchor(to, "target", connection?.toPortId);
    const startX = start.x;
    const startY = start.y;
    const endX = end.x;
    const endY = end.y;
    const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
    return {
        startX,
        startY,
        endX,
        endY,
        control1X: startX + curvature,
        control1Y: startY,
        control2X: endX - curvature,
        control2Y: endY,
    };
}

/**
 * Conservative AABB of the curve: the AABB of its four control points. A Bézier lies inside the
 * convex hull of its control points, so this can never miss part of the curve.
 *
 * The endpoints alone are not enough — a backwards connection (end.x < start.x) bulges past both
 * of them, and such a curve can cross the viewport while both endpoints sit outside it.
 */
export function connectionControlHull(from: CanvasNodeData, to: CanvasNodeData, connection?: CanvasConnection): WorldRect {
    const { startX, startY, endX, endY, control1X, control2X } = connectionControlPoints(from, to, connection);
    // Both control y's are endpoint y's, so the y range is exactly the endpoints' span (the
    // Bernstein weights are non-negative and sum to 1). Only x needs all four points.
    return {
        left: Math.min(startX, control1X, control2X, endX),
        right: Math.max(startX, control1X, control2X, endX),
        top: Math.min(startY, endY),
        bottom: Math.max(startY, endY),
    };
}

export function rectsIntersect(a: WorldRect, b: WorldRect) {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

/**
 * Connections worth rendering. Only rendering is culled — the graph itself keeps every connection,
 * so resource references, generation inputs and group logic are unaffected.
 *
 * `keepIds` entries bypass the test; the selected connection uses it so its inline disconnect
 * button never disappears when it scrolls off screen.
 *
 * A connection with a missing endpoint is dropped, matching the renderer's previous behaviour.
 */
export function cullConnections(
    connections: readonly CanvasConnection[],
    nodeById: ReadonlyMap<string, CanvasNodeData>,
    viewRect: WorldRect,
    { margin = 0, keepIds }: { margin?: number; keepIds?: ReadonlySet<string> } = {},
): CanvasConnection[] {
    const rect: WorldRect = margin ? { left: viewRect.left - margin, top: viewRect.top - margin, right: viewRect.right + margin, bottom: viewRect.bottom + margin } : viewRect;
    return connections.filter((connection) => {
        const from = nodeById.get(connection.fromNodeId);
        const to = nodeById.get(connection.toNodeId);
        if (!from || !to) return false;
        if (keepIds?.has(connection.id)) return true;
        return rectsIntersect(connectionControlHull(from, to, connection), rect);
    });
}
