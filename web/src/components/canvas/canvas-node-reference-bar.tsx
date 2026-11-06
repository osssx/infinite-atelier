import { Popover } from "antd";
import { FileText, Image as ImageIcon, Music2, Plus, Video, X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasNodeReferenceBar({ nodeId, references, onStartSelection, onDisconnect }: {
    nodeId: string; references: CanvasResourceReference[];
    onStartSelection?: (nodeId: string) => void;
    onDisconnect?: (sourceId: string, targetId: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
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
            {onStartSelection ? <button type="button" className="grid size-12 shrink-0 place-items-center rounded-xl border bg-transparent transition hover:opacity-70" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }} aria-label="从画布选取参考内容" title="从画布选取" onClick={() => onStartSelection(nodeId)}><Plus className="size-4" /></button> : null}
        </div>
    </div>;
}
