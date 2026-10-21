import { isNativeDescendantEvent } from "@/lib/canvas/canvas-portal-events";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { applyAnchoredWheelZoom } from "@/lib/canvas/canvas-wheel-zoom";
import { canFastPanAtScale, FAST_PAN_COMMIT_INTERVAL_MS, gridPositionForViewport, worldTransformForViewport } from "@/lib/canvas/canvas-pan-fast-path";
import { setPreviewGenerationSuspended } from "@/services/media-preview-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

type AtelierCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    tool: "select" | "pan";
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    /** Marks the short wheel gesture window so media nodes can defer expensive LOD promotion. */
    onWheelActivityChange?: (active: boolean) => void;
    onPanActivityChange?: (active: boolean) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
};

// Capture node wheel gestures before bubbling handlers can swallow them.
// Preserve native scrolling for editors and menus.
const canvasWheelExcludedSelector = "[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown,textarea,[contenteditable='true']";

export function AtelierCanvas({ containerRef, viewport, tool, backgroundMode = "lines", onViewportChange, onWheelActivityChange, onPanActivityChange, onCanvasMouseDown, onCanvasDeselect, onCanvasDoubleClick, onContextMenu, onDrop, children }: AtelierCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef({
        isPanning: false,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
        startedOnBackground: false,
    });
    // Latest viewport, kept in a ref so gesture handlers compose from the newest value instead of the
    // last rendered prop. Wheel events arrive in bursts, and reading the prop made every event in a
    // batch compute from the same base — the later one then discarded the earlier one's zoom.
    const viewportRef = useRef(viewport);
    const worldRef = useRef<HTMLDivElement | null>(null);
    const gridRef = useRef<HTMLDivElement | null>(null);
    const fastPanRef = useRef(false);
    const lastPanCommitRef = useRef(0);
    const applyPanVisual = (next: ViewportTransform) => {
        if (worldRef.current) worldRef.current.style.transform = worldTransformForViewport(next);
        if (gridRef.current) gridRef.current.style.backgroundPosition = gridPositionForViewport(next);
    };
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    // Wheel input is composed immediately into a pending viewport, but React is updated only once
    // per frame. Keeping the complete transform (not just a zoom factor) respects changing anchors.
    const wheelFrameRef = useRef<number | null>(null);
    const pendingWheelViewportRef = useRef<ViewportTransform | null>(null);
    const wheelRectRef = useRef<DOMRect | null>(null);
    const wheelIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isControlPressed, setIsControlPressed] = useState(false);
    const [isPanning, setIsPanning] = useState(false);

    useEffect(() => {
        // A React commit may land between two wheel events. Do not replace a more recent
        // uncommitted wheel transform with props from an older render.
        if (!fastPanRef.current && pendingWheelViewportRef.current === null) viewportRef.current = viewport;
    }, [viewport]);

    useLayoutEffect(() => {
        // A React commit may carry a slightly older viewport than the latest drag event.
        if (fastPanRef.current) applyPanVisual(viewportRef.current);
    });

    useEffect(
        () => () => {
            if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
            if (wheelFrameRef.current !== null) cancelAnimationFrame(wheelFrameRef.current);
            if (wheelIdleTimerRef.current !== null) clearTimeout(wheelIdleTimerRef.current);
            setPreviewGenerationSuspended(false, "wheel");
            setPreviewGenerationSuspended(false, "pan");
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Control") setIsControlPressed(true);
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            event.preventDefault();
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") {
                const target = event.target instanceof Element ? event.target : null;
                if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']"))) event.preventDefault();
                setIsSpacePressed(false);
            }
            if (event.key === "Control") setIsControlPressed(false);
        };

        const handleBlur = () => {
            if (panState.current.isPanning) {
                if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
                frameRef.current = null;
                const finalViewport = nextViewportRef.current ?? viewportRef.current;
                nextViewportRef.current = null;
                viewportRef.current = finalViewport;
                if (fastPanRef.current) applyPanVisual(finalViewport);
                fastPanRef.current = false;
                onViewportChange(finalViewport);
            }
            setIsSpacePressed(false);
            setIsControlPressed(false);
            panState.current.isPanning = false;
            setPreviewGenerationSuspended(false, "pan");
            onPanActivityChange?.(false);
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, [onPanActivityChange, onViewportChange]);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        // React can forward portal events through ancestors outside their actual DOM tree.
        if (!isNativeDescendantEvent(event.currentTarget, event.target)) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(canvasWheelExcludedSelector)) return;

        const rect = wheelRectRef.current ?? containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        wheelRectRef.current = rect;
        setPreviewGenerationSuspended(true, "wheel");

        // Cancel mass media promotion during wheel bursts. Do not schedule React updates for
        // each wheel event: one "start" update and one "idle" update per gesture is enough.
        if (wheelIdleTimerRef.current === null) onWheelActivityChange?.(true);
        else clearTimeout(wheelIdleTimerRef.current);
        wheelIdleTimerRef.current = setTimeout(() => {
            wheelIdleTimerRef.current = null;
            onWheelActivityChange?.(false);
            setPreviewGenerationSuspended(false, "wheel");
        }, 180);

        // Compose synchronously, preserving every event even when several arrive before React
        // commits. Neither a stale viewport prop nor a changed cursor anchor can lose a delta.
        if (fastPanRef.current) {
            // A wheel gesture must compose from the latest directly positioned viewport.
            if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
            const latest = nextViewportRef.current ?? viewportRef.current;
            nextViewportRef.current = null;
            viewportRef.current = latest;
            fastPanRef.current = false;
            onViewportChange(latest);
        }
        const next = applyAnchoredWheelZoom(
            pendingWheelViewportRef.current ?? viewportRef.current,
            event.deltaY,
            event.clientX - rect.left,
            event.clientY - rect.top,
        );
        pendingWheelViewportRef.current = next;
        viewportRef.current = next;
        if (wheelFrameRef.current !== null) return;
        wheelFrameRef.current = requestAnimationFrame(() => {
            wheelFrameRef.current = null;
            wheelRectRef.current = null;
            const committed = pendingWheelViewportRef.current;
            pendingWheelViewportRef.current = null;
            if (committed) onViewportChange(committed);
        });
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        // Ant Design dropdowns are portaled to document.body; React still bubbles
        // their events through the canvas component tree. Do not capture the pointer
        // or deselect nodes when the real DOM target is outside this canvas.
        if (!isNativeDescendantEvent(event.currentTarget, event.target)) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");
        const temporaryTool = event.ctrlKey || isSpacePressed;
        const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
        const shouldPan = event.button === 1 || (event.button === 0 && activeTool === "pan" && isBackgroundClick);

        if (shouldPan) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: viewportRef.current.x,
                initialY: viewportRef.current.y,
                hasMoved: false,
                startedOnBackground: isBackgroundClick,
            };

            fastPanRef.current = canFastPanAtScale(viewportRef.current.k);
            lastPanCommitRef.current = performance.now();
            setIsPanning(true);
            setPreviewGenerationSuspended(true, "pan");
            onPanActivityChange?.(true);
            document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
        }
    };

    const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],[data-node-id],[data-connection-id]")) return;
        onCanvasDoubleClick?.(event);
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;

            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            nextViewportRef.current = {
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: viewportRef.current.k,
            };
            if (frameRef.current !== null) return;
            frameRef.current = requestAnimationFrame((time) => {
                frameRef.current = null;
                const next = nextViewportRef.current;
                nextViewportRef.current = null;
                if (!next) return;
                viewportRef.current = next;
                if (fastPanRef.current) {
                    applyPanVisual(next);
                    if (time - lastPanCommitRef.current < FAST_PAN_COMMIT_INTERVAL_MS) return;
                    lastPanCommitRef.current = time;
                }
                onViewportChange(next);
            });
        };

        const handlePointerUp = () => {
            if (!panState.current.isPanning) return;

            if (!panState.current.hasMoved && panState.current.startedOnBackground) {
                onCanvasDeselect?.();
            }
            // Commit the most recent position before clearing gesture state.
            // The final pointermove may still be waiting for its rAF.
            if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
            const finalViewport = nextViewportRef.current ?? viewportRef.current;
            nextViewportRef.current = null;
            if (finalViewport.x !== panState.current.initialX || finalViewport.y !== panState.current.initialY) {
                viewportRef.current = finalViewport;
                if (fastPanRef.current) applyPanVisual(finalViewport);
                onViewportChange(finalViewport);
            }
            fastPanRef.current = false;
            panState.current.isPanning = false;
            setPreviewGenerationSuspended(false, "pan");
            onPanActivityChange?.(false);
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            document.body.style.cursor = "";
        };
    }, [onCanvasDeselect, onViewportChange, onPanActivityChange]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Prevent canvas scrolling from moving the page while preserving native scrolling inside overlays and dialogs.
        const preventWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest(canvasWheelExcludedSelector)) return;
            event.preventDefault();
        };
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventWheelScroll);
    }, [containerRef]);

    const temporaryTool = isControlPressed || isSpacePressed;
    const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
    const cursor = isPanning ? "grabbing" : activeTool === "pan" ? "grab" : undefined;

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full select-none overflow-hidden"
            style={{ background: theme.canvas.background, cursor }}
            onPointerDown={handlePointerDown}
            onDoubleClick={handleDoubleClick}
            onWheelCapture={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <CanvasGrid viewport={viewport} mode={backgroundMode} gridRef={gridRef} />
            <div
                ref={worldRef}
                className="absolute origin-top-left"
                style={{
                    transform: worldTransformForViewport(viewport),
                }}
            >
                {children}
            </div>
        </div>
    );
}

function CanvasGrid({ viewport, mode, gridRef }: { viewport: ViewportTransform; mode: CanvasBackgroundMode; gridRef: React.RefObject<HTMLDivElement | null> }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = 48 * viewport.k;
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            ref={gridRef}
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
}
