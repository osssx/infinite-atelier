/** While content warms up or fades in, retain the compact hit-test/preview shell.
 * Afterwards the full node is sufficient and the redundant preview can unmount.
 * A compact downgrade must always remount a hit target in the same React commit. */
export function keepCompactDuringHandoff(showFull: boolean, visualKey: string, shownKey: string | null, settledKey: string | null): boolean {
    return !showFull || shownKey !== visualKey || settledKey !== visualKey;
}
