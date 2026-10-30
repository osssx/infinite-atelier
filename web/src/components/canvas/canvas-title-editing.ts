/** Title focus is global to the canvas toolbar, not persisted on a node.
 * A delayed blur/unmount from a previous editor must not clear a newer one.
 */
export function nextTitleEditingNodeId(current: string | null, nodeId: string, editing: boolean): string | null {
    return editing ? nodeId : current === nodeId ? null : current;
}

/** Selection/hover must not re-open the floating toolbar over a focused title. */
export function toolbarNodeDuringTitleEditing<T>(candidate: T | null, editingNodeId: string | null): T | null {
    return editingNodeId === null ? candidate : null;
}
