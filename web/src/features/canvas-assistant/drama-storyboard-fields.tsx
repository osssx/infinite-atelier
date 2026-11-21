import { useState, type CSSProperties } from "react";
import type { DramaAsset, DramaShot } from "./canvas-drama-pipeline";

export function DramaStoryboardFields({shots, episodes, scenes, expanded, disabled, control, onChange}: {
    shots: DramaShot[];
    episodes: {id:string; title:string; targetDurationSec?:number; sequences?:{id:string;title:string}[]}[];
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
    const episode = episodes.find(item=>item.id===activeEpisode);
    const duration = episodeShots.reduce((sum,shot)=>sum+(shot.durationSec??0),0);
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
        {episode?.targetDurationSec && <p>已设置镜头时长合计 {duration} 秒，目标 {episode.targetDurationSec} 秒。</p>}
        <div className={expanded ? "grid gap-3 md:grid-cols-2" : "grid gap-2"}>
            <label className="grid gap-1">原文段落 ID（每行一个）
                <textarea className={field} style={control} rows={2} value={(active.sourceRefs??[]).join("\n")}
                    onChange={event=>write({...active,sourceRefs:event.target.value.split("\n").map(item=>item.trim()).filter(Boolean)})}/>
                {active.sourceRefs?.some(ref=>/^p\d+$/.test(ref))&&<span>含旧行号引用，请对照故事段落定位核对。</span>}
            </label>
            <label className="grid min-w-0 gap-1">镜头时长（秒）
                <input className={field} style={control} type="number" min="0.1" step="0.1"
                    value={active.durationSec??""} onChange={event=>{
                        const duration=event.target.valueAsNumber;
                        if(!event.target.value||duration>0)write({...active,durationSec:duration>0?duration:undefined});
                    }}/>
            </label>
            {(episode?.sequences?.length||active.sequenceId) && <label className="grid min-w-0 gap-1">所属场次
                <select className={field} style={control} value={active.sequenceId??""}
                    onChange={event=>write({...active,sequenceId:event.target.value||undefined})}>
                    <option value="">未指定场次</option>
                    {active.sequenceId&&!episode?.sequences?.some(item=>item.id===active.sequenceId)&&
                        <option value={active.sequenceId}>未确认：{active.sequenceId}</option>}
                    {episode?.sequences?.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}
                </select>
            </label>}
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
