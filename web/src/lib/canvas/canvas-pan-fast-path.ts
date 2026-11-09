import type { ViewportTransform } from "@/types/canvas";

/** Pan and wheel commit about every three 60Hz frames (48ms) while visuals track every frame. */
export const FAST_PAN_COMMIT_INTERVAL_MS = 48;
export const FAST_WHEEL_COMMIT_INTERVAL_MS = 48;
export const FAST_VIEWPORT_MAX_SCALE_RATIO = 1.12;

/** Bound culling/React lag while a directly transformed zoom gesture follows every animation frame. */
export function shouldCommitFastViewport(next: ViewportTransform, committed: ViewportTransform, elapsedMs: number): boolean {
    const scaleRatio = Math.max(next.k / committed.k, committed.k / next.k);
    return elapsedMs >= FAST_WHEEL_COMMIT_INTERVAL_MS ||
        Math.max(Math.abs(next.x - committed.x), Math.abs(next.y - committed.y)) >= 200 ||
        scaleRatio >= FAST_VIEWPORT_MAX_SCALE_RATIO;
}

export function canFastPanAtScale(scale: number): boolean {
    // The layer already culls with 280 CSS px of node overscan and a wider edge margin.
    // A 48ms commit cadence keeps ordinary pointer travel inside that temporary geometry at
    // every editing zoom, while the DOM transform itself follows each animation frame.
    return Number.isFinite(scale) && scale > 0;
}

export function shouldCommitFastPan(
    next: ViewportTransform,
    committed: ViewportTransform,
    elapsedMs: number,
): boolean {
    return elapsedMs >= FAST_PAN_COMMIT_INTERVAL_MS ||
        Math.max(Math.abs(next.x - committed.x), Math.abs(next.y - committed.y)) >= 200;
}

export function worldTransformForViewport(view: ViewportTransform): string {
    return `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
}

export function gridPositionForViewport(view: ViewportTransform): string {
    const gridSize = 48 * view.k;
    return `${view.x % gridSize}px ${view.y % gridSize}px`;
}
