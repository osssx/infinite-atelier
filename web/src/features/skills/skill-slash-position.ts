import { anchoredMentionMenuPlacement, type MentionAnchor } from "@/lib/canvas/canvas-mention-position";

/** A short result list should appear against the caret, not a full 224px above it.
 * Anchoring above by bottom (instead of top) keeps the menu next to the caret
 * even when filtered results change its natural height. All units are viewport CSS px. */
export function skillSlashMenuPlacement(
    anchor: MentionAnchor,
    screen: { width: number; height: number },
    entryCount: number,
): { left: number; width: number; maxHeight: number; top?: number; bottom?: number } {
    // A shared natural-height estimate and bottom anchor keeps / and @ aligned
    // when the composer sits near the bottom of the viewport.
    return anchoredMentionMenuPlacement(anchor, screen, { width: 280, count: entryCount });
}
