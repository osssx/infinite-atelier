/**
 * Below readable zoom, large visible sets switch from full editor nodes to lightweight
 * hit rectangles. Keep editing zoom and modest scenes fully interactive.
 */
export function shouldUseCompactNodeLayer(visibleCount: number, scale: number): boolean {
    return visibleCount >= 72 && scale < 0.35;
}
