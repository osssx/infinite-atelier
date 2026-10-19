import type { ViewportTransform } from "@/types/canvas";

/**
 * Compose a single wheel delta into an anchored viewport. Call for EVERY wheel event
 * (including multiple events inside one frame), then publish the final transform once
 * on the next animation frame. Different pointer locations must be composed in order:
 * multiplying factors around only the last pointer loses the preceding anchors.
 */
export function applyAnchoredWheelZoom(
    current: ViewportTransform,
    deltaY: number,
    anchorX: number,
    anchorY: number,
    minScale = 0.05,
    maxScale = 5,
): ViewportTransform {
    if (!Number.isFinite(deltaY) || !Number.isFinite(anchorX) || !Number.isFinite(anchorY)) return current;
    const k = Math.min(Math.max(current.k * Math.pow(1.1, -deltaY / 100), minScale), maxScale);
    if (k === current.k) return current;
    const ratio = k / current.k;
    return {
        x: anchorX - (anchorX - current.x) * ratio,
        y: anchorY - (anchorY - current.y) * ratio,
        k,
    };
}
