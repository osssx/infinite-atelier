import type { Position, ViewportTransform } from "@/types/canvas";

/** Convert a canvas-world anchor to CSS viewport coordinates for an unscaled portal. */
export function canvasPopupPosition(
    point: Position,
    viewport: ViewportTransform,
    canvasRect: Pick<DOMRect, "left" | "top">,
    popup: { width: number; height: number },
    screen: { width: number; height: number },
    margin = 12,
): Position {
    const x = canvasRect.left + viewport.x + point.x * viewport.k;
    const y = canvasRect.top + viewport.y + point.y * viewport.k;
    const clamp = (value: number, size: number, limit: number) =>
        Math.max(margin, Math.min(value, Math.max(margin, limit - size - margin)));
    return { x: clamp(x, popup.width, screen.width), y: clamp(y, popup.height, screen.height) };
}
