import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import localforage from "localforage";
import { CanvasProjectRecords } from "./canvas-project-records";

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
    /** Local ComfyUI server id selected for this canvas; the URL is configured in the gateway. */
    comfyInstanceId?: string;
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
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "comfyInstanceId" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
const persistenceDb = PERF_MODE ? "infinite-canvas-perf" : "infinite-canvas";
const projectRecords = new CanvasProjectRecords(
    localforage.createInstance({ name: persistenceDb, storeName: "canvas_projects" }),
    localforage.createInstance({ name: persistenceDb, storeName: "canvas_meta" }),
);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;
let queuedPersistState: PersistedCanvasState | null = null;
let pendingPersist: { name: string; value: StorageValue<CanvasStore> } | null = null;
let latestState: PersistedCanvasState | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let lastWriteError: unknown = null;

export type PersistTiming = {
    sequence: number;
    /** Only changed projects are serialized; this excludes unchanged projects. */
    stringifyMs: number;
    bytes: number;
    writeMs: number;
    onHide: boolean;
};

const persistTimings: PersistTiming[] = [];
let persistSequence = 0;
let hiding = false;

export function drainPersistTimings(): PersistTiming[] {
    return persistTimings.splice(0, persistTimings.length);
}

function queueProjectWrite(state: PersistedCanvasState, onHide: boolean) {
    latestState = state;
    writeQueue = writeQueue.then(async () => {
        const result = await projectRecords.save(state.projects);
        if (latestState === state) {
            retryDelay = 1000;
            lastWriteError = null;
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = null;
        }
        if (PERF_MODE) {
            persistTimings.push({
                sequence: persistSequence++,
                stringifyMs: result.stringifyMs,
                bytes: result.bytes,
                writeMs: result.writeMs,
                onHide,
            });
            if (persistTimings.length > 200) persistTimings.splice(0, persistTimings.length - 200);
        }
    }).catch((error: unknown) => {
        // Never claim success or delete the legacy backup when IndexedDB is unavailable.
        console.error("Canvas project persistence failed; the latest state will be retried", error);
        if (latestState === state) lastWriteError = error;
        if (latestState !== state || retryTimer) return;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            if (latestState === state) queueProjectWrite(state, false);
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
    });
}

export function flushCanvasStorePersistence() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const pending = pendingPersist;
    pendingPersist = null;
    if (!pending) return;
    queueProjectWrite(pending.value.state as PersistedCanvasState, hiding);
}

/** Await in tests / explicit save flows; a pagehide event alone cannot guarantee an async IDB commit. */
export async function awaitCanvasStorePersistence(): Promise<void> {
    flushCanvasStorePersistence();
    await writeQueue;
    if (lastWriteError) throw lastWriteError;
}

function installCanvasStoreFlushOnHide() {
    if (typeof window === "undefined") return;
    const flush = () => {
        hiding = true;
        flushCanvasStorePersistence();
        hiding = false;
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
    });
}

installCanvasStoreFlushOnHide();

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const split = await projectRecords.load();
        if (split) {
            const state: PersistedCanvasState = { projects: split };
            queuedPersistState = state;
            return { state: state as CanvasStore, version: 0 };
        }

        // Read the legacy monolithic record only when no split manifest exists yet.
        // Keep it indefinitely for recovery / older versions; never overwrite it after migration.
        const json = await localForageStorage.getItem(name);
        if (!json) return null;
        const old = JSON.parse(json) as StorageValue<CanvasStore>;
        if (!Array.isArray(old?.state?.projects)) throw new Error("Invalid legacy canvas store");
        queuedPersistState = old.state as PersistedCanvasState;
        queueProjectWrite(queuedPersistState, false);
        return old;
    },
    setItem: (name, value) => {
        const next = value.state as PersistedCanvasState;
        if (queuedPersistState?.projects === next.projects) return;
        queuedPersistState = next;
        pendingPersist = { name, value };
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(flushCanvasStorePersistence, 400);
    },
    removeItem: async (name) => {
        if (saveTimer) clearTimeout(saveTimer);
        if (retryTimer) clearTimeout(retryTimer);
        saveTimer = null;
        retryTimer = null;
        pendingPersist = null;
        latestState = null;
        await writeQueue;
        lastWriteError = null;
        await projectRecords.clear();
        await localForageStorage.removeItem(name);
        queuedPersistState = null;
    },
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
            onRehydrateStorage: () => (_state, error) => {
                if (error) {
                    console.error("Canvas storage could not be safely restored", error);
                    return; // Fail closed; never show an empty project list after corrupt storage.
                }
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);
