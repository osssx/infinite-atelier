export type WheelZoomDirection = "in" | "out" | "none";
/** Gesture-scoped sampler. No idle animation loop and no per-frame React updates. */
export function createWheelPressureMonitor(notify: (active: boolean) => void) {
    let frame = 0, previous = 0, timer: ReturnType<typeof setTimeout> | undefined;
    let active = false;
    const samples: number[] = [];
    const publish = (value: boolean) => { if (active !== value) { active = value; notify(value); } };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; previous = 0; samples.length = 0; };
    const tick = (now: number) => {
        if (previous) {
            samples.push(now - previous);
            if (samples.length > 5) samples.shift();
            if (samples.filter(n => n > 24).length >= 3 || (samples.length >= 2 && samples.slice(-2).every(n => n > 50))) publish(true);
        }
        previous = now;
        frame = requestAnimationFrame(tick);
    };
    return {
        input(direction: WheelZoomDirection, scale: number) {
            if (direction === "in" || scale >= 0.42) { stop(); clearTimeout(timer); publish(false); return; }
            if (direction !== "out") return;
            if (!frame) frame = requestAnimationFrame(tick);
            clearTimeout(timer);
            timer = setTimeout(() => publish(false), 1200);
        },
        stop,
        reset() { stop(); clearTimeout(timer); publish(false); },
    };
}
