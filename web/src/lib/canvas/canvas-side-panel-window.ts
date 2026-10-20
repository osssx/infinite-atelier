/** Fixed-size rows keep the sidebar cheap even for large canvas projects. */
export const CANVAS_SIDEBAR_ROW_HEIGHT = 56;
export const CANVAS_SIDEBAR_ROW_STRIDE = 62; // 56px row + 6px vertical gap

export function canvasSidebarWindow(count: number, scrollTop: number, viewportHeight: number, overscan = 5) {
    const totalHeight = Math.max(0, count * CANVAS_SIDEBAR_ROW_STRIDE - (count ? 6 : 0));
    const height = Math.max(0, viewportHeight);
    const top = Math.min(Math.max(0, scrollTop), Math.max(0, totalHeight - height));
    const start = Math.max(0, Math.floor(top / CANVAS_SIDEBAR_ROW_STRIDE) - overscan);
    const end = Math.min(count, Math.max(start + 1, Math.ceil((top + height) / CANVAS_SIDEBAR_ROW_STRIDE) + overscan));
    return { start, end, totalHeight };
}
