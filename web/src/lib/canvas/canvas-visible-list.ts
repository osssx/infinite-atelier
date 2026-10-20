/**
 * Culling still runs against the actual viewport every frame, but React layers
 * can reuse their previous props when the ordered set of visible objects did
 * not change. Parent canvas transforms move nodes without re-rendering each
 * descendant; moved/replaced nodes must always invalidate the list.
 */
export function reuseCanvasVisibleList<T>(previous: readonly T[], next: T[]): T[] {
    if (previous.length !== next.length) return next;
    for (let i = 0; i < next.length; i++) {
        if (previous[i] !== next[i]) return next;
    }
    return previous as T[];
}
