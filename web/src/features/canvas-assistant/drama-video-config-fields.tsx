import { useState } from "react";
import { Button } from "antd";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasNodeData } from "@/types/canvas";
import type { DramaVideoInput } from "./drama-pipeline-media";
import { dramaNodeControl, dramaNodePrimary } from "./drama-node-style";

export function DramaVideoConfigFields({
    inputs, episodes, configs, missingCount, missingFor, hasUnconfirmedChanges, disabled, theme, onCreateAll, onAction,
}: {
    inputs: DramaVideoInput[];
    episodes: {id: string; title: string}[];
    configs?: ReadonlyMap<string, CanvasNodeData>;
    missingCount: number;
    missingFor: (input: DramaVideoInput) => string[];
    hasUnconfirmedChanges: boolean;
    disabled: boolean;
    theme: CanvasTheme;
    onCreateAll: () => void;
    onAction: (input: DramaVideoInput, existing?: CanvasNodeData) => void;
}) {
    const [episodeId, setEpisodeId] = useState("");
    const [shotId, setShotId] = useState("");
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
            {missing.length > 0 && <p className="break-words text-xs" style={muted}>缺少主图：{missing.join("、")}</p>}
            <div className="flex justify-end">
                <Button size="small" disabled={disabled} style={disabled ? control : dramaNodePrimary(theme)}
                    onClick={() => onAction(active, existing)}>{existing ? "打开配置" : "创建视频配置"}</Button>
            </div>
        </div>
        {hasUnconfirmedChanges && <p className="text-xs" style={muted}>当前使用最近一次确认的分镜。</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs" style={muted}>已配置 {inputs.length - missingCount} / {inputs.length}</span>
            <Button size="small" style={control} disabled={!missingCount || disabled} onClick={onCreateAll}>批量创建视频配置</Button>
        </div>
    </section>;
}
