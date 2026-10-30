/**
 * A 256px preview is inadequate once its projected size is large on a high-DPI
 * display. Require both enough *canvas viewport* coverage and physical pixels
 * before decoding/uploading the original. Hysteresis prevents wheel jitter.
 */
export const IMAGE_ORIGINAL_ENTER_AREA = 0.04;
export const IMAGE_ORIGINAL_EXIT_AREA = 0.025;
export const IMAGE_ORIGINAL_ENTER_EDGE_PX = 320;
export const IMAGE_ORIGINAL_EXIT_EDGE_PX = 256;

export function shouldUseOriginalCanvasImage(
    scale: number,
    nodeWidth: number,
    nodeHeight: number,
    viewportWidth: number,
    viewportHeight: number,
    previouslyOriginal = false,
    devicePixelRatio = 1,
): boolean {
    if (![scale, nodeWidth, nodeHeight, viewportWidth, viewportHeight, devicePixelRatio].every(
        (n) => Number.isFinite(n) && n > 0,
    )) return false;

    // CSS pixels cancel out in the area fraction; only the edge needs DPR.
    const displayWidth = nodeWidth * scale;
    const displayHeight = nodeHeight * scale;
    const share = Math.min(1, (displayWidth * displayHeight) / (viewportWidth * viewportHeight));
    const physicalEdge = Math.max(displayWidth, displayHeight) * devicePixelRatio;
    return previouslyOriginal
        ? share >= IMAGE_ORIGINAL_EXIT_AREA && physicalEdge >= IMAGE_ORIGINAL_EXIT_EDGE_PX
        : share >= IMAGE_ORIGINAL_ENTER_AREA && physicalEdge >= IMAGE_ORIGINAL_ENTER_EDGE_PX;
}
