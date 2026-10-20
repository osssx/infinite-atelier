import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** Match the primary image displayed by ImageContent, including image batches. */
export function getCompactImageSource(node: CanvasNodeData): string | null {
    if (node.type !== CanvasNodeType.Image) return null;
    const images = node.metadata?.images;
    const primaryId = node.metadata?.primaryImageId || images?.[0]?.id;
    const selected = images?.find((image) => image.id === primaryId);
    return selected?.content || node.metadata?.content || null;
}

/** Load image previews only when they occupy enough screen pixels to be meaningful. */
export function shouldShowCompactImage(scale: number, width: number, height: number): boolean {
    return Number.isFinite(scale) && scale > 0 && Math.min(width, height) * scale >= 36;
}
