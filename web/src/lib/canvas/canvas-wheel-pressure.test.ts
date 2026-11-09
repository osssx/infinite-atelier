import { afterEach, expect, it, vi } from "vitest";
import { createWheelPressureMonitor } from "./canvas-wheel-pressure";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("requires sustained pressure and extends recovery until input is quiet", () => {
 vi.useFakeTimers();
 let callback: FrameRequestCallback = () => {};
 vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callback = fn; return 1; });
 vi.stubGlobal("cancelAnimationFrame", vi.fn());
 const notify = vi.fn(); const monitor = createWheelPressureMonitor(notify);
 monitor.input("out", 0.35);
 [10, 26, 80, 96, 112].forEach(t => callback(t));
 expect(notify).not.toHaveBeenCalled();
 [140, 170, 200].forEach(t => callback(t));
 expect(notify).toHaveBeenLastCalledWith(true);
 monitor.stop(); vi.advanceTimersByTime(1000); monitor.input("out", 0.35);
 vi.advanceTimersByTime(1199); expect(notify).toHaveBeenCalledTimes(1);
 vi.advanceTimersByTime(1); expect(notify).toHaveBeenLastCalledWith(false);
 monitor.reset(); monitor.input("out", 0.35);
 [1000, 1060, 1120].forEach(t => callback(t));
 expect(notify).toHaveBeenLastCalledWith(true);
 monitor.reset(); expect(notify).toHaveBeenLastCalledWith(false);
});

it("does not sample zoom-in, unchanged scale, or editing zoom", () => {
 vi.useFakeTimers();
 const raf = vi.fn(() => 1);
 vi.stubGlobal("requestAnimationFrame", raf);
 vi.stubGlobal("cancelAnimationFrame", vi.fn());
 const monitor = createWheelPressureMonitor(vi.fn());
 monitor.input("in", .35); monitor.input("none", .35); monitor.input("out", .42);
 expect(raf).not.toHaveBeenCalled();
 monitor.reset();
});
