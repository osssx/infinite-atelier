import { Group } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CanvasTheme } from "@/lib/canvas-theme";

export function CanvasGroupNodeContent({ title, theme, groupChildCount }: { title: string; theme: CanvasTheme; groupChildCount: number }) {
    const { t } = useTranslation();
    const label = title || t("canvas.node.group");

    return (
        <div className="pointer-events-none flex h-full w-full flex-col p-4">
            <div
                className="flex h-8 shrink-0 items-center gap-2.5 px-2"
                style={{ color: theme.node.text }}
            >
                <span className="grid size-6 shrink-0 place-items-center rounded-md" style={{ background: theme.toolbar.activeBg }}>
                    <Group aria-hidden="true" className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate text-base font-bold leading-tight" title={label}>
                    {label}
                </span>
                <span className="shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums" style={{ background: theme.node.fill, color: theme.node.label }}>
                    {t("canvas.node.nodeCount", { count: groupChildCount })}
                </span>
            </div>
            <div className="mt-3 flex-1 rounded-2xl border border-dashed" style={{ borderColor: theme.node.stroke, background: `${theme.node.fill}55` }} />
        </div>
    );
}
