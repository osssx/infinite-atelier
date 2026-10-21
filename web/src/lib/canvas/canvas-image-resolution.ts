/**
 * Full-size images have a substantial decode/upload cost (often multiple MiB of
 * GPU texture per node). Keep 256px previews until the displayed image actually
 * needs the detail. Hysteresis avoids repeated source changes near the threshold.
 */
export const IMAGE_ORIGINAL_ENTER_AREA = 0.10;
export const IMAGE_ORIGINAL_EXIT_AREA = 0.06;
export const IMAGE_ORIGINAL_ENTER_EDGE_PX = 320;
export const IMAGE_ORIGINAL_EXIT_EDGE_PX = 260;

export function shouldUseOriginalCanvasImage(
    scale: number,
    nodeWidth: number,
    nodeHeight: number,
    viewportWidth: number,
    viewportHeight: number,
    previouslyOriginal = false,
): boolean {
    if (![scale, nodeWidth, nodeHeight, viewportWidth, viewportHeight].every(
        (n) => Number.isFinite(n) && n > 0,
    )) return false;

    const displayWidth = nodeWidth * scale;
    const displayHeight = nodeHeight * scale;
    const share = Math.min(1, (displayWidth * displayHeight) / (viewportWidth * viewportHeight));
    const edge = Math.max(displayWidth, displayHeight);
    return previouslyOriginal
        ? share >= IMAGE_ORIGINAL_EXIT_AREA && edge >= IMAGE_ORIGINAL_EXIT_EDGE_PX
        : share >= IMAGE_ORIGINAL_ENTER_AREA && edge >= IMAGE_ORIGINAL_ENTER_EDGE_PX;
}
