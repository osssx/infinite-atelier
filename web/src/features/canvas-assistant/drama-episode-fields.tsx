import { useState, type CSSProperties } from "react";
import {normalizeEpisodeEvents,unresolvedEventRefs} from "../../../server/drama-episode-links.mjs";
import {splitEpisodeSequence,mergeEpisodeSequences} from "../../../server/drama-sequence-relations.mjs";

export type DramaEpisode = {
    id: string;
    title: string;
    synopsis: string;
    events: string[];
    eventItems?: {id:string;text:string;replaces?:string[];status?:string}[];
    sourceRefs: string[];
    ending: string;
    targetDurationSec?: number;
    sequences?: {id:string;title:string;sourceRefs?:string[];eventRefs?:string[];replaces?:string[]}[];
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
                    onChange={event => {
                        const normalized=normalizeEpisodeEvents({...active,events:event.target.value.split("\n")},active);
                        edit({events:normalized.events,eventItems:normalized.eventItems,sequences:normalized.sequences});
                    }} />
                <button type="button" className="text-xs underline" onClick={()=>{
                    const normalized=normalizeEpisodeEvents(active,active);
                    edit({eventItems:normalized.eventItems,sequences:normalized.sequences});
                }}>补齐旧事件的稳定 ID</button>
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
                 {active.sequences?.map(sequence=><div key={sequence.id} className="grid gap-2 rounded-lg border p-2" style={control}>
                     <label className="grid gap-1.5">场次名称
                         <input className={field} style={control} value={sequence.title}
                             onChange={event=>edit({sequences:active.sequences?.map(item=>item.id===sequence.id
                                 ? {...item,title:event.target.value}:item)})}/>
                     </label>
                     <label className="grid gap-1.5">场次原文段落 ID（每行一个）
                         <textarea className={field} style={control} rows={2}
                             value={(sequence.sourceRefs??[]).join("\n")}
                             onChange={event=>edit({sequences:active.sequences?.map(item=>item.id===sequence.id
                                 ? {...item,sourceRefs:event.target.value.split("\n").map(ref=>ref.trim()).filter(Boolean)}:item)})}/>
                     </label>
                     <div className="grid gap-1.5">
                         <span>本场关联剧情事件（稳定 ID）</span>
                          {(active.eventItems??active.events.map(text=>({id:text,text}))).filter(entry=>entry.text.trim()).map((eventItem,index)=><label key={eventItem.id||index} className="flex items-start gap-2">
                              <input type="checkbox" checked={(sequence.eventRefs??[]).includes(eventItem.id)||(sequence.eventRefs??[]).includes(eventItem.text)} onChange={change=>edit({
                                  sequences:active.sequences?.map(seq=>seq.id===sequence.id?
                                      {...seq,eventRefs:change.target.checked?[...new Set([...(seq.eventRefs??[]),eventItem.id])]:
                                          (seq.eventRefs??[]).filter(ref=>ref!==eventItem.id&&ref!==eventItem.text)}:seq)
                              })}/><span className="break-words">{eventItem.text}</span>
                          </label>)}
                          {(sequence.eventRefs??[]).some(ref=>!active.events.includes(ref)&&!active.eventItems?.some(item=>item.id===ref))&&
                              <p>事件引用缺失或有歧义，请核对稳定 ID 后更新。</p>}
                          {(sequence.replaces?.length??0)>0&&<p className="text-xs">替代旧场次：{sequence.replaces?.join("、")}。请审核旧镜头的场次迁移。</p>}
                          <div className="flex flex-wrap gap-2">
                              <button type="button" className="rounded border px-2 py-1 text-xs" onClick={()=>edit({
                                  sequences:splitEpisodeSequence(active,sequence.id).sequences,
                              })}>拆成两场</button>
                              {(active.sequences?.findIndex(item=>item.id===sequence.id)??0)>0&&
                                  <button type="button" className="rounded border px-2 py-1 text-xs" onClick={()=>{
                                      const index=active.sequences?.findIndex(item=>item.id===sequence.id)??0;
                                      edit({sequences:mergeEpisodeSequences(active,active.sequences![index-1].id,sequence.id).sequences});
                                  }}>并入上一场</button>}
                          </div>
                      </div>
                  </div>)}                <button type="button" className={field} style={control} onClick={()=>edit({
                    sequences:[...(active.sequences??[]),{id:crypto.randomUUID(),title:"新场次"}],
                })}>添加场次</button>
            </div>
            <details className="min-w-0 border-t pt-2 text-xs" style={{borderColor:control?.borderColor}}>
                <summary className="cursor-pointer opacity-75">原文出处 · {active.sourceRefs.length} 处</summary>
                <textarea aria-label="剧集原文段落 ID" className={field} style={control} rows={2} value={active.sourceRefs.join("\n")}
                    onChange={event=>edit({sourceRefs:event.target.value.split("\n").map(item=>item.trim()).filter(Boolean)})}/>
                {active.sourceRefs.some(ref=>/^p\d+$/.test(ref))&&<p>含旧行号引用，请对照故事段落定位核对。</p>}
            </details>
        </div>
    </fieldset>;
}
