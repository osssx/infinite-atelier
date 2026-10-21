import type { ViewportTransform } from "@/types/canvas";

export const LOW_ZOOM_FAST_PAN_LIMIT = 0.16;
export const FAST_PAN_COMMIT_INTERVAL_MS = 96;

export function canFastPanAtScale(scale: number): boolean {
    return Number.isFinite(scale) && scale > 0 && scale <= LOW_ZOOM_FAST_PAN_LIMIT;
}

export function worldTransformForViewport(view: ViewportTransform): string {
    return `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
}

export function gridPositionForViewport(view: ViewportTransform): string {
    const gridSize = 48 * view.k;
    return `${view.x % gridSize}px ${view.y % gridSize}px`;
}
