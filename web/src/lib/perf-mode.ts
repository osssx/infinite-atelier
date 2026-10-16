/**
 * True only in a perf-mode production build: `vite build --mode perf`.
 *
 * This is a compile-time constant, so every branch guarded by it is dead code — and eliminated — in
 * other builds. It lives in its own import-free module so low-level code (storage adapters, stores)
 * can read it without pulling the measurement harness into the normal bundle.
 */
export const PERF_MODE = import.meta.env.MODE === "perf";

/** Suffix for test-only localStorage keys, used when the localforage backend is unavailable. */
export const PERF_STORAGE_PREFIX = "infinite-canvas-perf:";
