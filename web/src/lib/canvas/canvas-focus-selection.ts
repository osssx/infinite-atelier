import { fitViewportToNodes } from "./canvas-node-geometry";
import type { CanvasNodeData } from "@/types/canvas";

export function focusSelectionViewport(nodes: CanvasNodeData[], selectedIds: ReadonlySet<string>, size: { width: number; height: number }) {
    const selected = nodes.filter((node) => selectedIds.has(node.id));
    if (!selected.length || size.width <= 0 || size.height <= 0) return null;
    return fitViewportToNodes(selected, size);
}

type FocusKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "defaultPrevented">;

export function isFocusSelectionKey(event: FocusKeyEvent) {
    return event.key.toLowerCase() === "f" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.repeat && !event.isComposing && !event.defaultPrevented;
}

// Query only on F, so overlay detection adds no work to pointer or animation frames.
export function isFocusSelectionBlocked(target: Element | null, root: ParentNode = document) {
    if (target?.closest("input,textarea,select,[role='textbox'],[contenteditable]:not([contenteditable='false']),video,audio,[data-canvas-no-zoom],[data-canvas-shortcuts-ignore],[role='dialog'],[role='menu'],[role='listbox']")) return true;
    return Array.from(root.querySelectorAll("[role='dialog'],[role='menu'],[role='listbox'],.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")).some((element) =>
        element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
    );
}
