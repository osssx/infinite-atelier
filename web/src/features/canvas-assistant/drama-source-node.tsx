import { useState } from "react";
import { Button } from "antd";
import { Upload, Maximize2 } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { dramaInlineNodeClass, dramaNodeControl, dramaNodePrimary, DramaNodeStatus } from "./drama-node-style";

export function DramaSourceNode({node, onChange, onConfirmVersion, versionBusy,onOpenEditor,hideTextEditor=false}: {
    node: CanvasNodeData;
    onConfirmVersion: (draft: string) => Promise<void>;
    versionBusy: boolean;
    onOpenEditor?:()=>void;
    hideTextEditor?:boolean;
    onChange: (patch: Partial<CanvasNodeMetadata>) => void;
}) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [error, setError] = useState("");
    const source = node.metadata?.dramaDraft ?? node.metadata?.content ?? node.metadata?.dramaConfirmed ?? "";
    const publishedVisual=node.metadata?.dramaConfirmedVisual;
    const visualConfirmed=!publishedVisual||(publishedVisual.visualStyle===(node.metadata?.dramaFilmStyle??"")&&
        (["palette","lighting","characterDesign","anchors"] as const).every(key=>
            (publishedVisual.artDirection[key]??"")===(node.metadata?.dramaArtDirection?.[key]??"")));
    const confirmed = Boolean(source.trim()) && source === node.metadata?.dramaConfirmed&&visualConfirmed;
    const control = dramaNodeControl(theme);
    const changeSource = (text: string) => onChange({dramaDraft:text, content:text});
    return <section className={dramaInlineNodeClass}
        style={{color:theme.node.text}} data-canvas-no-zoom
        onWheel={event => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
            <strong className="text-sm font-semibold">小说或剧本</strong>
            <div className="flex items-center gap-2">
                <DramaNodeStatus theme={theme} confirmed={confirmed} />
                {onOpenEditor&&<Button size="small" icon={<Maximize2 size={14}/>} style={control}
                    onClick={onOpenEditor} onMouseDown={event=>event.stopPropagation()}>完整编辑</Button>}
            </div>
        </div>
        <div className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain"
            onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
        {onOpenEditor?<button type="button" data-story-inline-summary=""
            className="min-h-20 w-full shrink-0 rounded-xl border px-3 py-3 text-left text-xs leading-relaxed"
            style={{...control,background:theme.toolbar.activeBg}}
            onClick={onOpenEditor}>
            <span className="mb-1 block font-medium" style={{color:theme.node.muted}}>
                {source.length} 字符 · 点击打开完整编辑器
            </span>
            <span className="line-clamp-4 whitespace-pre-wrap break-words">{source.trim().slice(0,360)||"尚无故事正文，点击开始创作"}</span>
        </button>:hideTextEditor?null:<textarea id={`drama-source-${node.id}`}
            className="thin-scrollbar min-h-20 w-full flex-1 resize-none rounded-xl border px-3 py-2 text-sm leading-relaxed"
            style={control} placeholder="粘贴原文" value={source}
            onPointerDown={event=>event.stopPropagation()} onMouseDown={event=>event.stopPropagation()}
            onKeyDown={event=>event.stopPropagation()} onChange={event=>changeSource(event.target.value)}/>}
        <div className="grid grid-cols-[5.5rem_1fr] gap-2 rounded-xl border p-3" style={control}>
            <label className="grid gap-1.5 font-medium">视频比例
                <select className="h-8 rounded-lg border px-2" style={control} value={node.metadata?.videoRatio ?? ""}
                    onMouseDown={event => event.stopPropagation()} onChange={event => onChange({videoRatio:event.target.value || undefined})}>
                    <option value="">随模型</option>
                    {["16:9","9:16","1:1","4:3","3:4","21:9"].map(ratio => <option key={ratio}>{ratio}</option>)}
                </select>
            </label>
            <label className="grid min-w-0 gap-1.5 font-medium">影片风格
                <input className="h-8 min-w-0 rounded-lg border px-2 font-normal" style={control} maxLength={500}
                    value={node.metadata?.dramaFilmStyle ?? ""} placeholder="如水彩动画、暖色自然光"
                    onMouseDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
                    onChange={event => onChange({dramaFilmStyle:event.target.value})} />
            </label>
        </div>
        <details className="rounded-xl border p-3" style={control}>
            <summary>作品美术指导</summary>
            {([{key:"palette",label:"色彩方案"},{key:"lighting",label:"光影"},
                {key:"characterDesign",label:"角色设计规则"},{key:"anchors",label:"一致性锚点"}] as const).map(({key,label})=>
                <label key={key} className="mt-2 grid gap-1 text-sm">{label}
                    <textarea className="w-full rounded-lg border p-2" style={control} rows={2} maxLength={2000}
                        value={node.metadata?.dramaArtDirection?.[key]??""}
                        onChange={event=>onChange({dramaArtDirection:{palette:"",lighting:"",characterDesign:"",anchors:"",
                            ...node.metadata?.dramaArtDirection,[key]:event.target.value}})}/>
                </label>)}
        </details>
        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            {!!node.metadata?.dramaSourceParagraphs?.length && <details className="w-full">
                <summary>已确认原文定位 · {node.metadata.dramaSourceParagraphs.length} 段</summary>
                {node.metadata.dramaSourceParagraphs.map(paragraph=><p key={paragraph.id} className="break-words text-xs">
                    {paragraph.id} · {paragraph.status==="needs_review"?"待校对":"已定位"} · {paragraph.text}
                    {!!paragraph.replaces?.length&&<span> · 原段落 {paragraph.replaces.join("、")}</span>}
                </p>)}
            </details>}
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1" style={control}>
                <Upload aria-hidden className="size-3.5" />
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
            <button type="button" className="rounded-md border px-2 py-1 font-medium disabled:opacity-50" style={source.trim() && !confirmed ? dramaNodePrimary(theme) : control}
                disabled={versionBusy || !source.trim()} onClick={() => {
                    setError("");
                    void onConfirmVersion(source).catch(error => setError(error.message));
                }}>{confirmed ? "确认原文与美术设定" : "确认原文"}</button>
        </div>
        {error && <p role="alert">{error}</p>}
        </div>
    </section>;
}
