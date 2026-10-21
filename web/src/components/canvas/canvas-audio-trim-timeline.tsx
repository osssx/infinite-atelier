import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Tooltip } from "antd";
import { Maximize, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatAudioTime } from "@/lib/canvas/audio-trim";
import { audioTimelineTimeAtRatio, clampAudioTimelineView, fitAudioTimelineSelection, MAX_AUDIO_TIMELINE_ZOOM, visibleAudioTimelinePeaks, zoomAudioTimeline, type AudioTimelineView } from "@/lib/canvas/audio-timeline";

type Props = {
    peaks: Float32Array;
    duration: number;
    sampleRate: number;
    start: number;
    end: number;
    cursor: number;
    disabled: boolean;
    onRangeChange: (start: number, end: number, moving: "start" | "end" | "both") => void;
    onSeek: (time: number) => void;
};

type Drag = { mode: "move" | "start" | "end"; x: number; start: number; end: number; view: AudioTimelineView; width: number; moved: boolean };

export function CanvasAudioTrimTimeline({ peaks, duration, sampleRate, start, end, cursor, disabled, onRangeChange, onSeek }: Props) {
    const { t } = useTranslation();
    const [view, setView] = useState<AudioTimelineView>({ start: 0, zoom: 1 });
    const viewRef = useRef(view);
    const stageRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<Drag | null>(null);
    const span = duration / view.zoom;
    const viewEnd = Math.min(duration, view.start + span);
    const updateView = (next: AudioTimelineView) => {
        if (disabled || dragRef.current) return;
        const safe = clampAudioTimelineView(next, duration);
        viewRef.current = safe;
        setView(safe);
    };

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage || disabled) return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            if (dragRef.current) return;
            const current = viewRef.current;
            if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
                const delta = event.deltaX || event.deltaY;
                const next = clampAudioTimelineView({ ...current, start: current.start + ((delta / stage.clientWidth) * duration) / current.zoom }, duration);
                viewRef.current = next;
                setView(next);
            } else if (event.deltaY) {
                const rect = stage.getBoundingClientRect();
                const factor = Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.01);
                const next = zoomAudioTimeline(current, current.zoom * factor, duration, (event.clientX - rect.left) / rect.width);
                viewRef.current = next;
                setView(next);
            }
        };
        stage.addEventListener("wheel", onWheel, { passive: false });
        return () => stage.removeEventListener("wheel", onWheel);
    }, [disabled, duration]);

    const visiblePeaks = useMemo(() => visibleAudioTimelinePeaks(peaks, view, duration), [peaks, view, duration]);
    const bars = useMemo(
        () =>
            Array.from(visiblePeaks, (peak, index) => {
                const time = view.start + (index / visiblePeaks.length) * span;
                return <rect key={index} x={index} y={50 - Math.max(1, peak * 46)} width="0.72" height={Math.max(2, peak * 92)} rx="0.3" fill={time >= start && time <= end ? "#7c3aed" : "#94a3b8"} />;
            }),
        [visiblePeaks, view.start, span, start, end],
    );
    const position = (time: number) => `${((time - view.start) / span) * 100}%`;
    const withinView = (time: number) => time >= view.start && time <= viewEnd;
    const selectionLeft = Math.max(start, view.start);
    const selectionRight = Math.min(end, viewEnd);
    const zoomAtCursor = (zoom: number) => updateView(zoomAudioTimeline(viewRef.current, zoom, duration, withinView(cursor) ? (cursor - view.start) / span : 0.5));

    const beginDrag = (mode: Drag["mode"], event: React.PointerEvent<HTMLElement>) => {
        if (disabled || !stageRef.current) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { mode, x: event.clientX, start, end, view: { ...viewRef.current }, width: stageRef.current.getBoundingClientRect().width, moved: false };
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <Tooltip title={t("canvas.audioTrim.zoomOut")}>
                    <Button aria-label={t("canvas.audioTrim.zoomOut")} icon={<ZoomOut className="size-4" />} disabled={disabled || view.zoom <= 1} onClick={() => zoomAtCursor(view.zoom / 2)} />
                </Tooltip>
                <span className="min-w-12 text-center text-xs tabular-nums" data-audio-timeline-zoom>
                    {Number(view.zoom.toFixed(1))}×
                </span>
                <Tooltip title={t("canvas.audioTrim.zoomIn")}>
                    <Button aria-label={t("canvas.audioTrim.zoomIn")} icon={<ZoomIn className="size-4" />} disabled={disabled || view.zoom >= MAX_AUDIO_TIMELINE_ZOOM} onClick={() => zoomAtCursor(view.zoom * 2)} />
                </Tooltip>
                <Button icon={<Maximize className="size-4" />} disabled={disabled} onClick={() => updateView({ start: 0, zoom: 1 })}>
                    {t("canvas.audioTrim.showAll")}
                </Button>
                <Button icon={<Scan className="size-4" />} disabled={disabled} onClick={() => updateView(fitAudioTimelineSelection(start, end, duration))}>
                    {t("canvas.audioTrim.fitSelection")}
                </Button>
                <span className="ml-auto font-mono text-xs opacity-60" data-audio-timeline-window>
                    {formatAudioTime(view.start)} – {formatAudioTime(viewEnd)}
                </span>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 dark:border-slate-700 dark:bg-slate-900">
                <div
                    ref={stageRef}
                    data-audio-timeline-stage
                    className="relative h-40 w-full touch-none select-none overflow-hidden"
                    onPointerDown={(event) => {
                        if (disabled) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        onSeek(audioTimelineTimeAtRatio(viewRef.current, duration, (event.clientX - rect.left) / rect.width));
                    }}
                    onPointerMove={(event) => {
                        const drag = dragRef.current;
                        if (!drag || disabled) return;
                        if (drag.mode === "move" && !drag.moved && Math.abs(event.clientX - drag.x) < 4) return;
                        const delta = (((event.clientX - drag.x) / drag.width) * duration) / drag.view.zoom;
                        if (drag.mode === "move") {
                            const length = drag.end - drag.start;
                            const moved = Math.max(0, Math.min(duration - length, drag.start + delta));
                            onRangeChange(moved, moved + length, "both");
                        } else if (drag.mode === "start") {
                            onRangeChange(Math.max(0, Math.min(drag.end - 1 / sampleRate, drag.start + delta)), drag.end, "start");
                        } else {
                            onRangeChange(drag.start, Math.min(duration, Math.max(drag.start + 1 / sampleRate, drag.end + delta)), "end");
                        }
                        dragRef.current = { ...drag, moved: true };
                    }}
                    onPointerUp={(event) => {
                        const drag = dragRef.current;
                        if (drag?.mode === "move" && !drag.moved && !disabled) {
                            const rect = event.currentTarget.getBoundingClientRect();
                            const time = audioTimelineTimeAtRatio(viewRef.current, duration, (event.clientX - rect.left) / rect.width);
                            onSeek(Math.max(start, Math.min(end, time)));
                        }
                        dragRef.current = null;
                    }}
                    onPointerCancel={() => {
                        dragRef.current = null;
                    }}
                    onLostPointerCapture={() => {
                        dragRef.current = null;
                    }}
                >
                    <svg className="h-full w-full" viewBox={`0 0 ${visiblePeaks.length} 100`} preserveAspectRatio="none">
                        {bars}
                    </svg>
                    {selectionRight > selectionLeft || dragRef.current?.mode === "move" ? (
                        <div
                            className="absolute inset-y-0 cursor-grab bg-violet-500/10"
                            style={{ left: position(selectionLeft), width: `${(Math.max(0, selectionRight - selectionLeft) / span) * 100}%` }}
                            onPointerDown={(event) => beginDrag("move", event)}
                        />
                    ) : null}
                    {/* Keep captured handles mounted when a drag moves past the visible window. */}
                    {withinView(start) || dragRef.current?.mode === "start" ? (
                        <button
                            type="button"
                            aria-label={t("canvas.audioTrim.start")}
                            disabled={disabled}
                            className="absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-ew-resize border-l-2 border-violet-700 bg-violet-500/40"
                            style={{ left: position(start) }}
                            onPointerDown={(event) => beginDrag("start", event)}
                        />
                    ) : null}
                    {withinView(end) || dragRef.current?.mode === "end" ? (
                        <button
                            type="button"
                            aria-label={t("canvas.audioTrim.end")}
                            disabled={disabled}
                            className="absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-ew-resize border-r-2 border-violet-700 bg-violet-500/40"
                            style={{ left: position(end) }}
                            onPointerDown={(event) => beginDrag("end", event)}
                        />
                    ) : null}
                    {withinView(cursor) ? <div className="pointer-events-none absolute inset-y-0 w-px bg-red-500" style={{ left: position(cursor) }} /> : null}
                </div>
                <div className="mt-3 flex justify-between font-mono text-xs opacity-60">
                    {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
                        <span key={ratio}>{formatAudioTime(view.start + span * ratio)}</span>
                    ))}
                </div>
                <input
                    type="range"
                    aria-label={t("canvas.audioTrim.panTimeline")}
                    min={0}
                    max={Math.max(0, duration - span)}
                    step={Math.max(Number.EPSILON, span / 1000)}
                    value={view.start}
                    disabled={disabled || view.zoom <= 1}
                    onChange={(event) => updateView({ ...view, start: Number(event.target.value) })}
                    className="mt-3 block w-full accent-violet-600 disabled:opacity-30"
                />
            </div>
        </div>
    );
}
