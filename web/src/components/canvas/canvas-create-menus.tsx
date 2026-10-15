import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ImageIcon, List, Music2, Settings2, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { canvasPopupPosition } from "@/lib/canvas/canvas-popup-position";
import { useThemeStore } from "@/stores/use-theme-store";
import { listNodeDefinitions } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type ConnectionHandle, type Position, type ViewportTransform } from "@/types/canvas";

export type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
};

type CanvasMenuLocation = {
    canvasRef: RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
};

/** Keep canvas-world anchors, but render menus as fixed-size screen overlays. */
function useCanvasMenuPlacement(anchor: Position, { canvasRef, viewport }: CanvasMenuLocation) {
    const menuRef = useRef<HTMLDivElement>(null);
    const [screenPosition, setScreenPosition] = useState<Position | null>(null);

    useLayoutEffect(() => {
        const update = () => {
            const container = canvasRef.current;
            const menu = menuRef.current;
            if (!container || !menu) return;
            const next = canvasPopupPosition(
                anchor,
                viewport,
                container.getBoundingClientRect(),
                { width: menu.offsetWidth || 300, height: menu.offsetHeight || 400 },
                { width: window.innerWidth, height: window.innerHeight },
            );
            setScreenPosition((current) => current?.x === next.x && current.y === next.y ? current : next);
        };
        update();
        window.addEventListener("resize", update);
        window.addEventListener("scroll", update, true);
        const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
        if (canvasRef.current) observer?.observe(canvasRef.current);
        if (menuRef.current) observer?.observe(menuRef.current);
        return () => {
            window.removeEventListener("resize", update);
            window.removeEventListener("scroll", update, true);
            observer?.disconnect();
        };
    }, [anchor.x, anchor.y, canvasRef, viewport.k, viewport.x, viewport.y]);

    return {
        menuRef,
        style: {
            position: "fixed" as const,
            left: screenPosition?.x ?? 0,
            top: screenPosition?.y ?? 0,
            visibility: screenPosition ? "visible" as const : "hidden" as const,
        },
    };
}

export function ConnectionCreateMenu({
    pending,
    canvasRef,
    viewport,
    onCreate,
    onClose,
}: {
    pending: PendingConnectionCreate;
    onCreate: (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio) => void;
    onClose: () => void;
} & CanvasMenuLocation) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const { menuRef, style } = useCanvasMenuPlacement(pending.position, { canvasRef, viewport });

    useEffect(() => {
        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
        };
        document.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    }, [onClose, menuRef]);

    return createPortal(
        <div
            ref={menuRef}
            className="z-[1200] max-h-[calc(100vh-24px)] w-[300px] overflow-y-auto rounded-[18px] border p-3 shadow-2xl backdrop-blur"
            data-connection-create-menu
            data-canvas-no-zoom
            style={{ ...style, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    {t("canvas.createMenu.fromNode")}
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:bg-white/10 hover:opacity-100" onClick={onClose} aria-label={t("canvas.createMenu.close")}>
                    ×
                </button>
            </div>
            <div className="grid gap-1">
                <ConnectionCreateOption theme={theme} icon={<List className="size-5" />} title={t("canvas.createMenu.text")} description={t("canvas.createMenu.textDescription")} onClick={() => onCreate(CanvasNodeType.Text)} />
                <ConnectionCreateOption theme={theme} icon={<ImageIcon className="size-5" />} title={t("canvas.createMenu.image")} onClick={() => onCreate(CanvasNodeType.Image)} />
                <ConnectionCreateOption theme={theme} icon={<Video className="size-5" />} title={t("canvas.createMenu.video")} onClick={() => onCreate(CanvasNodeType.Video)} />
                <ConnectionCreateOption theme={theme} icon={<Music2 className="size-5" />} title={t("canvas.createMenu.audio")} onClick={() => onCreate(CanvasNodeType.Audio)} />
                <ConnectionCreateOption theme={theme} icon={<Settings2 className="size-5" />} title={t("canvas.createMenu.config")} description={t("canvas.createMenu.configDescription")} onClick={() => onCreate(CanvasNodeType.Config)} />
            </div>
        </div>,
        document.body,
    );
}

export function ConnectionCreateOption({ theme, icon, title, description, onClick }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; icon: React.ReactNode; title: string; description?: string; onClick?: () => void }) {
    return (
        <button
            type="button"
            className="flex h-16 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left transition"
            style={{ color: theme.node.text }}
            onClick={onClick}
            onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
            onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
        >
            <span className="grid size-11 shrink-0 place-items-center rounded-xl" style={{ background: theme.node.fill, color: theme.node.muted }}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-base font-semibold leading-5">{title}</span>
                {description ? (
                    <span className="mt-1 block truncate text-sm" style={{ color: theme.node.muted }}>
                        {description}
                    </span>
                ) : null}
            </span>
        </button>
    );
}

export function NodeCreateMenu({ position, canvasRef, viewport, onCreate, onClose }: { position: Position; onCreate: (type: string) => void; onClose: () => void } & CanvasMenuLocation) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const { menuRef, style } = useCanvasMenuPlacement(position, { canvasRef, viewport });
    const definitions = listNodeDefinitions().filter((def) => def.showInCreateMenu !== false);

    useEffect(() => {
        const handlePointerDown = (event: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
        };
        document.addEventListener("pointerdown", handlePointerDown, true);
        return () => document.removeEventListener("pointerdown", handlePointerDown, true);
    }, [onClose, menuRef]);

    return createPortal(
        <div
            ref={menuRef}
            className="z-[1200] max-h-[70vh] w-[300px] overflow-y-auto rounded-[18px] border p-3 shadow-2xl backdrop-blur thin-scrollbar"
            data-canvas-no-zoom
            style={{ ...style, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    {t("canvas.createMenu.select")}
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg opacity-55 transition hover:opacity-100" onClick={onClose} aria-label={t("canvas.createMenu.close")}>
                    <X className="size-4" />
                </button>
            </div>
            <div className="grid gap-1">
                {definitions.map((def) => (
                    <ConnectionCreateOption key={def.type} theme={theme} icon={def.icon} title={def.title} description={def.description} onClick={() => onCreate(def.type)} />
                ))}
            </div>
        </div>,
        document.body,
    );
}
