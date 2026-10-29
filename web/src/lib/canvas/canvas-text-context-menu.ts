/** Inputs and rich-text editors must retain the browser's native right-click
 * menu. A custom Paste button cannot reliably access the OS clipboard:
 * Clipboard.readText() can be denied even after the site is granted access,
 * while the trusted native Paste command still works and preserves undo.
 */
export function isNativeTextEditorTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])"));
}
