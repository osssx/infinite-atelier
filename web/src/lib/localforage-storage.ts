import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

import { PERF_MODE, PERF_STORAGE_PREFIX } from "@/lib/perf-mode";

// A perf run must never read or write the real app database. The name is chosen at module init, which
// happens before any store is created and therefore before any store auto-hydrates — so the isolation
// is structural rather than a cleanup step that could be forgotten or raced.
const STORAGE_NAME = PERF_MODE ? "infinite-canvas-perf" : "infinite-canvas";

localforage.config({
    name: STORAGE_NAME,
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            return (await localforage.getItem<string>(name)) || null;
        } catch {
            return window.localStorage.getItem(PERF_MODE ? `${PERF_STORAGE_PREFIX}${name}` : name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch {
            window.localStorage.setItem(PERF_MODE ? `${PERF_STORAGE_PREFIX}${name}` : name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(PERF_MODE ? `${PERF_STORAGE_PREFIX}${name}` : name);
        }
    },
};
