export type VideoSeekAdapter = {
    seekTo: (time: number) => Promise<void>;
    currentTime: () => number;
    isReady: () => boolean;
    pause: () => void;
};

/** Serializes seeks while allowing rapid input to replace the pending target. */
export function createLatestVideoSeeker(adapter: VideoSeekAdapter) {
    let revision = 0;
    let target = 0;
    let running = false;
    let cancelled = false;
    let waiters: Array<{ resolve: (time: number) => void; reject: (error: Error) => void }> = [];
    const settle = (error?: Error) => {
        const current = waiters; waiters = [];
        for (const waiter of current) error ? waiter.reject(error) : waiter.resolve(adapter.currentTime());
    };
    const run = async () => {
        if (running) return;
        running = true;
        try {
            while (!cancelled) {
                const seekRevision = revision;
                const seekTarget = target;
                adapter.pause();
                await adapter.seekTo(seekTarget);
                if (cancelled) return;
                if (seekRevision !== revision) continue;
                if (!adapter.isReady() || Math.abs(adapter.currentTime() - seekTarget) > 0.02) throw new Error("Video seek did not reach the requested time");
                settle();
                if (seekRevision === revision) break;
            }
        } catch (error) {
            settle(error instanceof Error ? error : new Error(String(error)));
        } finally {
            running = false;
            if (cancelled) settle(new Error("Video seek cancelled"));
            else if (waiters.length) void run();
        }
    };
    return {
        seek(time: number) {
            if (cancelled) return Promise.reject(new Error("Video seek cancelled"));
            target = Math.max(0, time); revision += 1; adapter.pause();
            const result = new Promise<number>((resolve, reject) => waiters.push({ resolve, reject }));
            void run();
            return result;
        },
        cancel() { cancelled = true; revision += 1; settle(new Error("Video seek cancelled")); },
    };
}
