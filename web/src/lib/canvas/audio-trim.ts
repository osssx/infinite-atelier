export function getAudioSampleRange(startSeconds: number, endSeconds: number, sampleRate: number, length: number) {
    const start = Math.max(0, Math.min(length - 1, Math.floor(startSeconds * sampleRate)));
    const end = Math.max(start + 1, Math.min(length, Math.ceil(endSeconds * sampleRate)));
    return { start, end };
}

export function snapAudioTrimRange(startSeconds: number, endSeconds: number, duration: number, sampleRate: number, moving: "start" | "end" | "both" = "both") {
    const sample = 1 / sampleRate;
    const step = 0.01;
    const start = Math.max(0, Math.min(duration, Math.round(startSeconds / step) * step));
    const end = Math.max(0, Math.min(duration, Math.round(endSeconds / step) * step));
    if (end - start >= sample) return { start, end };

    if (duration >= step) {
        if (moving === "start" && end >= step) return { start: end - step, end };
        if (moving === "end" && start + step <= duration) return { start, end: start + step };
        if (moving === "both") {
            if (start + step <= duration) return { start, end: start + step };
            if (end >= step) return { start: end - step, end };
        }
    }

    const safeStart = Math.max(0, Math.min(duration - sample, startSeconds));
    return { start: safeStart, end: Math.max(safeStart + sample, Math.min(duration, endSeconds)) };
}

export function summarizeAudioPeaks(buffer: AudioBuffer, buckets = 1200) {
    const count = Math.max(1, Math.min(buckets, buffer.length));
    const peaks = new Float32Array(count);
    const step = buffer.length / count;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let bucket = 0; bucket < count; bucket++) {
            const from = Math.floor(bucket * step);
            const to = Math.max(from + 1, Math.floor((bucket + 1) * step));
            let peak = 0;
            for (let i = from; i < Math.min(to, buffer.length); i++) peak = Math.max(peak, Math.abs(data[i]));
            peaks[bucket] = Math.max(peaks[bucket], peak);
        }
    }
    return peaks;
}

export async function encodePcm16WavAsync(buffer: AudioBuffer, start: number, end: number, cancelled: () => boolean = () => false) {
    const frames = end - start;
    const channels = buffer.numberOfChannels;
    const dataBytes = frames * channels * 2;
    const output = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(output);
    writeWavHeader(view, channels, buffer.sampleRate, dataBytes);
    const channelData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
    const chunkFrames = 65536;
    for (let base = 0; base < frames; base += chunkFrames) {
        if (cancelled()) throw new DOMException("Encoding cancelled", "AbortError");
        const limit = Math.min(frames, base + chunkFrames);
        for (let frame = base; frame < limit; frame++)
            for (let channel = 0; channel < channels; channel++) {
                const sample = Math.max(-1, Math.min(1, channelData[channel][start + frame]));
                view.setInt16(44 + (frame * channels + channel) * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
            }
        if (limit < frames) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (cancelled()) throw new DOMException("Encoding cancelled", "AbortError");
    return new Blob([output], { type: "audio/wav" });
}

function writeWavHeader(view: DataView, channels: number, sampleRate: number, dataBytes: number) {
    const write = (offset: number, value: string) => {
        for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    write(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    view.setUint32(40, dataBytes, true);
}

export function formatAudioTime(seconds: number) {
    const totalCentiseconds = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 100);
    const min = Math.floor(totalCentiseconds / 6000);
    const second = ((totalCentiseconds % 6000) / 100).toFixed(2);
    return `${String(min).padStart(2, "0")}:${second.padStart(5, "0")}`;
}
