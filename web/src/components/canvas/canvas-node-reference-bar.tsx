import { useState } from "react";
import { Popover } from "antd";
import { FileText, Image as ImageIcon, Music2, Plus, Video, X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { isResourceNode, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

export function CanvasNodeReferenceBar({ nodeId, references, nodes, onConnect, onDisconnect }: {
    nodeId: string; references: CanvasResourceReference[]; nodes: readonly CanvasNodeData[];
    onConnect?: (sourceId: string, targetId: string) => void;
    onDisconnect?: (sourceId: string, targetId: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [open, setOpen] = useState(false);
    const candidates = nodes.filter((node) => node.id !== nodeId && isResourceNode(node) && !references.some((ref) => ref.nodeId === node.id));
    return <div className="mb-2">
        <div className="mb-1.5 text-[11px] font-medium" style={{ color: theme.node.muted }}>参考内容</div>
        <div className="thin-scrollbar flex min-h-12 gap-2 overflow-x-auto pb-1">
            {references.map((ref) => {
                const Icon = ref.kind === "video" ? Video : ref.kind === "audio" ? Music2 : ref.kind === "text" ? FileText : ImageIcon;
                return <Popover key={ref.id} placement="topLeft" content={ref.kind === "image" && ref.previewUrl ? <img src={ref.previewUrl} alt={ref.title} className="max-h-52 w-72 rounded-lg object-contain" /> : <div className="max-h-52 w-72 overflow-auto whitespace-pre-wrap text-sm">{ref.text || ref.title}</div>}>
                    <div className="group relative grid size-12 shrink-0 place-items-center rounded-xl border" style={{ borderColor: theme.toolbar.border }} title={ref.title}>
                        <span className="grid size-full place-items-center overflow-hidden rounded-[inherit]">{ref.kind === "image" && ref.previewUrl ? <img src={ref.previewUrl} alt={ref.title} className="size-full object-cover" /> : <Icon className="size-4 opacity-65" />}</span>
                        {onDisconnect && ref.nodeId !== nodeId ? <button type="button" className="absolute right-0 top-0 grid size-5 place-items-center rounded-full border opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-label="移除参考" onClick={() => onDisconnect(ref.nodeId, nodeId)}><X className="size-3" /></button> : null}
                    </div>
                </Popover>;
            })}
            {onConnect ? <Popover trigger="click" placement="topLeft" open={open} onOpenChange={setOpen} content={<div className="thin-scrollbar max-h-60 w-64 overflow-y-auto">{candidates.length ? candidates.map((node) => <button key={node.id} type="button" className="block w-full truncate rounded-lg px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10" onClick={() => { onConnect(node.id, nodeId); setOpen(false); }}>{node.title || node.id}</button>) : <div className="p-3 text-sm opacity-60">暂无可添加的参考节点</div>}</div>}>
                <button type="button" className="grid size-12 shrink-0 place-items-center rounded-xl border bg-transparent transition hover:opacity-70" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }} aria-label="添加参考内容"><Plus className="size-4" /></button>
            </Popover> : null}
        </div>
    </div>;
}
