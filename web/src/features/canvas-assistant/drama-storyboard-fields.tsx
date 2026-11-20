import { useState, type CSSProperties } from "react";
import type { DramaAsset, DramaShot } from "./canvas-drama-pipeline";

export function DramaStoryboardFields({shots, episodes, scenes, expanded, disabled, control, onChange}: {
    shots: DramaShot[];
    episodes: {id:string; title:string}[];
    scenes: DramaAsset[];
    expanded: boolean;
    disabled: boolean;
    control?: CSSProperties;
    onChange: (shots: DramaShot[]) => void;
}) {
    const [episodeId, setEpisodeId] = useState("");
    const [shotId, setShotId] = useState("");
    const groups = [...new Set(shots.map(shot => shot.episodeId))];
    const activeEpisode = groups.includes(episodeId) ? episodeId : groups[0];
    const episodeShots = shots.filter(shot => shot.episodeId === activeEpisode).sort((a,b) => a.order-b.order);
    const active = episodeShots.find(shot => shot.id === shotId) ?? episodeShots[0];
    if (!active) return <p className="rounded-xl border border-dashed px-3 py-4" style={control}>确认资产和剧集规划后，点击「生成草案」。</p>;

    const write = (updated: DramaShot) => onChange(shots.map(shot => shot.id === active.id ? updated : shot));
    const scene = scenes.find(item => item.id === active.sceneId);
    const field = "w-full min-w-0 rounded-lg border px-3 py-1.5 leading-relaxed";
    const shotName = (shot: DramaShot, index: number) => `镜头 ${index + 1} · ${shot.shotSize || shot.id}`;
    return <fieldset disabled={disabled} className="grid min-w-0 gap-3">
        <div className="grid grid-cols-2 gap-2">
            <label className="grid min-w-0 gap-1">剧集
                <select className={field} style={control} value={activeEpisode} onChange={event => setEpisodeId(event.target.value)}>
                    {groups.map(id => <option key={id} value={id}>{episodes.find(episode => episode.id === id)?.title || id}</option>)}
                </select>
            </label>
            <label className="grid min-w-0 gap-1">镜头
                <select className={field} style={control} value={active.id} onChange={event => setShotId(event.target.value)}>
                    {episodeShots.map((shot,index) => <option key={shot.id} value={shot.id}>{shotName(shot,index)}</option>)}
                </select>
            </label>
        </div>
        <div className={expanded ? "grid gap-3 md:grid-cols-2" : "grid gap-2"}>
            <label className="grid min-w-0 gap-1 md:col-span-2">画面描述
                <textarea className={field} style={control} rows={expanded ? 5 : 3} value={active.description}
                    onChange={event => write({...active,description:event.target.value})} />
            </label>
            {([{key:"shotSize",label:"景别"},{key:"camera",label:"机位 / 运镜"},
                {key:"action",label:"动作"},{key:"dialogue",label:"对白"}] as const).map(({key,label}) =>
                <label className="grid min-w-0 gap-1" key={key}>{label}
                    <textarea className={field} style={control} rows={key==="action"||key==="dialogue"?2:1} value={active[key]??""}
                        onChange={event => write({...active,[key]:event.target.value})} />
                </label>)}
            <label className="grid min-w-0 gap-1">场景
                <select className={field} style={control} value={active.sceneId??""} onChange={event => {
                    const next = {...active};
                    delete next.sceneVariantId;
                    if (event.target.value) next.sceneId = event.target.value;
                    else delete next.sceneId;
                    write(next);
                }}>
                    <option value="">未指定场景</option>
                    {active.sceneId && !scene && <option value={active.sceneId}>未确认：{active.sceneId}</option>}
                    {scenes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
            </label>
            {(scene?.variants?.length || active.sceneVariantId) && <label className="grid min-w-0 gap-1">场景变体
                <select className={field} style={control} value={active.sceneVariantId??""} onChange={event => {
                    const next = {...active};
                    if (event.target.value) next.sceneVariantId = event.target.value;
                    else delete next.sceneVariantId;
                    write(next);
                }}>
                    <option value="">默认场景</option>
                    {active.sceneVariantId && !scene?.variants?.some(item=>item.id===active.sceneVariantId) &&
                        <option value={active.sceneVariantId}>未确认：{active.sceneVariantId}</option>}
                    {scene?.variants?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
            </label>}
        </div>
    </fieldset>;
}
