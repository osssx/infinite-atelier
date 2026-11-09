import { createWheelPressureMonitor, type WheelZoomDirection } from "@/lib/canvas/canvas-wheel-pressure";
import { isNativeDescendantEvent } from "@/lib/canvas/canvas-portal-events";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { applyAnchoredWheelZoom, resolveWheelCommitViewport } from "@/lib/canvas/canvas-wheel-zoom";
import { canFastPanAtScale, gridPositionForViewport, shouldCommitFastPan, shouldCommitFastViewport, worldTransformForViewport } from "@/lib/canvas/canvas-pan-fast-path";
import { createWebGLGridRenderer, type WebGLGridColors, type WebGLGridRenderer, type WebGLGridSize } from "@/lib/canvas/canvas-webgl-grid";
import { setPreviewGenerationSuspended } from "@/services/media-preview-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

type AtelierCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    tool: "select" | "pan";
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    /** Synchronously refreshes coordinate refs while a fast pan is between React commits. */
    onViewportFrameChange?: (viewport: ViewportTransform) => void;
    /** Marks the short wheel gesture window so media nodes can defer expensive LOD promotion. */
    onWheelZoomDirectionChange?: (direction: WheelZoomDirection) => void;
    onWheelRenderPressureChange?: (active: boolean) => void;
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

