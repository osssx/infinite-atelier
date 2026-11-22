import {useRef,useState,type CSSProperties} from "react";
import {GitBranch,Layers3,Plus,Split,Merge,BookText,Trash2,AlertTriangle,Pencil,Check,X} from "lucide-react";
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

type EpisodeFieldKey="title"|"duration"|"synopsis"|"events"|"ending";
type EpisodeFieldProps={
 id:EpisodeFieldKey;label:string;value:string;disabled:boolean;theme:ReturnType<typeof canvasThemeForField>;
 onConfirm:(value:string)=>void;multiline?:boolean;rows?:number;type?:"text"|"number";
 count?:(value:string)=>string;placeholder?:string;
};
function canvasThemeForField(appearance:"light"|"dark"){return canvasThemes[appearance];}
function EpisodeReadEditField({id,label,value,disabled,theme,onConfirm,multiline=false,rows=2,type="text",count,placeholder="未填写"}:EpisodeFieldProps){
 const [editing,setEditing]=useState(false);
 const [draft,setDraft]=useState(value);
 const [baseline,setBaseline]=useState(value);
 const stale=editing&&baseline!==value;
 const valid=type!=="number"||draft.trim()===""||(Number.isFinite(Number(draft))&&Number(draft)>0);
 const text=editing?draft:value;
 const headingStyle={color:theme.node.muted};
 const inputStyle={background:theme.node.fill,color:theme.node.text,borderColor:theme.node.stroke,
  "--tw-ring-color":theme.node.activeStroke} as CSSProperties;
 const smallButton="inline-flex min-h-7 items-center justify-center gap-1 rounded-md border px-2 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 disabled:opacity-40";
 const begin=()=>{setBaseline(value);setDraft(value);setEditing(true);};
 const cancel=()=>{setEditing(false);setDraft(value);};
 const confirm=()=>{
  if(stale||!valid)return;
  if(draft!==value)onConfirm(draft);
  setEditing(false);
 };
 return <section data-episode-editable-field={id} data-episode-field-mode={editing?"editing":"reading"}
   aria-label={label+"区域"} className="min-w-0 space-y-1.5">
   <div className="flex min-h-7 items-center justify-between gap-2 text-xs font-medium" style={headingStyle}>
    <div className="flex min-w-0 items-center gap-1.5">
     <span>{label}</span>
     {!editing&&<button type="button" aria-label={"编辑"+label} title={"编辑"+label}
       className="inline-grid size-7 shrink-0 place-items-center rounded-md border border-transparent hover:opacity-80 focus-visible:outline focus-visible:outline-2"
       style={{color:theme.node.muted,outlineColor:theme.node.activeStroke}} disabled={disabled}
       onClick={begin}><Pencil size={13} aria-hidden="true"/></button>}
    </div>
    {count&&<span className="shrink-0 text-[11px] font-normal tabular-nums">{count(text)}</span>}
   </div>
   {editing?<>
    {multiline?
      <textarea aria-label={label==="剧情事件（每行一条）"?"剧情事件":label}
       className="thin-scrollbar w-full min-w-0 resize-y rounded-lg border px-3 py-2.5 text-sm leading-relaxed outline-none focus-visible:ring-2"
       style={inputStyle} rows={rows} value={draft} disabled={disabled}
       onChange={event=>setDraft(event.target.value)}/>:
      <input aria-label={label} type={type} min={type==="number"?"0.1":undefined}
       step={type==="number"?"0.1":undefined} maxLength={type==="text"?12000:undefined}
       className="w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm leading-relaxed outline-none focus-visible:ring-2"
       style={inputStyle} value={draft} disabled={disabled}
       onChange={event=>setDraft(event.target.value)}/>}
    {stale&&<p role="alert" className="text-xs" style={headingStyle}>内容已在其他位置更新，请取消并重新编辑。</p>}
    {!valid&&<p role="alert" className="text-xs" style={headingStyle}>目标时长必须是大于 0 的数字，或留空。</p>}
    <div className="flex justify-end gap-2" aria-label={label+"操作"}>
     <button type="button" className={smallButton}
      style={{background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke}}
      onClick={cancel}><X size={13} aria-hidden="true"/>取消</button>
     <button type="button" aria-label={"确认"+label} className={smallButton}
      style={{background:theme.node.text,color:theme.node.panel,borderColor:theme.node.text}}
      disabled={disabled||stale||!valid} onClick={confirm}><Check size={13} aria-hidden="true"/>确认</button>
    </div>
   </>:
    <div data-episode-readonly={id} aria-label={label+"内容"}
     className={"min-w-0 rounded-lg border px-3 py-2.5 text-sm leading-relaxed "+(id==="title"?"font-semibold":"")}
     style={{background:theme.node.fill,color:value.trim()?theme.node.text:theme.node.muted,borderColor:theme.node.stroke}}>
     {id==="events"&&value.trim()?<ol className="space-y-2">
       {value.split("\n").filter(line=>line.trim()).map((line,index)=>
        <li key={index} className="flex min-w-0 gap-2">
         <span className="w-5 shrink-0 text-right text-[11px] tabular-nums" style={headingStyle}>{index+1}.</span>
         <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{line}</span>
        </li>)}
      </ol>:<div className="whitespace-pre-wrap break-words">{value.trim()?value:placeholder}</div>}
    </div>}
  </section>;
}
type EpisodeSequence=NonNullable<DramaEpisode["sequences"]>[number];
function SequenceReadEditFields({sequence,index,events,items,theme,disabled,onConfirm,startEditing=false}:{
 sequence:EpisodeSequence;index:number;events:string[];
 items:NonNullable<DramaEpisode["eventItems"]>;theme:ReturnType<typeof canvasThemeForField>;disabled:boolean;
 onConfirm:(next:EpisodeSequence)=>void;startEditing?:boolean;
}){
 const [editing,setEditing]=useState(startEditing);
 const [title,setTitle]=useState(sequence.title);
 const [refs,setRefs]=useState((sequence.sourceRefs??[]).join("\n"));
 const [eventRefs,setEventRefs]=useState([...(sequence.eventRefs??[])]);
 const [baseline,setBaseline]=useState(sequence);
 const stale=editing&&(baseline.title!==sequence.title||
  (baseline.sourceRefs??[]).join("\n")!==(sequence.sourceRefs??[]).join("\n")||
  (baseline.eventRefs??[]).join("\n")!==(sequence.eventRefs??[]).join("\n"));
 const begin=()=>{setBaseline(sequence);setTitle(sequence.title);setRefs((sequence.sourceRefs??[]).join("\n"));
  setEventRefs([...(sequence.eventRefs??[])]);setEditing(true);};
 const cancel=()=>{setEditing(false);setTitle(sequence.title);setRefs((sequence.sourceRefs??[]).join("\n"));
  setEventRefs([...(sequence.eventRefs??[])]);};
 const confirm=()=>{
  if(stale||disabled)return;
  const sourceRefs=refs.split("\n").map(ref=>ref.trim()).filter(Boolean);
  const next={...sequence,title,sourceRefs,eventRefs};
  if(title!==sequence.title||sourceRefs.join("\n")!==(sequence.sourceRefs??[]).join("\n")||
    eventRefs.join("\n")!==(sequence.eventRefs??[]).join("\n"))onConfirm(next);
  setEditing(false);
 };
 const control={background:theme.node.fill,color:theme.node.text,borderColor:theme.node.stroke};
 const secondary="inline-flex min-h-8 items-center justify-center gap-1 rounded-lg border px-2.5 text-xs font-medium hover:opacity-80";
 return <div data-episode-sequence-mode={editing?"editing":"reading"} className="space-y-3" aria-label={"场次 "+(index+1)+" 详情"}>
   <div className="flex items-center gap-1.5">
    <strong className="text-xs">场次详情</strong>
    {!editing&&<button type="button" aria-label={"编辑场次 "+(index+1)+" 详情"} title="编辑场次详情"
      disabled={disabled} className="inline-grid size-7 shrink-0 place-items-center rounded-md border border-transparent hover:opacity-80 focus-visible:outline focus-visible:outline-2"
      style={{color:theme.node.muted,outlineColor:theme.node.activeStroke}} onClick={begin}>
      <Pencil size={13} aria-hidden="true"/>
     </button>}
   </div>
   {editing?<>
    <label className="grid min-w-0 gap-1.5">
     <span style={{color:theme.node.muted}}>场次名称</span>
     <input aria-label={`场次 ${index+1} 名称`} className="w-full min-w-0 rounded-lg border px-3 py-2 text-xs"
      style={control} value={title} disabled={disabled} onChange={event=>setTitle(event.target.value)}/>
    </label>
    <label className="grid min-w-0 gap-1.5">
     <span style={{color:theme.node.muted}}>场次原文段落 ID（每行一个）</span>
     <textarea aria-label={`场次 ${index+1} 原文段落`} className="thin-scrollbar w-full min-w-0 rounded-lg border px-3 py-2 text-xs"
      style={control} rows={2} value={refs} disabled={disabled} onChange={event=>setRefs(event.target.value)}/>
    </label>
    <div className="space-y-1.5">
     <span style={{color:theme.node.muted}}>本场关联剧情事件（稳定 ID）</span>
     {items.filter(item=>item.text.trim()).map((item,index)=>
      <label key={item.id||index} className="flex items-start gap-2">
       <input type="checkbox" className="mt-0.5" disabled={disabled}
        checked={eventRefs.includes(item.id)||eventRefs.includes(item.text)}
        onChange={change=>setEventRefs(current=>change.target.checked?
         [...new Set([...current,item.id])]:current.filter(ref=>ref!==item.id&&ref!==item.text))}/>
       <span className="break-words">{item.text}</span>
      </label>)}
    </div>
    {stale&&<p role="alert" className="text-xs">场次已在其他位置更新，请取消并重新编辑。</p>}
    <div className="flex justify-end gap-2">
     <button type="button" className={secondary} style={control} onClick={cancel}><X size={13}/>取消</button>
     <button type="button" aria-label={"确认场次 "+(index+1)+" 详情"} className={secondary}
      style={{background:theme.node.text,color:theme.node.panel,borderColor:theme.node.text}}
      disabled={disabled||stale} onClick={confirm}><Check size={13}/>确认</button>
    </div>
   </>:
    <div className="grid min-w-0 gap-2 rounded-lg border p-3 text-xs" style={control}>
     <p><span style={{color:theme.node.muted}}>名称：</span>{sequence.title||"未命名场次"}</p>
     <p className="break-words"><span style={{color:theme.node.muted}}>原文段落：</span>{sequence.sourceRefs?.join("、")||"未设置"}</p>
     <div>
      <span style={{color:theme.node.muted}}>关联事件：</span>
      <span>{sequence.eventRefs?.length??0} 条</span>
      {sequence.eventRefs?.length? <ul className="mt-1 list-inside list-disc space-y-1">
       {sequence.eventRefs.map(ref=><li key={ref} className="break-words">
        {items.find(item=>item.id===ref||item.text===ref)?.text??ref}
       </li>)}
      </ul>:null}
     </div>
    </div>}
    {(sequence.eventRefs??[]).some(ref=>!events.includes(ref)&&!items.some(item=>item.id===ref))&&
      <p role="alert" className="text-[11px]">事件引用缺失或有歧义，请核对稳定 ID 后更新。</p>}
    {(sequence.replaces?.length??0)>0&&<p className="text-[11px]">替代旧场次：{sequence.replaces?.join("、")}。请审核旧镜头的场次迁移。</p>}
  </div>;
}

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
   <div className={expanded?"grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_190px]":"grid gap-3"}>
    <EpisodeReadEditField key={active.id+":title"} id="title" label="集标题" value={active.title}
     disabled={disabled} theme={theme} onConfirm={title=>edit({title})}/>
    <EpisodeReadEditField key={active.id+":duration"} id="duration" label="目标时长（秒）"
     value={active.targetDurationSec===undefined?"":String(active.targetDurationSec)} placeholder="未设置"
     disabled={disabled} theme={theme} type="number"
     onConfirm={duration=>edit({targetDurationSec:duration.trim()?Number(duration):undefined})}/>
   </div>
   <section className="grid min-w-0 gap-3" aria-label="剧情内容">
    <EpisodeReadEditField key={active.id+":synopsis"} id="synopsis" label="剧情梗概"
     value={active.synopsis} disabled={disabled} theme={theme} multiline rows={expanded?5:3}
     count={value=>value.length+" 字"} onConfirm={synopsis=>edit({synopsis})}/>
    <EpisodeReadEditField key={active.id+":events"} id="events" label="剧情事件（每行一条）"
     value={active.events.join("\n")} disabled={disabled} theme={theme} multiline rows={expanded?9:4}
     count={value=>value.split("\n").filter(line=>line.trim()).length+" 条"}
     onConfirm={text=>{
      const normalized=normalizeEpisodeEvents({...active,events:text.split("\n")},active);
      edit({events:normalized.events,eventItems:normalized.eventItems,sequences:normalized.sequences});
     }}/>
    <div className="flex justify-end">
     <button type="button" className={smallAction} style={cardStyle} onClick={()=>{
      const normalized=normalizeEpisodeEvents(active,active);
      edit({eventItems:normalized.eventItems,sequences:normalized.sequences});
     }}>补齐旧事件的稳定 ID</button>
    </div>
    <EpisodeReadEditField key={active.id+":ending"} id="ending" label="本集结尾"
     value={active.ending} disabled={disabled} theme={theme} multiline rows={2}
     onConfirm={ending=>edit({ending})}/>
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
       <SequenceReadEditFields key={active.id+":"+sequence.id} sequence={sequence}
        index={index} events={active.events} items={active.eventItems??active.events.map(text=>({id:text,text}))}
        theme={theme} disabled={disabled} startEditing={recentlyAdded===sequence.id}
        onConfirm={updated=>edit({sequences:active.sequences?.map(item=>
         item.id===sequence.id?updated:item)})}/>
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
    </details>)}
   </section>
  </div>
 </fieldset>;
}
