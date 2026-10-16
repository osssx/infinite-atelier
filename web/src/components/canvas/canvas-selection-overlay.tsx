import { memo } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { SelectionBox } from "@/types/canvas";

/**
 * The marquee rectangle. Memoized on the box and the zoom so a marquee drag does not re-render the
 * node or edge layers; the stroke is counter-scaled so it stays one screen pixel wide.
 */
export const SelectionOverlay = memo(function SelectionOverlay({ selectionBox, scale }: { selectionBox: SelectionBox | null; scale: number }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!selectionBox) return null;

    return (
        <svg
            className="pointer-events-none absolute z-[100] overflow-visible"
            style={{
                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
            }}
        >
            <rect width="100%" height="100%" fill={theme.canvas.selectionFill} stroke={theme.canvas.selectionStroke} strokeOpacity={0.55} strokeWidth={1 / scale} strokeDasharray={`${6 / scale} ${4 / scale}`} />
        </svg>
    );
});
