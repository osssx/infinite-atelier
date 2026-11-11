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

/** Shared viewport placement for both @ resource and / Skill menus.
 * Use estimated natural height only to choose above/below. The CSS max-height
 * is the AVAILABLE space, not the estimate, so one row never gains a scrollbar.
 * Above-caret menus use bottom anchoring to avoid shifting when results filter.
 */
export function anchoredMentionMenuPlacement(
    anchor: MentionAnchor,
    screen: { width: number; height: number },
    options: { width: number; count: number; rowHeight?: number; chromeHeight?: number; cap?: number },
): { left: number; width: number; maxHeight: number; top?: number; bottom?: number } {
    const gap = 6;
    const margin = 8;
    const cap = options.cap ?? 224;
    const naturalHeight = options.count
        ? (options.rowHeight ?? 48) * options.count + (options.chromeHeight ?? 10)
        : 42;
    const preferredHeight = Math.min(cap, naturalHeight);
    const placement = canvasMentionPosition(
        anchor, screen, { width: options.width, maxHeight: preferredHeight }, gap, margin,
    );
    const above = placement.top + placement.maxHeight <= anchor.top - gap;
    const available = above
        ? Math.max(0, anchor.top - margin - gap)
        : Math.max(0, screen.height - margin - anchor.bottom - gap);
    return {
        left: placement.left,
        width: placement.width,
        maxHeight: Math.min(cap, available),
        ...(above ? { bottom: Math.max(margin, screen.height - anchor.top + gap) } : { top: placement.top }),
    };
}

/** Scroll only the popup list, never all scrollable ancestors of the selected row. */
export function keepMentionOptionVisible(menu: HTMLElement | null, option: HTMLElement | null) {
    if (!menu || !option) return;
    const menuRect = menu.getBoundingClientRect();
    const itemRect = option.getBoundingClientRect();
    if (itemRect.top < menuRect.top) menu.scrollTop += itemRect.top - menuRect.top;
    else if (itemRect.bottom > menuRect.bottom) menu.scrollTop += itemRect.bottom - menuRect.bottom;
}
