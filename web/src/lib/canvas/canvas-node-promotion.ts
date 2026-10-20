import type { CanvasNodeData } from "@/types/canvas";
import { CanvasNodeType } from "@/types/canvas";

export type NodePromotionCandidate = { id: string; cost: number; distanceSq: number; priority: number };

/** Avoid a decoder/editor-mount burst in the same paint as pointer release. */
export const PROMOTION_GESTURE_QUIET_MS = 120;

/** Edits and active gestures always take priority over opportunistic hydration. */
export function canScheduleNodePromotions(
    compactMode: boolean,
    gestureActive: boolean,
    gestureSettled: boolean,
    visibleCount: number,
): boolean {
    return !compactMode && !gestureActive && gestureSettled && visibleCount >= 24;
}

function estimateCost(node: CanvasNodeData): number {
    // Approximate DOM + decoder pressure, not an asserted millisecond duration.
    if (node.type === CanvasNodeType.Video) return 3;
    if (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Audio) return 2;
    return 1;
}

/**
 * Order first by explicit interaction, then by viewport-center proximity.
 * Keep document order for exact ties, without materializing expensive media metadata.
 */
export function orderNodePromotions(
    nodes: readonly CanvasNodeData[],
    centerX: number,
    centerY: number,
    priorityIds: ReadonlySet<string>,
): NodePromotionCandidate[] {
    return nodes.map((node, index) => {
        const dx = node.position.x + node.width / 2 - centerX;
        const dy = node.position.y + node.height / 2 - centerY;
        return { id: node.id, cost: estimateCost(node), distanceSq: dx * dx + dy * dy, priority: priorityIds.has(node.id) ? 0 : 1, index };
    }).sort((a, b) => a.priority - b.priority || a.distanceSq - b.distanceSq || a.index - b.index)
      .map(({ id, cost, distanceSq, priority }) => ({ id, cost, distanceSq, priority }));
}

/**
 * Avoid bursts after a slow frame or expensive React commit. A good 60Hz frame
 * admits up to four weighted units (usually two images); strained frames admit
 * one expensive node at most. Never starve a remaining candidate.
 */
export function choosePromotionBatch(
    ordered: readonly NodePromotionCandidate[],
    alreadyPromoted: ReadonlySet<string>,
    frameIntervalMs: number,
    lastCommitMs: number,
): string[] {
    const slow = frameIntervalMs > 25 || lastCommitMs > 8;
    const pressured = frameIntervalMs > 19 || lastCommitMs > 4 || frameIntervalMs < 11;
    const maxCost = slow ? 1 : pressured ? 2 : 4;
    const batch: string[] = [];
    let cost = 0;
    for (const candidate of ordered) {
        if (alreadyPromoted.has(candidate.id)) continue;
        if (batch.length && cost + candidate.cost > maxCost) break;
        batch.push(candidate.id);
        cost += candidate.cost;
        if (batch.length >= 4 || cost >= maxCost) break;
    }
    return batch;
}
