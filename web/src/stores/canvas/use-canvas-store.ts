import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { localForageStorage } from "@/lib/localforage-storage";
import { PERF_MODE } from "@/lib/perf-mode";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let pendingPersist: { name: string; value: StorageValue<CanvasStore> } | null = null;

/** Perf-mode only: one record per write, exposed to the harness for its persistence report. */
export type PersistTiming = {
    sequence: number;
    /** Synchronous cost of `JSON.stringify` over every project. This is what can block a frame. */
    stringifyMs: number;
    bytes: number;
    /** Call to Promise settlement of the IndexedDB write. Asynchronous, so it should not block. */
    writeMs: number;
    /** True when the write was dispatched by a `pagehide` flush rather than the normal debounce. */
    onHide: boolean;
};

const persistTimings: PersistTiming[] = [];
let persistSequence = 0;
let hiding = false;

/** Snapshots and clears the collected timings. Called by the harness at the end of a round. */
export function drainPersistTimings(): PersistTiming[] {
    return persistTimings.splice(0, persistTimings.length);
}

export function flushCanvasStorePersistence() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const pending = pendingPersist;
    pendingPersist = null;
    if (!pending) return;

    // The normal path stays byte-for-byte what it was: no `performance.now()` calls on a hot write.
    if (!PERF_MODE) {
        void localForageStorage.setItem(pending.name, JSON.stringify(pending.value));
        return;
    }

    // Timed separately on purpose: `JSON.stringify` serialises *every* project synchronously on the
    // main thread, so it is the only one of the two that can stall a frame. `setItem` is async and
    // should not. Without the split there is no way to tell which one a slow frame belongs to.
    const stringifyStarted = performance.now();
    const payload = JSON.stringify(pending.value);
    const stringifyMs = performance.now() - stringifyStarted;

    const writeStarted = performance.now();
    void Promise.resolve(localForageStorage.setItem(pending.name, payload)).finally(() => {
        persistTimings.push({ sequence: persistSequence++, stringifyMs, bytes: payload.length, writeMs: performance.now() - writeStarted, onHide: hiding });
        // Bound the buffer: a long session writes often and only the tail is interesting.
        if (persistTimings.length > 200) persistTimings.splice(0, persistTimings.length - 200);
    });
}

/**
 * Flushes the debounced write when the page goes away.
 *
 * Without this, anything changed within the 400ms debounce window is simply lost on tab close or
 * navigation — there was no `pagehide`/`beforeunload` handler anywhere in the app. `pagehide` rather
 * than `beforeunload`: the latter is unreliable on mobile and is skipped when a page enters the
 * bfcache. Only the existing flush is called; no new synchronous storage call is introduced, since
 * one that could not finish before teardown would be worse than nothing — it would look saved.
 */
function installCanvasStoreFlushOnHide() {
    if (typeof window === "undefined") return;
    window.addEventListener("pagehide", () => {
        hiding = true;
        flushCanvasStorePersistence();
        hiding = false;
    });
}

installCanvasStoreFlushOnHide();

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects) return;
        queuedPersistState = nextState;
        pendingPersist = { name, value };
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            flushCanvasStorePersistence();
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            createProject: (title = i18n.t("canvas.project.untitled")) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || i18n.t("canvas.project.imported"),
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => {
                    const projects = state.projects.filter((project) => !ids.includes(project.id));
                    return { projects };
                }),
            replaceProjects: (projects) => set({ projects }),
            updateProject: (id, patch) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                })),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);
