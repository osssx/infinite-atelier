import { describe, expect, it } from "vitest";
import { encodePcm16WavAsync, formatAudioTime, getAudioSampleRange, snapAudioTrimRange, summarizeAudioPeaks } from "./audio-trim";

function fakeBuffer(left: Float32Array, right: Float32Array, sampleRate = 4): AudioBuffer {
    return { length: left.length, duration: left.length / sampleRate, sampleRate, numberOfChannels: 2, getChannelData: (channel: number) => (channel ? right : left) } as unknown as AudioBuffer;
}

function fakeMonoBuffer(samples: Float32Array, sampleRate = 8): AudioBuffer {
    return { length: samples.length, duration: samples.length / sampleRate, sampleRate, numberOfChannels: 1, getChannelData: () => samples } as unknown as AudioBuffer;
}

describe("audio trim encoding", () => {
    it("formats rounded time without a seconds overflow", () => {
        expect(formatAudioTime(59.999)).toBe("01:00.00");
        expect(formatAudioTime(-2)).toBe("00:00.00");
        expect(formatAudioTime(Number.NaN)).toBe("00:00.00");
        expect(formatAudioTime(Number.POSITIVE_INFINITY)).toBe("00:00.00");
    });

    it("maps start and end to a non-empty sample range, including tiny ranges and file edges", () => {
        expect(getAudioSampleRange(0, 0, 4, 16)).toEqual({ start: 0, end: 1 });
        expect(getAudioSampleRange(0.26, 0.26, 4, 16)).toEqual({ start: 1, end: 2 });
        expect(getAudioSampleRange(3.75, 4, 4, 16)).toEqual({ start: 15, end: 16 });
        expect(getAudioSampleRange(0, 4, 4, 16)).toEqual({ start: 0, end: 16 });
    });

    it("snaps selectable bounds to the same hundredth shown by the inputs", () => {
        expect(snapAudioTrimRange(0.503, 2.253, 4, 48_000)).toEqual({ start: 0.5, end: 2.25 });
        expect(snapAudioTrimRange(0.002, 0.003, 0.005, 48_000)).toEqual({ start: 0.002, end: 0.003 });
        expect(snapAudioTrimRange(2.249, 2.25, 4, 48_000, "start")).toEqual({ start: 2.24, end: 2.25 });
    });

    it("writes a PCM16 stereo WAV with interleaved channels and an exact sample count", async () => {
        const buffer = fakeBuffer(new Float32Array([-1, -0.5, 0, 1]), new Float32Array([1, 0.5, 0, -1]));
        const blob = await encodePcm16WavAsync(buffer, 1, 4);
        expect(blob.type).toBe("audio/wav");
        const bytes = await blob.arrayBuffer();
        const view = new DataView(bytes);
        expect(String.fromCharCode(...new Uint8Array(bytes, 0, 4))).toBe("RIFF");
        expect(String.fromCharCode(...new Uint8Array(bytes, 8, 4))).toBe("WAVE");
        expect(view.getUint16(20, true)).toBe(1);
        expect(view.getUint16(22, true)).toBe(2);
        expect(view.getUint32(24, true)).toBe(4);
        expect(view.getUint32(40, true)).toBe(12);
        expect([1, 2, 3, 4, 5, 6].map((i) => view.getInt16(44 + (i - 1) * 2, true))).toEqual([-16384, 16383, 0, 0, 32767, -32768]);
    });

    it("writes mono PCM16 WAV metadata and sample data", async () => {
        const blob = await encodePcm16WavAsync(fakeMonoBuffer(new Float32Array([-1, 0.25, 1])), 0, 3);
        const bytes = await blob.arrayBuffer();
        const view = new DataView(bytes);
        expect(view.getUint16(22, true)).toBe(1);
        expect(view.getUint32(24, true)).toBe(8);
        expect(view.getUint32(28, true)).toBe(16);
        expect(view.getUint32(40, true)).toBe(6);
        expect([0, 1, 2].map((i) => view.getInt16(44 + i * 2, true))).toEqual([-32768, 8191, 32767]);
    });

    it("summarizes silence as zero and uses absolute peaks across inverted channels", () => {
        expect(Array.from(summarizeAudioPeaks(fakeMonoBuffer(new Float32Array(4)), 4))).toEqual([0, 0, 0, 0]);
        const stereo = fakeBuffer(new Float32Array([0, 0.5, -0.5, 0]), new Float32Array([0, -0.75, 0.75, 0]));
        expect(Array.from(summarizeAudioPeaks(stereo, 4))).toEqual([0, 0.75, 0.75, 0]);
    });

    it("stops between encoding chunks when cancelled", async () => {
        const data = new Float32Array(140_000);
        const buffer = fakeBuffer(data, data, 44_100);
        let cancelled = false;
        setTimeout(() => {
            cancelled = true;
        }, 0);
        await expect(encodePcm16WavAsync(buffer, 0, data.length, () => cancelled)).rejects.toMatchObject({ name: "AbortError" });
    });
});
