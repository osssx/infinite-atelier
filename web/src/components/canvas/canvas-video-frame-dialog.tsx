import { useEffect, useRef, useState } from "react";
import { App, Button, InputNumber, Modal, Slider, Spin } from "antd";
import { Pause, Play, Scissors } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getMediaBlob } from "@/services/file-storage";
import { proxyApiUrl } from "@/lib/api-proxy";
import { createLatestVideoSeeker } from "@/lib/canvas/video-frame-seeker";
import type { CanvasNodeData } from "@/types/canvas";

const OPERATION_TIMEOUT_MS = 30_000;

export function CanvasVideoFrameDialog({ node, open, onClose, onCapture }: { node: CanvasNodeData | null; open: boolean; onClose: () => void; onCapture: (blob: Blob, timeMs: number, width: number, height: number) => Promise<void> }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const videoRef = useRef<HTMLVideoElement>(null);
    const objectUrlRef = useRef<string | null>(null);
    const sourceRevision = useRef(0);
    const sourceAbortRef = useRef<AbortController | null>(null);
    const seekerRef = useRef<ReturnType<typeof createLatestVideoSeeker> | null>(null);
    const loadTimeoutRef = useRef<number | null>(null);
    const alive = useRef(true);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [seeking, setSeeking] = useState(false);
    const [scrubbing, setScrubbing] = useState(false);
    const [error, setError] = useState(false);
    const [duration, setDuration] = useState(0);
    const [time, setTime] = useState(0);
    const [seekTarget, setSeekTarget] = useState<number | null>(null);
    const [playing, setPlaying] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadAttempt, setLoadAttempt] = useState(0);
    const sourceContent = node?.metadata?.content || "";
    const storageKey = node?.metadata?.storageKey;

    useEffect(() => {
        alive.current = true;
        if (!open || !sourceContent || !node) return;
        let cancelled = false;
        const controller = new AbortController();
        sourceAbortRef.current = controller;
        setReady(false); setError(false); setLoading(true); setBusy(false); setSeeking(false); setScrubbing(false); setTime(0); setSeekTarget(null); setDuration(0); setPlaying(false);
        loadTimeoutRef.current = window.setTimeout(() => { controller.abort(); if (!cancelled) { setError(true); setLoading(false); } }, OPERATION_TIMEOUT_MS);
        void (async () => {
            try {
                const localBlob = storageKey ? await getMediaBlob(storageKey) : null;
                const blob = localBlob || await (async () => {
                    const response = await fetch(proxyApiUrl(sourceContent), { signal: controller.signal });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.blob();
                })();
                if (cancelled || controller.signal.aborted) return;
                const url = URL.createObjectURL(blob); objectUrlRef.current = url;
                const video = videoRef.current;
                if (!video) return;
                video.src = url; video.load();
            } catch { if (!cancelled) { if (loadTimeoutRef.current !== null) clearTimeout(loadTimeoutRef.current); loadTimeoutRef.current = null; setError(true); setLoading(false); } }
        })();
        return () => {
            cancelled = true; sourceRevision.current += 1; controller.abort();
            if (loadTimeoutRef.current !== null) clearTimeout(loadTimeoutRef.current);
            loadTimeoutRef.current = null; sourceAbortRef.current = null;
            seekerRef.current?.cancel(); seekerRef.current = null;
            const video = videoRef.current;
            if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
        };
    }, [node?.id, open, sourceContent, storageKey, loadAttempt]);

    useEffect(() => () => { alive.current = false; }, []);

    const onLoadedData = () => {
        if (!sourceAbortRef.current || sourceAbortRef.current.signal.aborted) return;
        const video = videoRef.current;
        if (!video || video.readyState < 2) return;
        if (loadTimeoutRef.current !== null) clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
        video.pause(); video.currentTime = 0;
        setDuration(Number.isFinite(video.duration) ? video.duration : 0); setTime(0); setSeekTarget(null); setScrubbing(false); setReady(true); setLoading(false); setError(false);
    };
    const onVideoError = () => {
        if (!sourceAbortRef.current || sourceAbortRef.current.signal.aborted) return;
        videoRef.current?.pause();
        setPlaying(false);
        if (loadTimeoutRef.current !== null) clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
        setReady(false); setError(true); setLoading(false);
    };

    const getSeeker = (video: HTMLVideoElement) => {
        if (seekerRef.current) return seekerRef.current;
        const seeker = createLatestVideoSeeker({
            pause: () => video.pause(),
            currentTime: () => video.currentTime,
            isReady: () => video.readyState >= 2 && !video.seeking,
            seekTo: (target) => new Promise<void>((resolve, reject) => {
                const sourceSignal = sourceAbortRef.current?.signal;
                if (!sourceSignal || sourceSignal.aborted) { reject(new Error("Video source cancelled")); return; }
                if (Math.abs(video.currentTime - target) <= 0.001 && !video.seeking && video.readyState >= 2) { resolve(); return; }
                const cleanup = () => { clearTimeout(timer); video.removeEventListener("seeked", onSeeked); sourceSignal.removeEventListener("abort", onAbort); };
                const onAbort = () => { cleanup(); reject(new Error("Video source cancelled")); };
                const onSeeked = () => { if (video.readyState >= 2 && !video.seeking) { cleanup(); resolve(); } };
                const timer = window.setTimeout(() => { cleanup(); reject(new Error("Video seek timed out")); }, OPERATION_TIMEOUT_MS);
                video.addEventListener("seeked", onSeeked);
                sourceSignal.addEventListener("abort", onAbort, { once: true });
                video.currentTime = target;
            }),
        });
        seekerRef.current = seeker;
        return seeker;
    };

    const seek = async (requested: number) => {
        const video = videoRef.current;
        if (!video || !ready || busy || !Number.isFinite(requested)) return;
        const target = Math.max(0, Math.min(duration || 0, requested));
        setSeekTarget(target); setSeeking(true); video.pause(); setPlaying(false);
        const seeker = getSeeker(video);
        try { setTime(await seeker.seek(target)); }
        catch { if (seekerRef.current === seeker && !sourceAbortRef.current?.signal.aborted) { seekerRef.current = null; setReady(false); setError(true); setLoading(false); } }
        finally { if (seekerRef.current === seeker && !sourceAbortRef.current?.signal.aborted) { setSeeking(false); setSeekTarget(null); } }
    };

    const capture = async () => {
        const video = videoRef.current;
        if (!video || !ready || busy || seeking || scrubbing || video.seeking || video.readyState < 2 || !node) return;
        setBusy(true); video.pause(); setPlaying(false);
        const token = sourceRevision.current;
        const sourceUrl = video.currentSrc;
        const frozenTime = video.currentTime;
        const width = video.videoWidth;
        const height = video.videoHeight;
        try {
            if (!width || !height) throw new Error("Video frame is unavailable");
            const blob = await new Promise<Blob>((resolve, reject) => {
                const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
                const context = canvas.getContext("2d"); if (!context) return reject(new Error("Canvas unavailable"));
                context.drawImage(video, 0, 0, width, height);
                canvas.toBlob((result) => result ? resolve(result) : reject(new Error("PNG encode failed")), "image/png");
            });
            if (!alive.current || sourceRevision.current !== token || !videoRef.current || videoRef.current.currentSrc !== sourceUrl || videoRef.current.seeking || Math.abs(videoRef.current.currentTime - frozenTime) > 0.002) return;
            await onCapture(blob, Math.round(frozenTime * 1000), width, height);
        } catch { message.error(t("canvas.videoFrame.captureFailed")); }
        finally { if (alive.current) setBusy(false); }
    };

    const togglePlayback = () => {
        const video = videoRef.current; if (!video || busy || seeking || scrubbing) return;
        if (video.paused) void video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
        else { video.pause(); setPlaying(false); }
    };
    // During pointer movement update the UI only. Decode the selected frame
    // once on release instead of scheduling a seek for every slider event.
    // The existing time label shows the precise selection without a popup.
    const onScrubChange = (value: number) => {
        if (!ready || busy || !Number.isFinite(value)) return;
        const target = Math.max(0, Math.min(duration, value));
        setScrubbing(true);
        setSeekTarget(target);
        videoRef.current?.pause();
        setPlaying(false);
    };
    const onScrubComplete = (value: number) => {
        setScrubbing(false);
        if (!Number.isFinite(value)) { setSeekTarget(null); return; }
        void seek(value);
    };
    const retry = () => { setError(false); setLoading(true); setReady(false); setLoadAttempt((value) => value + 1); };

    return <Modal title={t("canvas.videoFrame.title")} open={open} centered width="min(900px, calc(100vw - 24px))" footer={null} destroyOnHidden onCancel={onClose} maskClosable={!busy} closable={!busy} keyboard={!busy} afterOpenChange={(visible) => { if (!visible) onClose(); }}>
        <div data-canvas-no-zoom data-canvas-shortcuts-ignore className="space-y-4" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
            <div className="relative flex min-h-[260px] max-h-[62vh] items-center justify-center overflow-hidden rounded-lg bg-black">
                <video ref={videoRef} className="max-h-[62vh] max-w-full" playsInline muted preload="auto" onLoadedMetadata={() => { const video = videoRef.current; if (video && Number.isFinite(video.duration)) setDuration(video.duration); }} onLoadedData={onLoadedData} onDurationChange={() => { const video = videoRef.current; if (video && Number.isFinite(video.duration)) setDuration(video.duration); }} onTimeUpdate={() => { const video = videoRef.current; if (video && !video.seeking && !seeking && seekTarget === null) setTime(video.currentTime); }} onEnded={() => setPlaying(false)} onError={onVideoError} />
                {loading ? <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white"><Spin /> <span className="ml-3">{t("canvas.videoFrame.loading")}</span></div> : null}
                {error ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-white"><span>{t("canvas.videoFrame.loadError")}</span><Button onClick={retry}>{t("canvas.videoFrame.retry")}</Button></div> : null}
            </div>
            <div className="flex items-center gap-3">
                <Button aria-label={playing ? t("canvas.videoFrame.pause") : t("canvas.videoFrame.play")} icon={playing ? <Pause className="size-4" /> : <Play className="size-4" />} disabled={!ready || busy || seeking || scrubbing} onClick={togglePlayback} />
                <span className="min-w-32 text-center font-mono text-sm tabular-nums">{formatTime(seekTarget ?? time)} / {formatTime(duration)}</span>
                <Slider className="m-0 flex-1" min={0} max={duration || 0} step={0.01} value={Math.min(seekTarget ?? time, duration || 0)} disabled={!ready || busy} tooltip={{ open: false, formatter: null }} onChange={onScrubChange} onChangeComplete={onScrubComplete} />
                <InputNumber aria-label={t("canvas.videoFrame.time")} min={0} max={duration || 0} step={0.01} precision={2} value={Number((seekTarget ?? time).toFixed(2))} disabled={!ready || busy || scrubbing} onChange={(value) => { if (value !== null) void seek(value); }} addonAfter="s" className="w-32" />
            </div>
            <div className="flex justify-end gap-2"><Button onClick={onClose} disabled={busy}>{t("canvas.videoFrame.close")}</Button><Button type="primary" icon={<Scissors className="size-4" />} loading={busy} disabled={!ready || busy || seeking || scrubbing} onClick={() => void capture()}>{t("canvas.videoFrame.capture")}</Button></div>
        </div>
    </Modal>;
}

function formatTime(seconds: number) { const safe = Math.max(0, seconds || 0); const mins = Math.floor(safe / 60); return `${String(mins).padStart(2, "0")}:${(safe - mins * 60).toFixed(3).padStart(6, "0")}`; }
