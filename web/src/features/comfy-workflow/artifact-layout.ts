import type { CanvasNodeData } from "@/types/canvas";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";

/** Count materialized outputs across all runs of this workflow, not only the latest batch. */
export function nextComfyArtifactTileIndex(nodes: readonly CanvasNodeData[], workflowNodeId:string) {
    return nodes.filter(node=>node.metadata?.comfyArtifact?.workflowNodeId===workflowNodeId).length;
}

/** Stable non-overlapping tile placement for multi-image outputs from one Comfy run. */
export function placeComfyImageArtifact(source: CanvasNodeData, index: number, naturalWidth: number, naturalHeight: number) {
    const tileSize = 420, gap = 24, rows = 4;
    const size = fitNodeSize(naturalWidth, naturalHeight, tileSize, tileSize);
    const column = Math.floor(index / rows), row = index % rows;
    const left = source.position.x + source.width + 48 + column * (tileSize + gap);
    const top = source.position.y + row * (tileSize + gap);
    return {
        ...size,
        center: { x: left + size.width / 2, y: top + size.height / 2 },
    };
}
