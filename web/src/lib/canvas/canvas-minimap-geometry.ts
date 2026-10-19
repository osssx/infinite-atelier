import type { CanvasNodeData } from "@/types/canvas";

export const MINIMAP_WIDTH = 240;
export const MINIMAP_HEIGHT = 160;
const WORLD_PADDING = 500;

export type MinimapProjection = {
    originX: number;
    originY: number;
    scale: number;
    offsetX: number;
    offsetY: number;
};

/** A pure projection shared by paint, viewport outline and pointer navigation. */
export function getMinimapProjection(nodes: readonly CanvasNodeData[], width = MINIMAP_WIDTH, height = MINIMAP_HEIGHT): MinimapProjection {
    if (nodes.length === 0) {
        return { originX: -500, originY: -500, scale: Math.min(width / 1000, height / 1000), offsetX: (width - 1000 * Math.min(width / 1000, height / 1000)) / 2, offsetY: (height - 1000 * Math.min(width / 1000, height / 1000)) / 2 };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
        minX = Math.min(minX, node.position.x);
        minY = Math.min(minY, node.position.y);
        maxX = Math.max(maxX, node.position.x + node.width);
        maxY = Math.max(maxY, node.position.y + node.height);
    }
    minX -= WORLD_PADDING;
    minY -= WORLD_PADDING;
    maxX += WORLD_PADDING;
    maxY += WORLD_PADDING;

    const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
    return {
        originX: minX,
        originY: minY,
        scale,
        offsetX: (width - (maxX - minX) * scale) / 2,
        offsetY: (height - (maxY - minY) * scale) / 2,
    };
}

export function minimapWorldToScreen(projection: MinimapProjection, x: number, y: number) {
    return { x: (x - projection.originX) * projection.scale + projection.offsetX, y: (y - projection.originY) * projection.scale + projection.offsetY };
}

export function minimapScreenToWorld(projection: MinimapProjection, x: number, y: number) {
    return { x: (x - projection.offsetX) / projection.scale + projection.originX, y: (y - projection.offsetY) / projection.scale + projection.originY };
}

export function minimapNodeRect(projection: MinimapProjection, node: CanvasNodeData) {
    const point = minimapWorldToScreen(projection, node.position.x, node.position.y);
    return { x: point.x, y: point.y, width: Math.max(node.width * projection.scale, 2), height: Math.max(node.height * projection.scale, 2) };
}
