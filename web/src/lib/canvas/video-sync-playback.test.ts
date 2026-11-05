import { describe, expect, it, vi } from "vitest";
import { playCanvasVideosFromStart, registerCanvasVideoPlayer } from "./video-sync-playback";

describe("canvas synchronized video playback", () => {
    it("resets all selected players before starting any and skips empty nodes", async () => {
        const events: string[] = [];
        const register = (id: string) => registerCanvasVideoPlayer(id, { prepare: () => {
            events.push(`reset:${id}`);
            return async () => { events.push(`play:${id}`); };
        } });
        const cleanups = [register("first"), register("second"), register("unselected")];
        try {
            await playCanvasVideosFromStart(["first", "empty", "second"]);
            expect(events).toEqual(["reset:first", "reset:second", "play:first", "play:second"]);
        } finally { cleanups.forEach((cleanup) => cleanup()); }
    });
    it("preserves a replacement player when an older registration is cleaned up", async () => {
        const old = registerCanvasVideoPlayer("replacement", { prepare: () => async () => {} });
        const start = vi.fn(async () => {});
        const current = registerCanvasVideoPlayer("replacement", { prepare: () => start });
        old();
        await playCanvasVideosFromStart(["replacement"]);
        expect(start).toHaveBeenCalledOnce();
        current();
        await playCanvasVideosFromStart(["replacement"]);
        expect(start).toHaveBeenCalledOnce();
    });
});
