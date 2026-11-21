import { useState } from "react";
import { Button } from "antd";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasNodeData } from "@/types/canvas";
import type { DramaVideoInput } from "./drama-pipeline-media";
import { dramaNodeControl, dramaNodePrimary } from "./drama-node-style";

export function DramaVideoConfigFields({
    inputs, episodes, configs, missingCount, missingFor, hasUnconfirmedChanges, disabled, theme, onCreateSelected, onAction,
}: {
    inputs: DramaVideoInput[];
    episodes: {id: string; title: string}[];
    configs?: ReadonlyMap<string, CanvasNodeData>;
    missingCount: number;
    missingFor: (input: DramaVideoInput) => string[];
    hasUnconfirmedChanges: boolean;
    disabled: boolean;
    theme: CanvasTheme;
    onCreateSelected: (inputs:DramaVideoInput[]) => void;
    onAction: (input: DramaVideoInput, existing?: CanvasNodeData) => void;
}) {
    const [episodeId, setEpisodeId] = useState("");
    const [shotId, setShotId] = useState("");
    const [selected, setSelected] = useState<string[]>([]);
    const episodeIds = [...new Set(inputs.map(({shot}) => shot.episodeId))];
    const activeEpisode = episodeIds.includes(episodeId) ? episodeId : episodeIds[0];
    const episodeInputs = inputs.filter(({shot}) => shot.episodeId === activeEpisode)
        .sort((a, b) => a.shot.order - b.shot.order);
    const active = episodeInputs.find(({shot}) => shot.id === shotId) ?? episodeInputs[0];
    const control = dramaNodeControl(theme);
    const muted = {color:theme.node.muted};
    if (!active) return <p className="rounded-xl border border-dashed px-3 py-4" style={control}>
        确认分镜后可创建视频配置。
    </p>;

    const existing = configs?.get(active.shot.id);
    const selectedInputs = inputs.filter(input=>selected.includes(input.shot.id)&&!configs?.has(input.shot.id));
    const source = existing?.metadata?.dramaVideoSource;
    const referenceKeys = active.referenceImages.flatMap(reference=>reference.storageKey?[reference.storageKey]:[]);
    const outdated = source && (source.shot!==JSON.stringify(active.shot)||
        JSON.stringify(source.referenceKeys)!==JSON.stringify(referenceKeys));
    const missing = missingFor(active);
    const field = "w-full min-w-0 rounded-lg border px-3 py-1.5 leading-relaxed";
    return <section aria-label="镜头视频配置" className="grid min-w-0 gap-3">
        <div className="grid grid-cols-2 gap-2">
            <label className="grid min-w-0 gap-1">剧集
                <select className={field} style={control} value={activeEpisode} onChange={event => setEpisodeId(event.target.value)}>
                    {episodeIds.map(id => <option key={id} value={id}>{episodes.find(episode => episode.id === id)?.title || id}</option>)}
                </select>
            </label>
            <label className="grid min-w-0 gap-1">镜头
                <select className={field} style={control} value={active.shot.id} onChange={event => setShotId(event.target.value)}>
                    {episodeInputs.map(({shot}, index) => <option key={shot.id} value={shot.id}>
                        镜头 {index + 1} · {shot.shotSize || shot.id}
                    </option>)}
                </select>
            </label>
        </div>
        <div className="grid min-w-0 gap-2 rounded-xl border p-3" style={control}>
            <span className="font-medium">画面描述</span>
            <p className="line-clamp-3 break-words whitespace-pre-wrap">{active.shot.description}</p>
            {existing && !source && <p style={muted}>旧配置来源待核对。</p>}
            {outdated && <p role="status">分镜或参考图已有更新，现有配置仍保留原设置。</p>}
            <details>
                <summary>查看镜头提示词与参考图</summary>
                <pre className="whitespace-pre-wrap break-words">{active.prompt}</pre>
                {active.referenceImages.map(reference=><span key={reference.id} className="mr-2">{reference.name}</span>)}
                {outdated && <details><summary>配置创建时的提示词</summary>
                    <pre className="whitespace-pre-wrap break-words">{source.prompt}</pre>
                </details>}
            </details>
            {missing.length > 0 && <p className="break-words text-xs" style={muted}>缺少主图：{missing.join("、")}</p>}
            <div className="flex justify-end">
                <Button size="small" disabled={disabled} style={disabled ? control : dramaNodePrimary(theme)}
                    onClick={() => onAction(active, existing)}>{existing ? "打开配置" : "创建视频配置"}</Button>
            </div>
        </div>
        {hasUnconfirmedChanges && <p className="text-xs" style={muted}>当前使用最近一次确认的分镜。</p>}
        <details>
            <summary>选择批量配置的镜头</summary>
            <div className="grid gap-1">
                {episodeInputs.filter(input=>!configs?.has(input.shot.id)).map(input=>
                    <label key={input.shot.id}>
                        <input type="checkbox" checked={selected.includes(input.shot.id)} onChange={event=>{
                            const checked=event.target.checked;
                            setSelected(current=>checked?[...current,input.shot.id]:current.filter(id=>id!==input.shot.id));
                        }}/> 镜头 {input.shot.order} · {input.shot.description}
                    </label>)}
            </div>
        </details>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs" style={muted}>已配置 {inputs.length - missingCount} / {inputs.length}</span>
            <Button size="small" style={control} disabled={!selectedInputs.length || disabled} onClick={()=>{
                onCreateSelected(selectedInputs);
                setSelected([]);
            }}>创建所选视频配置（{selectedInputs.length}）</Button>
        </div>
    </section>;
}
