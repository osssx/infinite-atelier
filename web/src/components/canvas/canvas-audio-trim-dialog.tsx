import { useEffect, useRef, useState } from "react";
import { App, Button, InputNumber, Modal, Spin } from "antd";
import { Pause, Play, Scissors } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getMediaBlob } from "@/services/file-storage";
import { proxyApiUrl } from "@/lib/api-proxy";
import { encodePcm16WavAsync, formatAudioTime, getAudioSampleRange, snapAudioTrimRange, summarizeAudioPeaks } from "@/lib/canvas/audio-trim";
import type { CanvasNodeData } from "@/types/canvas";
import { AUDIO_TIMELINE_PEAK_BUCKETS } from "@/lib/canvas/audio-timeline";
import { CanvasAudioTrimTimeline } from "./canvas-audio-trim-timeline";

const TIMEOUT = 30_000;
export function CanvasAudioTrimDialog({ node, open, onClose, onTrim }: { node: CanvasNodeData | null; open: boolean; onClose: () => void; onTrim: (blob: Blob, startMs: number, endMs: number, durationMs: number, signal: AbortSignal) => Promise<void> }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
    const [peaks, setPeaks] = useState<Float32Array | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [busy, setBusy] = useState(false);
    const [start, setStart] = useState(0);
    const [end, setEnd] = useState(0);
    const [cursor, setCursor] = useState(0);
    const [playing, setPlaying] = useState(false);
    const contextRef = useRef<AudioContext | null>(null);
    const sourceRef = useRef<AudioBufferSourceNode | null>(null);
    const tokenRef = useRef(0);
    const aliveRef = useRef(true);
    const cancelEncodeRef = useRef(false);
    const trimAbortRef = useRef<AbortController | null>(null);
    const rangeRef = useRef({ start, end });
    rangeRef.current = { start, end };
    const sourceContent = node?.metadata?.content || "";
    const storageKey = node?.metadata?.storageKey;
    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
            tokenRef.current++;
            cancelEncodeRef.current = true;
            trimAbortRef.current?.abort();
            sourceRef.current?.stop();
            void contextRef.current?.close();
            contextRef.current = null;
        };
    }, []);
    useEffect(() => {
        if (!open || !node || !sourceContent) return;
        let cancelled = false;
        const token = ++tokenRef.current;
        const controller = new AbortController();
        setBuffer(null);
        setPeaks(null);
        setLoading(true);
        setError(false);
        setBusy(false);
        setPlaying(false);
        setStart(0);
        setEnd(0);
        setCursor(0);
        const timeout = window.setTimeout(() => {
            controller.abort();
            tokenRef.current++;
            if (!cancelled) {
                setLoading(false);
                setError(true);
                void contextRef.current?.close();
                contextRef.current = null;
            }
        }, TIMEOUT);
        void (async () => {
            try {
                const blob =
                    (storageKey ? await getMediaBlob(storageKey) : null) ||
                    (await (async () => {
                        const response = await fetch(proxyApiUrl(sourceContent), { signal: controller.signal });
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        return response.blob();
                    })());
                if (cancelled || controller.signal.aborted || tokenRef.current !== token) return;
                const context = new AudioContext();
                contextRef.current = context;
                const bytes = await blob.arrayBuffer();
                if (cancelled || controller.signal.aborted || tokenRef.current !== token) {
                    await context.close();
                    if (contextRef.current === context) contextRef.current = null;
                    return;
                }
                const decoded = await context.decodeAudioData(bytes);
                if (cancelled || controller.signal.aborted || tokenRef.current !== token) {
                    await context.close();
                    return;
                }
                setBuffer(decoded);
                setPeaks(summarizeAudioPeaks(decoded, AUDIO_TIMELINE_PEAK_BUCKETS));
                setEnd(decoded.duration);
                setLoading(false);
            } catch {
                if (!cancelled && tokenRef.current === token) {
                    setLoading(false);
                    setError(true);
                    void contextRef.current?.close();
                    contextRef.current = null;
                }
            } finally {
                clearTimeout(timeout);
            }
        })();
        return () => {
            cancelled = true;
            controller.abort();
            clearTimeout(timeout);
            tokenRef.current++;
            cancelEncodeRef.current = true;
            trimAbortRef.current?.abort();
            sourceRef.current?.stop();
            sourceRef.current = null;
            setPlaying(false);
            void contextRef.current?.close();
            contextRef.current = null;
        };
    }, [open, node?.id, sourceContent, storageKey, attempt]);
    const playbackRef = useRef<{ contextStart: number; audioStart: number } | null>(null);
    const playTokenRef = useRef(0);
    const stop = () => {
        const context = contextRef.current;
        const playback = playbackRef.current;
        if (context && playback && playing) setCursor(Math.min(rangeRef.current.end, playback.audioStart + Math.max(0, context.currentTime - playback.contextStart)));
        playTokenRef.current++;
        sourceRef.current?.stop();
        sourceRef.current = null;
        playbackRef.current = null;
        setPlaying(false);
    };
    const updateRange = (a: number, b: number, moving: "start" | "end" | "both" = "both") => {
        if (!buffer) return { start, end };
        const next = snapAudioTrimRange(a, b, buffer.duration, buffer.sampleRate, moving);
        stop();
        setStart(next.start);
        setEnd(next.end);
        setCursor(next.start);
        return next;
    };
    const togglePlayback = async () => {
        if (!buffer || disabled) return;
        if (playing) {
            stop();
            return;
        }
        const token = ++playTokenRef.current;
        const targetBuffer = buffer;
        const selection = { ...rangeRef.current };
        const resumeAt = cursor >= selection.end - 1 / buffer.sampleRate ? selection.start : Math.max(selection.start, Math.min(selection.end, cursor));
        try {
            const context = contextRef.current;
            if (!context) return;
            await context.resume();
            if (!aliveRef.current || token !== playTokenRef.current || !open || contextRef.current !== context || buffer !== targetBuffer || rangeRef.current.start !== selection.start || rangeRef.current.end !== selection.end) return;
            const range = getAudioSampleRange(resumeAt, selection.end, buffer.sampleRate, buffer.length);
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(context.destination);
            source.onended = () => {
                if (sourceRef.current === source && token === playTokenRef.current) {
                    sourceRef.current = null;
                    playbackRef.current = null;
                    setPlaying(false);
                    setCursor(selection.end);
                }
            };
            source.start(0, range.start / buffer.sampleRate, (range.end - range.start) / buffer.sampleRate);
            sourceRef.current = source;
            playbackRef.current = { contextStart: context.currentTime, audioStart: range.start / buffer.sampleRate };
            setPlaying(true);
            setCursor(range.start / buffer.sampleRate);
        } catch {
            if (aliveRef.current && token === playTokenRef.current) message.error(t("canvas.audioTrim.playFailed"));
        }
    };
    useEffect(() => {
        if (!playing || !contextRef.current) return;
        let raf = 0;
        const frame = () => {
            const context = contextRef.current;
            const playback = playbackRef.current;
            if (context && playback) setCursor(Math.min(end, playback.audioStart + Math.max(0, context.currentTime - playback.contextStart)));
            if (sourceRef.current) raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [playing, start, end]);
    const trim = async () => {
        if (!buffer || busy) return;
        const range = getAudioSampleRange(start, end, buffer.sampleRate, buffer.length);
        const token = tokenRef.current;
        const abort = new AbortController();
        trimAbortRef.current = abort;
        cancelEncodeRef.current = false;
        setBusy(true);
        stop();
        try {
            const blob = await encodePcm16WavAsync(buffer, range.start, range.end, () => cancelEncodeRef.current || abort.signal.aborted || !aliveRef.current || token !== tokenRef.current);
            if (!aliveRef.current || abort.signal.aborted || token !== tokenRef.current) return;
            const startMs = Math.floor((range.start * 1000) / buffer.sampleRate);
            const endMs = Math.max(startMs + 1, Math.ceil((range.end * 1000) / buffer.sampleRate));
            await onTrim(blob, startMs, endMs, ((range.end - range.start) * 1000) / buffer.sampleRate, abort.signal);
        } catch {
            if (!cancelEncodeRef.current && aliveRef.current && !abort.signal.aborted) message.error(t("canvas.audioTrim.failed"));
        } finally {
            if (trimAbortRef.current === abort) trimAbortRef.current = null;
            if (aliveRef.current) setBusy(false);
        }
    };
    const duration = buffer?.duration || 0;
    const disabled = !buffer || busy || loading;
    return (
        <Modal
            title={t("canvas.audioTrim.title")}
            open={open}
            centered
            width="min(900px, calc(100vw - 24px))"
            footer={null}
            destroyOnHidden
            onCancel={onClose}
            maskClosable={!busy}
            closable={!busy}
            keyboard={!busy}
            afterOpenChange={(visible) => {
                if (!visible) onClose();
            }}
        >
            <div data-canvas-no-zoom data-canvas-shortcuts-ignore className="space-y-5" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                <div className="text-sm opacity-70">{node?.title}</div>
                {peaks && buffer ? (
                    <CanvasAudioTrimTimeline
                        peaks={peaks}
                        duration={duration}
                        sampleRate={buffer.sampleRate}
                        start={start}
                        end={end}
                        cursor={cursor}
                        disabled={disabled}
                        onRangeChange={updateRange}
                        onSeek={(time) => {
                            stop();
                            setCursor(time);
                        }}
                    />
                ) : (
                    <div className="flex min-h-[220px] items-center justify-center rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900">
                        {loading ? (
                            <div className="flex items-center gap-3">
                                <Spin />
                                {t("canvas.audioTrim.loading")}
                            </div>
                        ) : error ? (
                            <div className="flex flex-col items-center gap-3">
                                {t("canvas.audioTrim.loadError")}
                                <Button onClick={() => setAttempt((v) => v + 1)}>{t("canvas.audioTrim.retry")}</Button>
                            </div>
                        ) : null}
                    </div>
                )}
                <div className="flex flex-wrap items-center gap-3 pt-2">
                    <Button aria-label={playing ? t("canvas.audioTrim.pause") : t("canvas.audioTrim.play")} icon={playing ? <Pause className="size-4" /> : <Play className="size-4" />} disabled={disabled} onClick={() => void togglePlayback()} />
                    <span className="font-mono text-sm tabular-nums">
                        {formatAudioTime(cursor)} / {formatAudioTime(duration)}
                    </span>
                    <label className="ml-auto flex items-center gap-2 text-sm">
                        {t("canvas.audioTrim.start")}
                        <InputNumber
                            min={0}
                            max={Math.max(0, end - (buffer ? 1 / buffer.sampleRate : 0))}
                            step={0.01}
                            precision={2}
                            value={Number(start.toFixed(2))}
                            disabled={disabled}
                            onChange={(v) => {
                                if (v !== null) updateRange(v, end, "start");
                            }}
                            addonAfter="s"
                        />
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                        {t("canvas.audioTrim.end")}
                        <InputNumber
                            min={start + (buffer ? 1 / buffer.sampleRate : 0)}
                            max={duration}
                            step={0.01}
                            precision={2}
                            value={Number(end.toFixed(2))}
                            disabled={disabled}
                            onChange={(v) => {
                                if (v !== null) updateRange(start, v, "end");
                            }}
                            addonAfter="s"
                        />
                    </label>
                    <span className="text-sm opacity-70">{t("canvas.audioTrim.selectedDuration", { duration: formatAudioTime(Math.max(0, end - start)) })}</span>
                </div>
                <div className="flex justify-end gap-2">
                    <Button onClick={onClose} disabled={busy}>
                        {t("canvas.audioTrim.close")}
                    </Button>
                    <Button type="primary" icon={<Scissors className="size-4" />} loading={busy} disabled={disabled} onClick={() => void trim()}>
                        {t("canvas.audioTrim.trim")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
