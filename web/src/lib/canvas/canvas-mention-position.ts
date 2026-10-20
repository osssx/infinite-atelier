/** Popup is portaled to document.body and uses fixed viewport coordinates.
 * Never use positions relative to a zoomed canvas or editor wrapper. */
export type MentionAnchor = Pick<DOMRect, "left" | "top" | "bottom">;
export type MentionPlacement = { left: number; top: number; width: number; maxHeight: number };

export function canvasMentionPosition(
    anchor: MentionAnchor,
    screen: { width: number; height: number },
    desired: { width: number; maxHeight: number },
    gap = 6,
    margin = 8,
): MentionPlacement {
    const width = Math.min(desired.width, Math.max(0, screen.width - margin * 2));
    const left = Math.max(margin, Math.min(anchor.left, screen.width - margin - width));
    const below = Math.max(0, screen.height - margin - anchor.bottom - gap);
    const above = Math.max(0, anchor.top - margin - gap);
    const openAbove = below < desired.maxHeight && above > below;
    const maxHeight = Math.min(desired.maxHeight, openAbove ? above : below);
    const rawTop = openAbove ? anchor.top - gap - maxHeight : anchor.bottom + gap;
    const top = Math.max(margin, Math.min(rawTop, screen.height - margin - maxHeight));
    return { left, top, width, maxHeight };
}

/** Scroll only the popup list, never all scrollable ancestors of the selected row. */
export function keepMentionOptionVisible(menu: HTMLElement | null, option: HTMLElement | null) {
    if (!menu || !option) return;
    const menuRect = menu.getBoundingClientRect();
    const itemRect = option.getBoundingClientRect();
    if (itemRect.top < menuRect.top) menu.scrollTop += itemRect.top - menuRect.top;
    else if (itemRect.bottom > menuRect.bottom) menu.scrollTop += itemRect.bottom - menuRect.bottom;
}
