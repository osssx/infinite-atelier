export const MAX_AUDIO_TIMELINE_ZOOM = 64;
export const AUDIO_TIMELINE_PEAK_BUCKETS = 1200 * MAX_AUDIO_TIMELINE_ZOOM;

export type AudioTimelineView = { start: number; zoom: number };

export function clampAudioTimelineView(view: AudioTimelineView, duration: number): AudioTimelineView {
    const zoom = Math.max(1, Math.min(MAX_AUDIO_TIMELINE_ZOOM, view.zoom));
    return { start: Math.max(0, Math.min(Math.max(0, duration - duration / zoom), view.start)), zoom };
}

/** Keep the time under the pointer (or the centre) fixed while zooming. */
export function zoomAudioTimeline(view: AudioTimelineView, zoom: number, duration: number, anchorRatio = 0.5) {
    const next = clampAudioTimelineView({ start: 0, zoom }, duration);
    const ratio = Math.max(0, Math.min(1, anchorRatio));
    const anchorTime = view.start + (duration / view.zoom) * ratio;
    return clampAudioTimelineView({ start: anchorTime - (duration / next.zoom) * ratio, zoom: next.zoom }, duration);
}

export function fitAudioTimelineSelection(start: number, end: number, duration: number) {
    const span = Math.min(duration, Math.max((end - start) * 1.2, duration / MAX_AUDIO_TIMELINE_ZOOM));
    if (!(span > 0)) return { start: 0, zoom: 1 };
    return clampAudioTimelineView({ start: (start + end - span) / 2, zoom: duration / span }, duration);
}

export function audioTimelineTimeAtRatio(view: AudioTimelineView, duration: number, ratio: number) {
    return Math.max(0, Math.min(duration, view.start + (duration / view.zoom) * Math.max(0, Math.min(1, ratio))));
}

/** Aggregate the cached high-resolution overview; never decode or scan PCM during zoom. */
export function visibleAudioTimelinePeaks(peaks: Float32Array, view: AudioTimelineView, duration: number, buckets = 1200) {
    if (!peaks.length || !(duration > 0)) return new Float32Array();
    const from = (view.start / duration) * peaks.length;
    const step = peaks.length / view.zoom / buckets;
    const count = Math.max(1, Math.min(buckets, Math.ceil(peaks.length / view.zoom)));
    const output = new Float32Array(count);
    const binWidth = (step * buckets) / count;
    for (let bucket = 0; bucket < count; bucket++) {
        const first = Math.max(0, Math.floor(from + bucket * binWidth));
        const last = Math.min(peaks.length, Math.ceil(from + (bucket + 1) * binWidth));
        for (let index = first; index < last; index++) output[bucket] = Math.max(output[bucket], peaks[index]);
    }
    return output;
}
