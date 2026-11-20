import type { CanvasTheme } from "@/lib/canvas-theme";

export const dramaInlineNodeClass = "flex h-full min-h-0 w-full flex-col gap-3 px-3 pb-4 pt-7 text-xs";

export function dramaNodeControl(theme: CanvasTheme) {
    return {background:theme.node.panel, color:theme.node.text, borderColor:theme.node.stroke};
}

export function dramaNodePrimary(theme: CanvasTheme) {
    return {background:theme.node.activeStroke, color:theme.node.fill, borderColor:theme.node.activeStroke};
}

export function DramaNodeStatus({theme, confirmed}: {theme:CanvasTheme; confirmed:boolean}) {
    return <span role="status" className="rounded-full border px-2 py-1 text-xs" style={{
        borderColor:theme.node.stroke,
        background:confirmed ? theme.toolbar.activeBg : theme.node.panel,
        color:confirmed ? theme.toolbar.activeText : theme.node.muted,
    }}>{confirmed ? "已确认" : "草案"}</span>;
}
