import { describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ canvasApi: vi.fn(async () => ({ projects: [] })) }));
vi.mock("@/lib/perf-mode", () => ({ PERF_MODE: true }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/features/backend-sync/canvas-api", () => ({ canvasApi: backend.canvasApi }));

import { useCanvasStore } from "./use-canvas-store";
import type { CanvasProject } from "./use-canvas-sqlite-store";

describe("perf-only ephemeral Canvas fixtures", () => {
    it("survives a pending backend project-list response and loads without backend persistence", async () => {
        const fixture: CanvasProject = {
            id: "perf-fixture-300", title: "[perf] fixture 300", createdAt: "2026-11-09", updatedAt: "2026-11-09",
            nodes: [{ id: "n1", type: "text", title: "text", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: {} }],
            connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false,
            viewport: { x: 0, y: 0, k: 1 },
        };
        useCanvasStore.getState().replaceProjects([fixture]);
        await useCanvasStore.getState().loadProjects();
        expect(useCanvasStore.getState().projects).toEqual([fixture]);
        expect(await useCanvasStore.getState().loadProject(fixture.id)).toEqual(fixture);
        expect(backend.canvasApi).toHaveBeenCalledExactlyOnceWith("/api/v1/projects");
    });
});
