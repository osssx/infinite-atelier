/** Plain-text canvas editors use a text context menu instead of node actions.
 * Rich text/contenteditable and unsupported inputs keep their native menu.
 */
export type CanvasPlainTextInput = HTMLInputElement | HTMLTextAreaElement;
export type CanvasTextEditContext = {
    input: CanvasPlainTextInput;
    start: number;
    end: number;
    copyValue: string;
};

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel"]);

export function isNativeTextEditorTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])"));
}

export function captureCanvasTextEditContext(target: EventTarget | null): CanvasTextEditContext | null {
    if (!(target instanceof Element)) return null;
    const input = target.closest("input,textarea");
    if (!(input instanceof HTMLTextAreaElement) &&
        !(input instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(input.type))) return null;
    if (input.disabled) return null;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (start === null || end === null) return null;
    const selection = input.value.slice(start, end);
    // If no range is selected, "Copy text" copies the whole field.
    return {input, start, end, copyValue: selection || input.value};
}

/** Use the native value setter to notify React controlled inputs via input events.
 * Mutate only the same text field, preserving its current caret selection.
 */
export function insertCanvasClipboardText(context: CanvasTextEditContext, clipboardText: string): boolean {
    const {input, start, end} = context;
    if (!input.isConnected || input.disabled || input.readOnly) return false;
    const value = input.value;
    const from = Math.min(value.length, Math.max(0, start));
    const to = Math.min(value.length, Math.max(from, end));
    const next = value.slice(0, from) + clipboardText + value.slice(to);
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) return false;
    setter.call(input, next);
    input.dispatchEvent(typeof InputEvent === "function"
        ? new InputEvent("input", {bubbles:true, inputType:"insertFromPaste", data:clipboardText})
        : new Event("input", {bubbles:true}));
    input.focus({preventScroll:true});
    input.setSelectionRange(from + clipboardText.length, from + clipboardText.length);
    return true;
}
