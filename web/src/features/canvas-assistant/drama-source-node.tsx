import { useState, type CSSProperties } from "react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export function DramaSourceNode({node, onChange}: {
    node: CanvasNodeData;
    onChange: (patch: Partial<CanvasNodeMetadata>) => void;
}) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [error, setError] = useState("");
    const source = node.metadata?.dramaDraft ?? node.metadata?.content ?? node.metadata?.dramaConfirmed ?? "";
    const confirmed = Boolean(source.trim()) && source === node.metadata?.dramaConfirmed;
    const control: CSSProperties = {background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke};
    const changeSource = (text: string) => onChange({dramaDraft:text, content:text});
    return <section className="flex h-full min-h-0 w-full flex-col gap-2 overflow-y-auto overscroll-contain px-3 pb-3 pt-7 text-xs"
        style={{color:theme.node.text}} data-canvas-no-zoom
        onWheel={event => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
            <label className="font-medium" htmlFor={`drama-source-${node.id}`}>小说或剧本</label>
            <span role="status">{confirmed ? "已确认" : "草案"}</span>
        </div>
        <textarea id={`drama-source-${node.id}`} className="min-h-20 w-full flex-1 resize-none rounded-md border p-2 text-sm"
            style={control} placeholder="粘贴原文" value={source}
            onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
            onKeyDown={event => event.stopPropagation()} onChange={event => changeSource(event.target.value)} />
        <div className="grid grid-cols-[5.5rem_1fr] gap-2">
            <label className="grid gap-1">视频比例
                <select className="h-7 rounded-md border px-1" style={control} value={node.metadata?.videoRatio ?? ""}
                    onMouseDown={event => event.stopPropagation()} onChange={event => onChange({videoRatio:event.target.value || undefined})}>
                    <option value="">随模型</option>
                    {["16:9","9:16","1:1","4:3","3:4","21:9"].map(ratio => <option key={ratio}>{ratio}</option>)}
                </select>
            </label>
            <label className="grid min-w-0 gap-1">影片风格
                <input className="h-7 min-w-0 rounded-md border px-2" style={control} maxLength={500}
                    value={node.metadata?.dramaFilmStyle ?? ""} placeholder="如水彩动画、暖色自然光"
                    onMouseDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
                    onChange={event => onChange({dramaFilmStyle:event.target.value})} />
            </label>
        </div>
        <div className="flex items-center justify-between gap-2" onMouseDown={event => event.stopPropagation()}>
            <label className="cursor-pointer rounded-md border px-2 py-1" style={control}>
                导入 TXT / MD
                <input className="sr-only" type="file" accept=".txt,.md" onChange={async event => {
                    const input = event.currentTarget;
                    const file = input.files?.[0];
                    input.value = "";
                    if (!file) return;
                    try {
                        changeSource(await file.text());
                        setError("");
                    } catch { setError("无法读取文本文件"); }
                }} />
            </label>
            <button type="button" className="rounded-md border px-2 py-1 font-medium disabled:opacity-50" style={control}
                disabled={!source.trim() || confirmed} onClick={() => onChange({dramaConfirmed:source})}>确认原文</button>
        </div>
        {error && <p role="alert">{error}</p>}
    </section>;
}