export function AtelierCanvas({ containerRef, viewport, tool, backgroundMode = "lines", onViewportChange, onViewportFrameChange, onWheelActivityChange, onWheelRenderPressureChange, onWheelZoomDirectionChange, onPanActivityChange, onCanvasMouseDown, onCanvasDeselect, onCanvasDoubleClick, onContextMenu, onDrop, children }: AtelierCanvasProps) {
    const zoomDirection = useRef<WheelZoomDirection>("none");
    const pressureCallback = useRef(onWheelRenderPressureChange);
    pressureCallback.current = onWheelRenderPressureChange;
    const pressureMonitor = useRef<ReturnType<typeof createWheelPressureMonitor> | null>(null);
    if (!pressureMonitor.current) pressureMonitor.current = createWheelPressureMonitor(active => pressureCallback.current?.(active));
    useEffect(() => {
        const reset = () => pressureMonitor.current?.reset();
        window.addEventListener("blur", reset);
        document.addEventListener("visibilitychange", reset);
        return () => { reset(); window.removeEventListener("blur", reset); document.removeEventListener("visibilitychange", reset); };
    }, []);
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
    const gridCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const gridRendererRef = useRef<WebGLGridRenderer | null>(null);
    const gridViewportSizeRef = useRef<WebGLGridSize>({ width: 0, height: 0, dpr: 1 });
    const gridConfigRef = useRef<{ mode: CanvasBackgroundMode; colors: WebGLGridColors }>({ mode: backgroundMode, colors: { line: theme.canvas.line, dot: theme.canvas.dot } });
    gridConfigRef.current = { mode: backgroundMode, colors: { line: theme.canvas.line, dot: theme.canvas.dot } };
    const drawGrid = (next: ViewportTransform) => {
        const { mode, colors } = gridConfigRef.current;
        if (mode === "blank") return;
        if (gridRendererRef.current) gridRendererRef.current.draw(next, mode, colors, gridViewportSizeRef.current);
        else if (gridRef.current) updateCssGrid(gridRef.current, next, mode, colors);
    };
    const fastPanRef = useRef(false);
    const lastPanCommitRef = useRef(0);
    const lastCommittedPanViewportRef = useRef(viewport);
    const applyPanVisual = (next: ViewportTransform) => {
        if (worldRef.current) worldRef.current.style.transform = worldTransformForViewport(next);
        drawGrid(next);
    };
    const wheelFastRef = useRef(false);
    const lastWheelCommitRef = useRef(0);
    const lastCommittedWheelViewportRef = useRef(viewport);
    const applyWheelVisual = (next: ViewportTransform) => {
        if (worldRef.current) worldRef.current.style.transform = worldTransformForViewport(next);
        drawGrid(next);
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
        if (!fastPanRef.current && !wheelFastRef.current && pendingWheelViewportRef.current === null) viewportRef.current = viewport;
    }, [viewport]);

    const updateGridSizeRef = useRef<(width: number, height: number) => void>(() => undefined);
    updateGridSizeRef.current = (width, height) => {
        const next = { width, height, dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)) };
        const previous = gridViewportSizeRef.current;
        if (previous.width === next.width && previous.height === next.height && previous.dpr === next.dpr) return;
        gridViewportSizeRef.current = next;
        const { mode, colors } = gridConfigRef.current;
        if (mode !== "blank") gridRendererRef.current?.draw(viewportRef.current, mode, colors, next);
    };

    useLayoutEffect(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) updateGridSizeRef.current(rect.width, rect.height);
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
            const rect = entries[0]?.contentRect;
            if (rect) updateGridSizeRef.current(rect.width, rect.height);
        });
        observer?.observe(container);
        const onWindowResize = () => {
            const rect = container.getBoundingClientRect();
            updateGridSizeRef.current(rect.width, rect.height);
        };
        window.addEventListener("resize", onWindowResize);
        onWindowResize();
        return () => {
            observer?.disconnect();
            window.removeEventListener("resize", onWindowResize);
        };
    }, [containerRef]);

    useLayoutEffect(() => {
        // A React commit may carry a slightly older viewport than the latest drag event.
        if (fastPanRef.current) applyPanVisual(viewportRef.current);
        else if (wheelFastRef.current) applyWheelVisual(viewportRef.current);
        else drawGrid(viewport);
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
            if (wheelFastRef.current || pendingWheelViewportRef.current) {
                if (wheelFrameRef.current !== null) cancelAnimationFrame(wheelFrameRef.current);
                wheelFrameRef.current = null;
                const finalViewport = resolveWheelCommitViewport(pendingWheelViewportRef.current, viewportRef.current);
                pendingWheelViewportRef.current = null;
                viewportRef.current = finalViewport;
                applyWheelVisual(finalViewport);
                onViewportFrameChange?.(finalViewport);
                onViewportChange(finalViewport);
                lastCommittedWheelViewportRef.current = finalViewport;
                wheelFastRef.current = false;
                wheelRectRef.current = null;
                if (wheelIdleTimerRef.current !== null) clearTimeout(wheelIdleTimerRef.current);
                wheelIdleTimerRef.current = null;
                pressureMonitor.current?.stop();
            onWheelActivityChange?.(false);
                setPreviewGenerationSuspended(false, "wheel");
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
        }, [onPanActivityChange, onViewportChange, onViewportFrameChange, onWheelActivityChange]);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        // React can forward portal events through ancestors outside their actual DOM tree.
        if (!isNativeDescendantEvent(event.currentTarget, event.target)) return;
        // Keep the viewport still while a settings portal is open, including
        // wheel gestures just outside the panel or its portaled dropdowns.
        if (event.currentTarget.ownerDocument.querySelector("[data-canvas-block-wheel-zoom]")) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(canvasWheelExcludedSelector)) return;

        const rect = wheelRectRef.current ?? containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        wheelRectRef.current = rect;
        setPreviewGenerationSuspended(true, "wheel");

        // Cancel mass media promotion during wheel bursts. Do not schedule React updates for
        // each wheel event: one "start" update and one "idle" update per gesture is enough.
        if (wheelIdleTimerRef.current === null) {
            onWheelActivityChange?.(true);
            wheelFastRef.current = true;
            lastCommittedWheelViewportRef.current = viewportRef.current;
            lastWheelCommitRef.current = performance.now();
        } else clearTimeout(wheelIdleTimerRef.current);
        wheelIdleTimerRef.current = setTimeout(() => {
            wheelIdleTimerRef.current = null;
            if (wheelFrameRef.current !== null) cancelAnimationFrame(wheelFrameRef.current);
            wheelFrameRef.current = null;
            const finalViewport = resolveWheelCommitViewport(pendingWheelViewportRef.current, viewportRef.current);
            pendingWheelViewportRef.current = null;
            viewportRef.current = finalViewport;
            applyWheelVisual(finalViewport);
            onViewportFrameChange?.(finalViewport);
            onViewportChange(finalViewport);
            lastCommittedWheelViewportRef.current = finalViewport;
            wheelFastRef.current = false;
            wheelRectRef.current = null;
            pressureMonitor.current?.stop();
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
        const previousScale = (pendingWheelViewportRef.current ?? viewportRef.current).k;
        const next = applyAnchoredWheelZoom(
            pendingWheelViewportRef.current ?? viewportRef.current,
            event.deltaY,
            event.clientX - rect.left,
            event.clientY - rect.top,
        );
        const direction: WheelZoomDirection = next.k > previousScale ? "in" : next.k < previousScale ? "out" : "none";
        if (direction !== "none" && zoomDirection.current !== direction) {
            zoomDirection.current = direction;
            onWheelZoomDirectionChange?.(direction);
        }
        if (!document.hidden) pressureMonitor.current?.input(direction, next.k);
        pendingWheelViewportRef.current = next;
        viewportRef.current = next;
        if (wheelFrameRef.current !== null) return;
        wheelFrameRef.current = requestAnimationFrame(() => {
            wheelFrameRef.current = null;
            const frameViewport = resolveWheelCommitViewport(pendingWheelViewportRef.current, viewportRef.current);
            pendingWheelViewportRef.current = null;
            viewportRef.current = frameViewport;
            applyWheelVisual(frameViewport);
            onViewportFrameChange?.(frameViewport);
            const committed = lastCommittedWheelViewportRef.current;
            const now = performance.now();
            if (shouldCommitFastViewport(frameViewport, committed, now - lastWheelCommitRef.current)) {
                lastWheelCommitRef.current = now;
                lastCommittedWheelViewportRef.current = frameViewport;
                onViewportChange(frameViewport);
            }
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
        if (wheelFastRef.current || pendingWheelViewportRef.current !== null) {
            if (wheelIdleTimerRef.current !== null) clearTimeout(wheelIdleTimerRef.current);
            wheelIdleTimerRef.current = null;
            if (wheelFrameRef.current !== null) cancelAnimationFrame(wheelFrameRef.current);
            wheelFrameRef.current = null;
            const finalViewport = resolveWheelCommitViewport(pendingWheelViewportRef.current, viewportRef.current);
            pendingWheelViewportRef.current = null;
            viewportRef.current = finalViewport;
            applyWheelVisual(finalViewport);
            onViewportFrameChange?.(finalViewport);
            onViewportChange(finalViewport);
            lastCommittedWheelViewportRef.current = finalViewport;
            wheelFastRef.current = false;
            wheelRectRef.current = null;
            pressureMonitor.current?.stop();
            onWheelActivityChange?.(false);
            setPreviewGenerationSuspended(false, "wheel");
        }
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
            lastCommittedPanViewportRef.current = viewportRef.current;
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
                onViewportFrameChange?.(next);
                if (fastPanRef.current) {
                    applyPanVisual(next);
                    const committed = lastCommittedPanViewportRef.current;
                    if (!shouldCommitFastPan(next, committed, time - lastPanCommitRef.current)) return;
                    lastPanCommitRef.current = time;
                    lastCommittedPanViewportRef.current = next;
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
    }, [onCanvasDeselect, onViewportChange, onViewportFrameChange, onPanActivityChange]);

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
            <CanvasGrid
                viewport={viewport}
                mode={backgroundMode}
                colors={gridConfigRef.current.colors}
                fallbackRef={gridRef}
                canvasRef={gridCanvasRef}
                rendererRef={gridRendererRef}
                sizeRef={gridViewportSizeRef}
                viewportRef={viewportRef}
                configRef={gridConfigRef}
            />
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

function CanvasGrid({
    viewport, mode, colors, fallbackRef, canvasRef, rendererRef, sizeRef, viewportRef, configRef,
}: {
    viewport: ViewportTransform;
    mode: CanvasBackgroundMode;
    colors: WebGLGridColors;
    fallbackRef: React.RefObject<HTMLDivElement | null>;
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    rendererRef: React.RefObject<WebGLGridRenderer | null>;
    sizeRef: React.RefObject<WebGLGridSize>;
    viewportRef: React.RefObject<ViewportTransform>;
    configRef: React.RefObject<{ mode: CanvasBackgroundMode; colors: WebGLGridColors }>;
}) {
    const [rendererMode, setRendererMode] = useState<"css" | "webgl">("css");
    const disposeRendererRef = useRef<(() => void) | null>(null);
    const webglUnavailableRef = useRef(false);

    useLayoutEffect(() => {
        if (mode === "blank") {
            disposeRendererRef.current?.();
            disposeRendererRef.current = null;
            webglUnavailableRef.current = false;
            setRendererMode("css");
            return;
        }
        if (rendererRef.current) {
            setRendererMode("webgl");
            return;
        }
        if (webglUnavailableRef.current) {
            setRendererMode("css");
            return;
        }
        const canvas = canvasRef.current;
        if (!canvas) return;
        const renderer = createWebGLGridRenderer(canvas);
        if (!renderer) {
            webglUnavailableRef.current = true;
            setRendererMode("css");
            return;
        }
        rendererRef.current = renderer;
        renderer.draw(viewport, mode, colors, sizeRef.current);
        const onContextLost = (event: Event) => {
            event.preventDefault();
            renderer.destroy();
            if (rendererRef.current === renderer) rendererRef.current = null;
            canvas.removeEventListener("webglcontextlost", onContextLost);
            disposeRendererRef.current = null;
            webglUnavailableRef.current = true;
            setRendererMode("css");
            const fallback = fallbackRef.current;
            const latestConfig = configRef.current;
            if (fallback && latestConfig.mode !== "blank") {
                updateCssGrid(fallback, viewportRef.current, latestConfig.mode, latestConfig.colors);
            }
        };
        canvas.addEventListener("webglcontextlost", onContextLost);
        disposeRendererRef.current = () => {
            canvas.removeEventListener("webglcontextlost", onContextLost);
            renderer.destroy();
            if (rendererRef.current === renderer) rendererRef.current = null;
        };
        setRendererMode("webgl");
    }, [mode]);

    useEffect(() => () => {
        disposeRendererRef.current?.();
        disposeRendererRef.current = null;
    }, []);

    if (mode === "blank") return null;
    return (
        <div className="pointer-events-none absolute inset-0" data-canvas-grid="" data-grid-renderer={rendererMode}>
            <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" style={{ display: rendererMode === "webgl" ? undefined : "none" }} />
            <div ref={fallbackRef} className="pointer-events-none absolute inset-0 opacity-40" style={{ display: rendererMode === "css" ? undefined : "none" }} />
        </div>
    );
}

function updateCssGrid(element: HTMLDivElement, viewport: ViewportTransform, mode: CanvasBackgroundMode, colors: WebGLGridColors) {
    if (mode === "blank") return;
    const gridSize = 48 * viewport.k;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    element.style.backgroundImage = mode === "dots"
        ? `radial-gradient(circle, ${colors.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)`
        : `linear-gradient(${colors.line} 1px, transparent 1px), linear-gradient(90deg, ${colors.line} 1px, transparent 1px)`;
    element.style.backgroundSize = `${gridSize}px ${gridSize}px`;
    element.style.backgroundPosition = gridPositionForViewport(viewport);
}
