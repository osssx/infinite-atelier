import { useEffect, useMemo, useRef } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getMinimapProjection, minimapNodeRect, minimapScreenToWorld, minimapWorldToScreen, MINIMAP_HEIGHT, MINIMAP_WIDTH } from "@/lib/canvas/canvas-minimap-geometry";
import { useThemeStore } from "@/stores/use-theme-store";
import { type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

/**
 * The minimap is a static bitmap plus one DOM outline. With the old per-node div approach,
 * every viewport update reconciled hundreds of elements and every node drag laid out all of
 * their rectangles again. Pan/zoom now only updates the viewport outline; node changes repaint
 * one 240x160 bitmap without creating or laying out any per-node DOM.
 */
export function Minimap({ nodes, viewport, viewportSize, onViewportChange }: { nodes: CanvasNodeData[]; viewport: ViewportTransform; viewportSize: { width: number; height: number }; onViewportChange: (viewport: ViewportTransform) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const containerRef = useRef<HTMLDivElement>(null);
    const bitmapRef = useRef<HTMLCanvasElement>(null);
    const activePointerRef = useRef<number | null>(null);
    const projection = useMemo(() => getMinimapProjection(nodes), [nodes]);

    // Repaint only when the graph or theme changes. Never redraw just because viewport x/y/k changed.
    useEffect(() => {
        const canvas = bitmapRef.current;
        if (!canvas) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        // Bound the raster allocation on very high DPR displays (max 480x320 physical pixels).
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pixelWidth = Math.round(MINIMAP_WIDTH * dpr);
        const pixelHeight = Math.round(MINIMAP_HEIGHT * dpr);
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
        context.globalAlpha = 0.8;

        const colors = new Map<string, string>();
        for (const node of nodes) {
            let color = colors.get(node.type);
            if (!color) {
                color = getNodeDefinition(node.type)?.minimapColor || theme.node.muted;
                colors.set(node.type, color);
            }
            const rect = minimapNodeRect(projection, node);
            context.fillStyle = color;
            context.fillRect(rect.x, rect.y, rect.width, rect.height);
        }
        context.globalAlpha = 1;
    }, [nodes, projection, theme.node.muted]);

    const viewportRect = useMemo(() => {
        const vx = -viewport.x / viewport.k;
        const vy = -viewport.y / viewport.k;
        const p1 = minimapWorldToScreen(projection, vx, vy);
        const p2 = minimapWorldToScreen(projection, vx + viewportSize.width / viewport.k, vy + viewportSize.height / viewport.k);
        return { x: p1.x, y: p1.y, w: Math.max(p2.x - p1.x, 4), h: Math.max(p2.y - p1.y, 4) };
    }, [projection, viewport.k, viewport.x, viewport.y, viewportSize.height, viewportSize.width]);

    const navigateToPointer = (event: React.PointerEvent) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const world = minimapScreenToWorld(projection, event.clientX - rect.left, event.clientY - rect.top);
        onViewportChange({
            x: viewportSize.width / 2 - world.x * viewport.k,
            y: viewportSize.height / 2 - world.y * viewport.k,
            k: viewport.k,
        });
    };

    const stopPointer = (event: React.PointerEvent) => {
        if (activePointerRef.current !== event.pointerId) return;
        activePointerRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    return (
        <div className="absolute bottom-24 left-6 z-50 overflow-hidden rounded-lg border shadow-2xl backdrop-blur-sm" style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT, background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
            <div
                ref={containerRef}
                className="relative h-full w-full cursor-crosshair"
                onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    activePointerRef.current = event.pointerId;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    navigateToPointer(event);
                }}
                onPointerMove={(event) => {
                    if (activePointerRef.current === event.pointerId) navigateToPointer(event);
                }}
                onPointerUp={stopPointer}
                onPointerCancel={stopPointer}
            >
                <canvas ref={bitmapRef} data-canvas-minimap-bitmap width={MINIMAP_WIDTH} height={MINIMAP_HEIGHT} className="pointer-events-none absolute inset-0" aria-hidden="true" />
                <div className="pointer-events-none absolute border" style={{ left: viewportRect.x, top: viewportRect.y, width: viewportRect.w, height: viewportRect.h, borderColor: theme.node.activeStroke, background: `${theme.node.activeStroke}18` }} />
            </div>
        </div>
    );
}
