/**
 * The canvas editor keeps immediate node/viewport state locally and commits viewport on a
 * timer. Backup export invokes this hook before taking the Zustand snapshot.
 */
let currentFlush: (() => void) | null = null;

export function registerCanvasBackupFlush(flush: () => void): () => void {
    currentFlush = flush;
    return () => { if (currentFlush === flush) currentFlush = null; };
}

export function flushOpenCanvasForBackup() {
    currentFlush?.();
}
