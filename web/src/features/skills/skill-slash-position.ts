import { canvasMentionPosition, type MentionAnchor } from "@/lib/canvas/canvas-mention-position";

/** A short result list should appear against the caret, not a full 224px above it.
 * Anchoring above by bottom (instead of top) keeps the menu next to the caret
 * even when filtered results change its natural height. All units are viewport CSS px. */
export function skillSlashMenuPlacement(
    anchor: MentionAnchor,
    screen: { width: number; height: number },
    entryCount: number,
): { left: number; width: number; maxHeight: number; top?: number; bottom?: number } {
    const gap = 6;
    const margin = 8;
    // Each row contains two lines (20px + 16px) with 12px vertical padding;
    // the menu adds 8px padding and 2px border. The old 52px estimate clipped
    // even a single row (~58px), causing an unnecessary scrollbar.
    const preferredHeight = Math.min(224, entryCount ? 48 * entryCount + 10 : 42);
    const placement = canvasMentionPosition(anchor, screen, { width: 280, maxHeight: preferredHeight }, gap, margin);
    const above = placement.top + placement.maxHeight <= anchor.top - gap;
    // max-height is a viewport constraint, NOT the estimated content height.
    // Let CSS size the list naturally; scroll only if the list truly exceeds
    // the 224px cap or the space remaining beside the caret.
    const available = above
        ? Math.max(0, anchor.top - margin - gap)
        : Math.max(0, screen.height - margin - anchor.bottom - gap);
    return {
        left: placement.left,
        width: placement.width,
        maxHeight: Math.min(224, available),
        ...(above
            ? { bottom: Math.max(margin, screen.height - anchor.top + gap) }
            : { top: placement.top }),
    };
}
