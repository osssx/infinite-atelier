import { describe, expect, it } from "vitest";
import { audioTimelineTimeAtRatio, clampAudioTimelineView, fitAudioTimelineSelection, visibleAudioTimelinePeaks, zoomAudioTimeline } from "./audio-timeline";

describe("audio timeline view", () => {
    it("keeps the time under the pointer fixed during zoom", () => {
        const before = { start: 20, zoom: 2 };
        const after = zoomAudioTimeline(before, 8, 100, 0.3);
        expect(audioTimelineTimeAtRatio(after, 100, 0.3)).toBeCloseTo(audioTimelineTimeAtRatio(before, 100, 0.3));
        expect(after.zoom).toBe(8);
    });

    it("clamps both ends when zooming or panning", () => {
        expect(clampAudioTimelineView({ start: -20, zoom: 4 }, 100)).toEqual({ start: 0, zoom: 4 });
        expect(clampAudioTimelineView({ start: 500, zoom: 4 }, 100)).toEqual({ start: 75, zoom: 4 });
        expect(zoomAudioTimeline({ start: 75, zoom: 4 }, 0.2, 100)).toEqual({ start: 0, zoom: 1 });
        expect(zoomAudioTimeline({ start: 0, zoom: 1 }, 200, 100, 0)).toEqual({ start: 0, zoom: 64 });
    });

    it("fits the selection with padding and honours the zoom cap for tiny ranges", () => {
        const view = fitAudioTimelineSelection(20, 30, 100);
        expect(view.start).toBe(19);
        expect(100 / view.zoom).toBe(12);
        expect(fitAudioTimelineSelection(0, 100, 100)).toEqual({ start: 0, zoom: 1 });
        expect(fitAudioTimelineSelection(99.99, 100, 100)).toEqual({ start: 98.4375, zoom: 64 });
    });

    it("maps pointers and drag deltas through the visible time window", () => {
        const view = { start: 50, zoom: 4 };
        expect(audioTimelineTimeAtRatio(view, 100, 0)).toBe(50);
        expect(audioTimelineTimeAtRatio(view, 100, 1)).toBe(75);
        expect(audioTimelineTimeAtRatio(view, 100, 0.6) - audioTimelineTimeAtRatio(view, 100, 0.5)).toBeCloseTo(2.5);
    });

    it("preserves transients in cached waveform aggregation and shows the selected window", () => {
        const peaks = new Float32Array([0, 0, 0.8, 0, 0.3, 0, 0, 1]);
        expect(Array.from(visibleAudioTimelinePeaks(peaks, { start: 0, zoom: 1 }, 8, 4))).toEqual([0, expect.closeTo(0.8), expect.closeTo(0.3), 1]);
        expect(Array.from(visibleAudioTimelinePeaks(peaks, { start: 4, zoom: 2 }, 8, 4))).toEqual([expect.closeTo(0.3), 0, 0, 1]);
        expect(visibleAudioTimelinePeaks(peaks, { start: 0, zoom: 1 }, 0)).toHaveLength(0);
    });
});
