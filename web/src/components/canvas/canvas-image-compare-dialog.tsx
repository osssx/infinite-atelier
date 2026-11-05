import { useState, type PointerEvent } from "react";
import { Modal, Button } from "antd";
import { ArrowLeftRight, GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";

type CompareImage = { src: string; title: string };
export function CanvasImageCompareDialog({ images, onClose }: { images: [CompareImage, CompareImage]; onClose: () => void }) {
    const { t } = useTranslation();
    const [position, setPosition] = useState(50);
    const [swapped, setSwapped] = useState(false);
    const [failed, setFailed] = useState(false);
    const [first, second] = swapped ? [images[1], images[0]] : images;
    const updatePosition = (event: PointerEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPosition(Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100)));
    };
    return (
        <Modal open title={t("canvas.controls.compareImages")} onCancel={onClose} footer={null} width="min(1100px, 94vw)" centered destroyOnHidden>
            <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>{t("canvas.imageCompare.hint")}</span>
                <Button size="small" icon={<ArrowLeftRight size={14} />} onClick={() => setSwapped((value) => !value)}>{t("canvas.imageCompare.swap")}</Button>
            </div>
            <div
                className="relative h-[65dvh] min-h-48 touch-none select-none overflow-hidden rounded-xl border border-border bg-muted"
                onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    updatePosition(event);
                }}
                onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePosition(event); }}
                onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
                onPointerCancel={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
            >
                <img src={second.src} alt={second.title} draggable={false} onError={() => setFailed(true)} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
                <div className="pointer-events-none absolute inset-0 bg-muted" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}>
                    <img src={first.src} alt={first.title} draggable={false} onError={() => setFailed(true)} className="h-full w-full object-contain" />
                </div>
                <div className="pointer-events-none absolute left-3 top-3 max-w-[40%] truncate rounded-md bg-black/65 px-2 py-1 text-xs text-white">A · {first.title}</div>
                <div className="pointer-events-none absolute right-3 top-3 max-w-[40%] truncate rounded-md bg-black/65 px-2 py-1 text-xs text-white">B · {second.title}</div>
                <div
                    role="slider" tabIndex={0} aria-label={t("canvas.imageCompare.divider")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(position)}
                    className="absolute inset-y-0 w-0.5 -translate-x-1/2 cursor-ew-resize bg-white shadow-[0_0_4px_#0008] outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                    style={{ left: `${position}%` }}
                    onKeyDown={(event) => {
                        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                        event.preventDefault();
                        setPosition((value) => event.key === "Home" ? 0 : event.key === "End" ? 100 : Math.max(0, Math.min(100, value + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1))));
                    }}
                >
                    <span className="absolute left-1/2 top-1/2 grid h-11 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-black/15 bg-white text-slate-700 shadow-md"><GripVertical size={18} /></span>
                </div>
            </div>
            {failed ? <p role="alert" className="mt-2 text-xs text-red-500">{t("canvas.imageCompare.loadError")}</p> : null}
        </Modal>
    );
}
