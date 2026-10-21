import { describe, expect, it, vi } from "vitest";
import { createLatestVideoSeeker } from "./video-frame-seeker";

describe("createLatestVideoSeeker", () => {
    it("finishes the active seek, then seeks only to the newest requested target", async () => {
        let currentTime = 0;
        const pending: Array<{ target: number; resolve: () => void }> = [];
        const seeker = createLatestVideoSeeker({
            pause: vi.fn(), currentTime: () => currentTime, isReady: () => true,
            seekTo: (target) => new Promise<void>((resolve) => pending.push({ target, resolve: () => { currentTime = target; resolve(); } })),
        });
        const first = seeker.seek(1);
        const second = seeker.seek(2);
        const third = seeker.seek(3);
        expect(pending.map((item) => item.target)).toEqual([1]);
        pending[0].resolve();
        await vi.waitFor(() => expect(pending.map((item) => item.target)).toEqual([1, 3]));
        pending[1].resolve();
        await expect(Promise.all([first, second, third])).resolves.toEqual([3, 3, 3]);
        seeker.cancel();
    });

    it("rejects queued requests when the source is cancelled", async () => {
        const seeker = createLatestVideoSeeker({ pause: vi.fn(), currentTime: () => 0, isReady: () => true, seekTo: () => new Promise(() => undefined) });
        const result = seeker.seek(4);
        seeker.cancel();
        await expect(result).rejects.toThrow("cancelled");
    });

    it("rejects an unreachable seek target instead of retrying forever", async () => {
        const seeker = createLatestVideoSeeker({ pause: vi.fn(), currentTime: () => 0, isReady: () => true, seekTo: async () => undefined });
        await expect(seeker.seek(4)).rejects.toThrow("did not reach");
        seeker.cancel();
    });

    it("does not commit when a cancelled seek resolves later", async () => {
        let currentTime = 0;
        let finishSeek!: () => void;
        const seeker = createLatestVideoSeeker({
            pause: vi.fn(), currentTime: () => currentTime, isReady: () => true,
            seekTo: () => new Promise<void>((resolve) => { finishSeek = () => { currentTime = 7; resolve(); }; }),
        });
        const result = seeker.seek(7);
        seeker.cancel();
        await expect(result).rejects.toThrow("cancelled");
        finishSeek();
        await Promise.resolve();
        expect(currentTime).toBe(7);
    });
});
