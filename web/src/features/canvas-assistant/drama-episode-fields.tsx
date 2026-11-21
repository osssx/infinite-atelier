import { useState, type CSSProperties } from "react";

export type DramaEpisode = {
    id: string;
    title: string;
    synopsis: string;
    events: string[];
    sourceRefs: string[];
    ending: string;
    targetDurationSec?: number;
    sequences?: {id:string;title:string}[];
};

export function DramaEpisodeFields({episodes, expanded, disabled, control, onChange}: {
    episodes: DramaEpisode[];
    expanded: boolean;
    disabled: boolean;
    control?: CSSProperties;
    onChange: (episodes: DramaEpisode[]) => void;
}) {
    const [selected, setSelected] = useState("");
    const active = episodes.find(episode => episode.id === selected) ?? episodes[0];
    const edit = (patch: Partial<DramaEpisode>) => onChange(episodes.map(episode =>
        episode === active ? {...episode, ...patch} : episode));
    const field = "w-full min-w-0 rounded-lg border px-3 py-2 leading-relaxed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]";
    if (!active) return <p className="rounded-xl border border-dashed px-3 py-4 leading-relaxed" style={control}>设置目标集数后，点击「生成草案」。</p>;
    return <fieldset disabled={disabled} className={expanded
        ? "grid min-w-0 grow shrink-0 grid-rows-[auto_minmax(min-content,1fr)] gap-4 md:grid-cols-[minmax(180px,0.8fr)_minmax(0,2fr)] md:grid-rows-none"
        : "grid min-w-0 gap-3"}>
        {expanded ? <div className="thin-scrollbar grid max-h-[52dvh] gap-1.5 self-start overflow-y-auto rounded-xl border p-3" style={control}>
            {episodes.map((episode,index) => <button type="button" key={episode.id} aria-pressed={episode === active}
                className={`rounded-lg px-3 py-2 text-left hover:opacity-75 ${episode === active ? "border border-current font-semibold" : ""}`}
                onClick={() => setSelected(episode.id)}>第 {index + 1} 集 · {episode.title || "未命名"}</button>)}
        </div> : <select aria-label="选择剧集" className={`${field} pr-7 font-medium`} style={control} value={active.id} onChange={event => setSelected(event.target.value)}>
            {episodes.map((episode,index) => <option key={episode.id} value={episode.id}>第 {index + 1} 集 · {episode.title || "未命名"}</option>)}
        </select>}
        <div className={`min-w-0 rounded-xl border ${expanded ? "flex flex-col gap-4 p-5" : "grid gap-3 p-3"}`} style={control}>
            <label className="grid gap-1.5 font-medium">集标题
                <input className={field} style={control} value={active.title} onChange={event => edit({title:event.target.value})} />
            </label>
            <label className={`gap-1.5 font-medium ${expanded ? "flex grow flex-col" : "grid"}`}>剧情梗概
                <textarea className={`thin-scrollbar ${field}${expanded ? " grow resize-none" : ""}`} style={control} rows={3} value={active.synopsis} onChange={event => edit({synopsis:event.target.value})} />
            </label>
            <label className={`gap-1.5 font-medium ${expanded ? "flex grow-[2] flex-col" : "grid"}`}>剧情事件（每行一条）
                <textarea className={`thin-scrollbar ${field}${expanded ? " grow resize-none" : ""}`} style={control} rows={expanded ? 6 : 4} value={active.events.join("\n")}
                    onChange={event => edit({events:event.target.value.split("\n")})} />
            </label>
            <label className="grid gap-1.5 font-medium">本集结尾
                <textarea className={`thin-scrollbar ${field}`} style={control} rows={2} value={active.ending} onChange={event => edit({ending:event.target.value})} />
            </label>
            <label className="grid gap-1.5 font-medium">目标时长（秒）
                <input className={field} style={control} type="number" min="0.1" step="0.1"
                    value={active.targetDurationSec ?? ""} onChange={event => {
                        const duration=event.target.valueAsNumber;
                        if (!event.target.value || duration>0) edit({targetDurationSec:duration>0?duration:undefined});
                    }} />
            </label>
            <div className="grid gap-2">
                {active.sequences?.map(sequence=><label key={sequence.id} className="grid gap-1.5">场次
                    <input className={field} style={control} value={sequence.title}
                        onChange={event=>edit({sequences:active.sequences?.map(item=>item.id===sequence.id
                            ? {...item,title:event.target.value}:item)})}/>
                </label>)}
                <button type="button" className={field} style={control} onClick={()=>edit({
                    sequences:[...(active.sequences??[]),{id:crypto.randomUUID(),title:"新场次"}],
                })}>添加场次</button>
            </div>
            {active.sourceRefs.length > 0 && <details className="min-w-0 border-t pt-2 text-xs" style={{borderColor:control?.borderColor}}>
                <summary className="cursor-pointer opacity-75">原文出处 · {active.sourceRefs.length} 处</summary>
                <textarea aria-label="剧集原文段落 ID" className={field} style={control} rows={2} value={active.sourceRefs.join("\n")}
                    onChange={event=>edit({sourceRefs:event.target.value.split("\n").map(item=>item.trim()).filter(Boolean)})}/>
                {active.sourceRefs.some(ref=>/^p\d+$/.test(ref))&&<p>含旧行号引用，请对照故事段落定位核对。</p>}
            </details>}
        </div>
    </fieldset>;
}
