import {useRef,useState,type CSSProperties} from "react";
import {GitBranch,Layers3,Plus,Split,Merge,BookText,Trash2,AlertTriangle} from "lucide-react";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import {normalizeEpisodeEvents} from "../../../server/drama-episode-links.mjs";
import {splitEpisodeSequence,mergeEpisodeSequences} from "../../../server/drama-sequence-relations.mjs";

export type DramaEpisode={
 id:string;title:string;synopsis:string;events:string[];
 eventItems?:{id:string;text:string;replaces?:string[];status?:string}[];
 sourceRefs:string[];ending:string;targetDurationSec?:number;
 sequences?:{id:string;title:string;sourceRefs?:string[];eventRefs?:string[];replaces?:string[]}[];
};

export function DramaEpisodeFields({episodes,expanded,disabled,control,onChange,initialEpisodeId}:{
 episodes:DramaEpisode[];expanded:boolean;disabled:boolean;control?:CSSProperties;
 onChange:(episodes:DramaEpisode[])=>void;initialEpisodeId?:string;
}){
 const appearance=useThemeStore(state=>state.theme);
 const theme=canvasThemes[appearance];
 const [selected,setSelected]=useState(initialEpisodeId??"");
 const [recentlyAdded,setRecentlyAdded]=useState("");
 const openedAddedRef=useRef("");
 const [pendingDelete,setPendingDelete]=useState<{episodeId:string;sequenceId:string}|null>(null);
 const active=episodes.find(episode=>episode.id===selected)??episodes[0];
 const activeIndex=active?episodes.findIndex(episode=>episode.id===active.id):-1;
 const edit=(patch:Partial<DramaEpisode>)=>onChange(episodes.map(episode=>
  episode===active?{...episode,...patch}:episode));
 const field="w-full min-w-0 rounded-lg border px-3 py-2 text-sm leading-relaxed outline-none transition-colors focus-visible:ring-2 disabled:opacity-55";
 const fieldStyle={background:theme.node.fill,color:theme.node.text,borderColor:theme.node.stroke,
  "--tw-ring-color":theme.node.activeStroke} as CSSProperties;
 const cardStyle={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
 const captionStyle={color:theme.node.muted};
 const smallAction="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-opacity hover:opacity-75 focus-visible:outline focus-visible:outline-2 disabled:opacity-40";
 if(!active)return <p className="rounded-xl border border-dashed px-4 py-5 text-sm leading-relaxed" style={cardStyle}>
  还没有剧集内容。设置目标集数后，点击「生成剧集候选」开始规划。
 </p>;
 return <fieldset disabled={disabled} data-episode-editor-layout={expanded?"expanded":"compact"}
  className={expanded
   ?"grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(116px,0.28fr)_minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(220px,0.33fr)_minmax(0,1fr)] lg:grid-rows-1"
   :"grid min-w-0 gap-3"}
  style={{color:theme.node.text,colorScheme:appearance}}>
  {expanded?<aside aria-label="剧集导航" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border"
   style={cardStyle}>
   <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-3"
    style={{borderColor:theme.node.stroke}}>
    <div className="flex min-w-0 items-center gap-2">
     <BookText size={16} aria-hidden="true" style={captionStyle}/>
     <strong className="text-sm">剧集目录</strong>
    </div>
    <span className="rounded-md px-2 py-1 text-[11px] font-medium tabular-nums"
     style={{background:theme.toolbar.activeBg,color:theme.node.muted}}>{episodes.length} 集</span>
   </div>
   <div className="thin-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto p-2" data-canvas-no-zoom>
    {episodes.map((episode,index)=>{
     const current=episode.id===active.id;
     return <button type="button" key={episode.id} aria-pressed={current}
      aria-label={`选择第 ${index+1} 集：${episode.title||"未命名"}`}
      className="flex w-full min-w-0 items-start gap-2.5 rounded-lg border px-3 py-3 text-left transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={current?{background:theme.toolbar.activeBg,color:theme.node.text,
       borderColor:theme.node.stroke,outlineColor:theme.node.activeStroke}:
       {background:"transparent",color:theme.node.text,borderColor:"transparent",outlineColor:theme.node.activeStroke}}
      onClick={()=>{setPendingDelete(null);setRecentlyAdded("");setSelected(episode.id);}}>
      <span className="mt-0.5 shrink-0 text-[11px] font-semibold tabular-nums" style={captionStyle}>
       {String(index+1).padStart(2,"0")}
      </span>
      <span className="min-w-0 flex-1">
       <span className="block truncate text-xs font-semibold">{episode.title||"未命名剧集"}</span>
       <span className="mt-1 block truncate text-[11px]" style={captionStyle}>
        {episode.synopsis?.trim()||`${episode.events.length} 条剧情事件`}
       </span>
      </span>
      {current&&<span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full"
       style={{background:theme.node.activeStroke}}/>}
     </button>;
    })}
   </div>
  </aside>:<select aria-label="选择剧集" className={field+" pr-7 font-medium"} style={fieldStyle}
   value={active.id} onChange={event=>{setPendingDelete(null);setRecentlyAdded("");setSelected(event.target.value);}}>
   {episodes.map((episode,index)=><option key={episode.id} value={episode.id}>
    第 {index+1} 集 · {episode.title||"未命名"}
   </option>)}
  </select>}
  <div aria-label="当前剧集编辑区"
   className={expanded?"thin-scrollbar min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain rounded-xl border p-3 sm:p-5":
    "grid min-w-0 gap-3 rounded-xl border p-3"} style={cardStyle} data-canvas-no-zoom>
   {expanded&&<header className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b pb-3"
    style={{borderColor:theme.node.stroke}}>
    <div className="min-w-0">
     <p className="text-[11px] font-medium" style={captionStyle}>第 {activeIndex+1} 集 · 剧集编辑</p>
     <h3 className="mt-1 truncate text-base font-semibold">{active.title||"未命名剧集"}</h3>
    </div>
    <span className="rounded-lg border px-2 py-1 text-[11px] tabular-nums"
     style={cardStyle}>{active.events.length} 条事件 · {active.sequences?.length??0} 场</span>
   </header>}
   <div className={expanded?"grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_160px]":"grid gap-3"}>
    <label className="grid min-w-0 gap-1.5 text-xs font-medium">
     <span style={captionStyle}>集标题</span>
     <input aria-label="集标题" className={field} style={fieldStyle} maxLength={12000}
      value={active.title} onChange={event=>edit({title:event.target.value})}/>
    </label>
    <label className="grid min-w-0 gap-1.5 text-xs font-medium">
     <span style={captionStyle}>目标时长（秒）</span>
     <input aria-label="目标时长（秒）" className={field} style={fieldStyle}
      type="number" min="0.1" step="0.1" value={active.targetDurationSec??""}
      onChange={event=>{
       const duration=event.target.valueAsNumber;
       if(!event.target.value||duration>0)edit({targetDurationSec:duration>0?duration:undefined});
      }}/>
    </label>
   </div>
   <section className={expanded?"grid gap-3":"grid gap-3"} aria-label="剧情内容">
    <label className="grid min-w-0 gap-1.5 text-xs font-medium">
     <span className="flex items-center justify-between gap-2" style={captionStyle}>
      剧情梗概 <span className="text-[11px] font-normal tabular-nums">{active.synopsis.length} 字</span>
     </span>
     <textarea aria-label="剧情梗概" className={field+" thin-scrollbar resize-y"} style={fieldStyle}
      rows={expanded?4:3} value={active.synopsis}
      onChange={event=>edit({synopsis:event.target.value})}/>
    </label>
    <label className="grid min-w-0 gap-1.5 text-xs font-medium">
     <span className="flex items-center justify-between gap-2" style={captionStyle}>
      剧情事件（每行一条）
      <span className="text-[11px] font-normal tabular-nums">{active.events.length} 条</span>
     </span>
     <textarea aria-label="剧情事件" className={field+" thin-scrollbar resize-y"} style={fieldStyle}
      rows={expanded?6:4} value={active.events.join("\n")}
      onChange={event=>{
       const normalized=normalizeEpisodeEvents({...active,events:event.target.value.split("\n")},active);
       edit({events:normalized.events,eventItems:normalized.eventItems,sequences:normalized.sequences});
      }}/>
    </label>
    <div className="flex justify-end">
     <button type="button" className={smallAction} style={cardStyle} onClick={()=>{
      const normalized=normalizeEpisodeEvents(active,active);
      edit({eventItems:normalized.eventItems,sequences:normalized.sequences});
     }}>补齐旧事件的稳定 ID</button>
    </div>
    <label className="grid min-w-0 gap-1.5 text-xs font-medium">
     <span style={captionStyle}>本集结尾</span>
     <textarea aria-label="本集结尾" className={field+" thin-scrollbar resize-y"} style={fieldStyle}
      rows={2} value={active.ending} onChange={event=>edit({ending:event.target.value})}/>
    </label>
   </section>
   <section aria-label="场次规划" className="min-w-0 space-y-2 border-t pt-4" style={{borderColor:theme.node.stroke}}>
    <div className="flex flex-wrap items-center justify-between gap-2">
     <div className="flex items-center gap-2">
      <Layers3 size={16} style={captionStyle} aria-hidden="true"/>
      <h4 className="text-sm font-semibold">场次规划</h4>
      <span className="text-[11px] tabular-nums" style={captionStyle}>{active.sequences?.length??0} 场</span>
     </div>
     <button type="button" className={smallAction} style={cardStyle}
      onClick={()=>{
        const sequences=active.sequences??[];
        const used=new Set(sequences.map(item=>item.title));
        let next=sequences.length+1;
        while(used.has(`新场次 ${next}`))next++;
        const id=`sequence_${crypto.randomUUID()}`;
        setPendingDelete(null);setRecentlyAdded(id);
        edit({sequences:[...sequences,{id,title:`新场次 ${next}`,sourceRefs:[],eventRefs:[]}]});
       }}>
      <Plus size={13} aria-hidden="true"/>添加场次
     </button>
    </div>
    <p className="text-[11px] leading-relaxed" style={captionStyle}>新增场次会自动展开；展开已有场次可编辑名称、来源与事件关联，或拆分、合并和删除。</p>
    {active.sequences?.map((sequence,index)=><details key={sequence.id}
     ref={element=>{
      if(element&&recentlyAdded===sequence.id&&openedAddedRef.current!==sequence.id){
       element.open=true;openedAddedRef.current=sequence.id;
      }
     }}
     className="min-w-0 rounded-lg border" style={cardStyle}>
     <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-3">
      <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
       <GitBranch size={14} className="shrink-0" style={captionStyle} aria-hidden="true"/>
       <span className="truncate">场次 {index+1} · {sequence.title||"未命名"}</span>
      </span>
      <span className="shrink-0 text-[11px]" style={captionStyle}>
       {sequence.eventRefs?.length??0} 条事件 · 点击展开
      </span>
     </summary>
     <div className="grid min-w-0 gap-3 border-t p-3 text-xs" style={{borderColor:theme.node.stroke}}>
      <label className="grid min-w-0 gap-1.5">
       <span style={captionStyle}>场次名称</span>
       <input className={field} style={fieldStyle} aria-label={`场次 ${index+1} 名称`}
        value={sequence.title} onChange={event=>edit({sequences:active.sequences?.map(item=>
         item.id===sequence.id?{...item,title:event.target.value}:item)})}/>
      </label>
      <label className="grid min-w-0 gap-1.5">
       <span style={captionStyle}>场次原文段落 ID（每行一个）</span>
       <textarea className={field+" thin-scrollbar resize-y"} style={fieldStyle} rows={2}
        value={(sequence.sourceRefs??[]).join("\n")}
        onChange={event=>edit({sequences:active.sequences?.map(item=>item.id===sequence.id?
         {...item,sourceRefs:event.target.value.split("\n").map(ref=>ref.trim()).filter(Boolean)}:item)})}/>
      </label>
      <div className="grid gap-2">
       <span style={captionStyle}>本场关联剧情事件（稳定 ID）</span>
       {(active.eventItems??active.events.map(text=>({id:text,text}))).filter(item=>item.text.trim()).map((eventItem,eventIndex)=>
        <label key={eventItem.id||eventIndex} className="flex items-start gap-2">
         <input type="checkbox" className="mt-0.5" checked={(sequence.eventRefs??[]).includes(eventItem.id)||(sequence.eventRefs??[]).includes(eventItem.text)}
          onChange={change=>edit({sequences:active.sequences?.map(seq=>seq.id===sequence.id?
           {...seq,eventRefs:change.target.checked?[...new Set([...(seq.eventRefs??[]),eventItem.id])]:
            (seq.eventRefs??[]).filter(ref=>ref!==eventItem.id&&ref!==eventItem.text)}:seq)})}/>
         <span className="break-words">{eventItem.text}</span>
        </label>)}
       {(sequence.eventRefs??[]).some(ref=>!active.events.includes(ref)&&!active.eventItems?.some(item=>item.id===ref))&&
        <p role="alert" className="text-[11px]">事件引用缺失或有歧义，请核对稳定 ID 后更新。</p>}
       {(sequence.replaces?.length??0)>0&&<p className="text-[11px]">替代旧场次：{sequence.replaces?.join("、")}。请审核旧镜头的场次迁移。</p>}
       <div className="flex flex-wrap gap-2 border-t pt-3" style={{borderColor:theme.node.stroke}}>
        <button type="button" className={smallAction} style={cardStyle}
         onClick={()=>edit({sequences:splitEpisodeSequence(active,sequence.id).sequences})}>
         <Split size={12} aria-hidden="true"/>拆成两场
        </button>
        {index>0&&<button type="button" className={smallAction} style={cardStyle} onClick={()=>
         edit({sequences:mergeEpisodeSequences(active,active.sequences![index-1].id,sequence.id).sequences})}>
         <Merge size={12} aria-hidden="true"/>并入上一场
        </button>}
         <button type="button" aria-label={`删除场次 ${index+1}：${sequence.title||"未命名"}`}
          className={smallAction+" ml-auto"} style={cardStyle}
          onClick={()=>setPendingDelete({episodeId:active.id,sequenceId:sequence.id})}>
          <Trash2 size={12} aria-hidden="true"/>删除场次
         </button>
        </div>
        {pendingDelete?.episodeId===active.id&&pendingDelete.sequenceId===sequence.id&&
         <div role="alertdialog" aria-label={`确认删除场次 ${index+1}`}
          className="space-y-2 rounded-lg border p-3" style={{...cardStyle,background:theme.toolbar.activeBg}}>
          <div className="flex items-start gap-2">
           <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" style={captionStyle}/>
           <div className="min-w-0 space-y-1 text-xs">
            <p className="font-semibold">确定删除“{sequence.title||`场次 ${index+1}`}”？</p>
            <p className="leading-relaxed" style={captionStyle}>
             将仅从当前剧集草案中移除此场次{(sequence.eventRefs?.length??0)>0?`（包含 ${sequence.eventRefs?.length} 项事件关联）`:""}。
             剧情事件及其他场次不会删除；已有分镜与视频配置也不会被自动修改。
             如有镜头引用该场次，需在确认新剧集规划后检查并迁移相关镜头。
            </p>
           </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
           <button type="button" className={smallAction} style={cardStyle}
            onClick={()=>setPendingDelete(null)}>取消</button>
           <button type="button" aria-label={`确认删除场次 ${index+1}`}
            className={smallAction+" font-semibold"} style={{background:theme.node.text,color:theme.node.panel,borderColor:theme.node.stroke}}
            onClick={()=>{
             if(active.sequences?.some(item=>item.id===sequence.id)){
              edit({sequences:active.sequences.filter(item=>item.id!==sequence.id)});
             }
             setPendingDelete(null);setRecentlyAdded("");
            }}>确认删除</button>
          </div>
         </div>}
      </div>
     </div>
    </details>)}
   </section>
  </div>
 </fieldset>;
}
