import {useState,type CSSProperties} from "react";
import {Clapperboard,Pencil} from "lucide-react";
import {canvasThemes,type CanvasTheme} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import type {DramaAsset,DramaShot} from "./canvas-drama-pipeline";
import {DramaEditActions} from "./drama-edit-actions";

type Choice={value:string;label:string};
type ShotFieldProps={
 id:string;label:string;value:string;theme:CanvasTheme;disabled:boolean;
 onConfirm:(value:string)=>void;multiline?:boolean;rows?:number;
 type?:"text"|"number"|"select";options?:Choice[];placeholder?:string;
};
/** This component owns only a temporary field value; the graph changes at explicit confirmation. */
function ShotEditableField({id,label,value,theme,disabled,onConfirm,multiline=false,rows=2,
 type="text",options,placeholder="未填写"}:ShotFieldProps){
 const [editing,setEditing]=useState(false);
 const [draft,setDraft]=useState(value);
 const [baseline,setBaseline]=useState(value);
 const stale=editing&&baseline!==value;
 const valid=type!=="number"||draft.trim()===""||
  (Number.isFinite(Number(draft))&&Number(draft)>0);
 const fieldStyle={background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text,
  "--tw-ring-color":theme.node.activeStroke} as CSSProperties;
 const begin=()=>{setBaseline(value);setDraft(value);setEditing(true);};
 const cancel=()=>{setEditing(false);setDraft(value);};
 const confirm=()=>{
  if(disabled||stale||!valid)return;
  if(draft!==value)onConfirm(draft);
  setEditing(false);
 };
 const read=type==="select"?
  options?.find(item=>item.value===value)?.label??(value?"未确认："+value:placeholder):
  value.trim()||placeholder;
 const inputClass="w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm leading-relaxed outline-none transition-shadow focus-visible:ring-2";
 return <section data-shot-editable-field={id} data-shot-field-mode={editing?"editing":"reading"}
  aria-label={label+"区域"} className={editing?
   "min-w-0 space-y-3 rounded-xl border p-3 sm:p-4":"min-w-0 space-y-1.5 border border-transparent"}
  style={editing?{background:theme.node.fill,borderColor:theme.node.stroke}:undefined}>
  <div className="flex min-h-7 items-center justify-between gap-2 text-xs font-medium"
   style={{color:theme.node.muted}}>
   <div className="flex min-w-0 items-center gap-1.5">
    <span>{label}</span>
    {!editing&&<button type="button" title={"编辑"+label} aria-label={"编辑"+label}
     disabled={disabled} onClick={begin}
     className="inline-grid size-7 shrink-0 place-items-center rounded-md border border-transparent hover:opacity-80 focus-visible:outline focus-visible:outline-2"
     style={{color:theme.node.muted,outlineColor:theme.node.activeStroke}}>
     <Pencil size={13} aria-hidden="true"/>
    </button>}
   </div>
   {editing&&<span className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold"
    style={{background:theme.toolbar.activeBg,color:theme.toolbar.activeText}}>编辑中</span>}
  </div>
  {editing?<>
   {type==="select"?
    <select aria-label={label} className={inputClass} style={fieldStyle}
     value={draft} disabled={disabled} onChange={event=>setDraft(event.target.value)}>
     {options?.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
    </select>:
    multiline?
     <textarea aria-label={label} rows={rows} className={inputClass+" thin-scrollbar resize-y"}
      style={fieldStyle} value={draft} disabled={disabled}
      onChange={event=>setDraft(event.target.value)}/>:
     <input aria-label={label} type={type} min={type==="number"?"0.1":undefined}
      step={type==="number"?"0.1":undefined} className={inputClass}
      style={fieldStyle} value={draft} disabled={disabled}
      onChange={event=>setDraft(event.target.value)}/>}
   {stale&&<p role="alert" className="text-xs" style={{color:theme.node.muted}}>
    内容已在其他位置更新，请取消并重新编辑。
   </p>}
   {!valid&&<p role="alert" className="text-xs" style={{color:theme.node.muted}}>
    镜头时长必须是大于 0 的数字，或留空。
   </p>}
   <DramaEditActions theme={theme} label={label} disabled={disabled||stale||!valid}
    onCancel={cancel} onConfirm={confirm}/>
  </>:
   <div data-shot-readonly={id} aria-label={label+"内容"}
    className="min-w-0 rounded-md border-l-2 px-3 py-2.5 text-sm leading-relaxed"
    style={{background:theme.toolbar.activeBg,color:value.trim()?theme.node.text:theme.node.muted,
     borderLeftColor:theme.node.stroke}}>
    <div className="whitespace-pre-wrap break-words">{read}</div>
   </div>}
 </section>;
}

export function DramaStoryboardFields({shots,episodes,scenes,expanded,disabled,control,onChange,initialEpisodeId,initialShotId}:{
 shots:DramaShot[];
 episodes:{id:string;title:string;targetDurationSec?:number;sequences?:{id:string;title:string}[]}[];
 scenes:DramaAsset[];expanded:boolean;disabled:boolean;control?:CSSProperties;
 onChange:(shots:DramaShot[])=>void;initialEpisodeId?:string;initialShotId?:string;
}){
 const appearance=useThemeStore(state=>state.theme);
 const theme=canvasThemes[appearance];
 const card={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
 const caption={color:theme.node.muted};
 const fieldStyle={background:theme.node.fill,color:theme.node.text,borderColor:theme.node.stroke,
  "--tw-ring-color":theme.node.activeStroke} as CSSProperties;
 const [episodeId,setEpisodeId]=useState(initialEpisodeId||shots.find(shot=>shot.id===initialShotId)?.episodeId||"");
 const [shotId,setShotId]=useState(initialShotId??"");
 const groups=[...new Set(shots.map(shot=>shot.episodeId))];
 const activeEpisode=groups.includes(episodeId)?episodeId:groups[0];
 const episodeShots=shots.filter(shot=>shot.episodeId===activeEpisode).sort((a,b)=>a.order-b.order);
 const active=episodeShots.find(shot=>shot.id===shotId)??episodeShots[0];
 const episode=episodes.find(item=>item.id===activeEpisode);
 const duration=episodeShots.reduce((sum,shot)=>sum+(shot.durationSec??0),0);
 const chooseEpisode=(id:string)=>{setEpisodeId(id);setShotId("");};
 const chooseShot=(id:string)=>setShotId(id);
 const selectedShotIndex=active?episodeShots.findIndex(shot=>shot.id===active.id):-1;
 const summary=(shot:DramaShot)=>shot.shotSize?.trim()||"未设置景别";
 if(!active)return <p className="rounded-xl border border-dashed px-3 py-4" style={control??card}>
  确认资产和剧集规划后，点击「生成草案」。
 </p>;
 const write=(next:DramaShot)=>onChange(shots.map(shot=>shot.id===active.id?next:shot));
 const patch=<K extends keyof DramaShot>(key:K,value:DramaShot[K])=>write({...active,[key]:value});
 const optional=(key:"shotSize"|"camera"|"action"|"dialogue"|"sequenceId"|"sceneVariantId",value:string)=>{
  const next={...active};
  if(value.trim())next[key]=value;
  else delete next[key];
  write(next);
 };
 const scene=scenes.find(item=>item.id===active.sceneId);
 const sceneOptions:Choice[]=[{value:"",label:"未指定场景"},...scenes.map(item=>({value:item.id,label:item.name}))];
 if(active.sceneId&&!scene)sceneOptions.push({value:active.sceneId,label:"未确认："+active.sceneId});
 const sceneVariants:Choice[]=[{value:"",label:"默认场景"},...(scene?.variants??[]).map(item=>({value:item.id,label:item.name}))];
 if(active.sceneVariantId&&!scene?.variants?.some(item=>item.id===active.sceneVariantId))
  sceneVariants.push({value:active.sceneVariantId,label:"未确认："+active.sceneVariantId});
 const sceneSequenceOptions:Choice[]=[{value:"",label:"未指定场次"},...(episode?.sequences??[]).map(item=>({value:item.id,label:item.title}))];
 if(active.sequenceId&&!episode?.sequences?.some(item=>item.id===active.sequenceId))
  sceneSequenceOptions.push({value:active.sequenceId,label:"未确认："+active.sequenceId});
 const shotName=(shot:DramaShot,index:number)=>`镜头 ${index+1} · ${shot.shotSize||shot.id}`;
 return <fieldset disabled={disabled} data-storyboard-editor-layout={expanded?"expanded":"compact"}
  className={expanded?
   "grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(116px,0.28fr)_minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(220px,0.33fr)_minmax(0,1fr)] lg:grid-rows-1":
   "grid min-w-0 gap-3"}
  style={{color:theme.node.text,colorScheme:appearance}}>
  {expanded?<aside aria-label="镜头目录" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border" style={card}>
   <div className="grid shrink-0 gap-2 border-b p-3" style={{borderColor:theme.node.stroke}}>
    <div className="flex items-center justify-between gap-2">
     <span className="inline-flex items-center gap-2 text-sm font-semibold">
      <Clapperboard size={15} style={caption}/>镜头目录
     </span>
     <span className="rounded-md px-2 py-1 text-[11px] font-medium tabular-nums"
      style={{background:theme.toolbar.activeBg,color:theme.node.muted}}>{episodeShots.length} 镜</span>
    </div>
    <label className="grid min-w-0 gap-1 text-xs" style={caption}>当前剧集
     <select aria-label="选择分镜剧集" className="w-full min-w-0 rounded-lg border px-2.5 py-2 text-xs"
      style={fieldStyle} value={activeEpisode} onChange={event=>chooseEpisode(event.target.value)}>
      {groups.map(id=><option key={id} value={id}>{episodes.find(item=>item.id===id)?.title||id}</option>)}
     </select>
    </label>
   </div>
   <nav aria-label="分镜镜头导航" className="thin-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto p-2" data-canvas-no-zoom="">
    {episodeShots.map((shot,index)=>{
     const current=shot.id===active.id;
     return <button type="button" key={shot.id} aria-pressed={current}
      aria-label={`选择镜头 ${index+1}：${shot.shotSize||shot.id}`}
      onClick={()=>chooseShot(shot.id)}
      className="flex w-full min-w-0 items-start gap-2.5 rounded-lg border px-3 py-3 text-left transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={current?{background:theme.toolbar.activeBg,color:theme.node.text,
       borderColor:theme.node.stroke,outlineColor:theme.node.activeStroke}:
       {background:"transparent",color:theme.node.text,borderColor:"transparent",
        outlineColor:theme.node.activeStroke}}>
      <span className="mt-0.5 shrink-0 text-[11px] font-semibold tabular-nums" style={caption}>
       {String(index+1).padStart(2,"0")}
      </span>
      <span className="min-w-0 flex-1">
       <span className="block truncate text-xs font-semibold">{summary(shot)}</span>
       <span className="mt-1 block truncate text-[11px]" style={caption}>{shot.description?.trim()||"暂无画面描述"}</span>
      </span>
      {current&&<span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full"
       style={{background:theme.node.activeStroke}}/>}
     </button>;
    })}
   </nav>
  </aside>:
   <div className="grid grid-cols-2 gap-2">
    <label className="grid min-w-0 gap-1 text-xs">剧集
     <select className="w-full min-w-0 rounded-lg border px-3 py-2" style={fieldStyle}
      value={activeEpisode} onChange={event=>chooseEpisode(event.target.value)}>
      {groups.map(id=><option key={id} value={id}>{episodes.find(item=>item.id===id)?.title||id}</option>)}
     </select>
    </label>
    <label className="grid min-w-0 gap-1 text-xs">镜头
     <select className="w-full min-w-0 rounded-lg border px-3 py-2" style={fieldStyle}
      value={active.id} onChange={event=>chooseShot(event.target.value)}>
      {episodeShots.map((shot,index)=><option key={shot.id} value={shot.id}>{shotName(shot,index)}</option>)}
     </select>
    </label>
   </div>}
  <div aria-label="当前分镜编辑区" data-canvas-no-zoom=""
   className={expanded?"thin-scrollbar min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain rounded-xl border p-3 sm:p-5":
    "grid min-w-0 gap-3 rounded-xl border p-3"} style={card}>
   {expanded&&<header className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b pb-3"
    style={{borderColor:theme.node.stroke}}>
    <div className="min-w-0">
     <p className="text-[11px] font-medium" style={caption}>第 {groups.indexOf(activeEpisode)+1} 集 · 镜头 {selectedShotIndex+1}</p>
     <h3 className="mt-1 truncate text-base font-semibold">{summary(active)}</h3>
    </div>
    <span className="rounded-lg border px-2 py-1 text-[11px] tabular-nums" style={card}>
     {active.durationSec??"—"} 秒 · {episodeShots.length} 镜
    </span>
   </header>}
   {episode?.targetDurationSec&&<p className="text-xs" style={caption}>
    当前剧集镜头时长合计 {duration} 秒 · 目标 {episode.targetDurationSec} 秒
   </p>}
   <div className="grid min-w-0 gap-3 md:grid-cols-2">
    <ShotEditableField key={active.id+":duration"} id="duration" label="镜头时长（秒）"
     theme={theme} disabled={disabled} type="number" placeholder="未设置"
     value={active.durationSec===undefined?"":String(active.durationSec)}
     onConfirm={value=>patch("durationSec",value.trim()?Number(value):undefined)}/>
    {(episode?.sequences?.length||active.sequenceId)?<ShotEditableField
     key={active.id+":sequence"} id="sequence" label="所属场次"
     theme={theme} disabled={disabled} type="select" options={sceneSequenceOptions}
     value={active.sequenceId??""} placeholder="未指定场次"
     onConfirm={value=>optional("sequenceId",value)}/>:null}
    <div className="min-w-0 md:col-span-2">
     <ShotEditableField key={active.id+":description"} id="description" label="画面描述"
      theme={theme} disabled={disabled} multiline rows={expanded?5:3}
      value={active.description} onConfirm={value=>patch("description",value)}/>
    </div>
    {([{key:"shotSize",label:"景别",rows:1},{key:"camera",label:"机位 / 运镜",rows:2},
      {key:"action",label:"动作",rows:3},{key:"dialogue",label:"对白",rows:3}] as const).map(field=>
     <ShotEditableField key={active.id+":"+field.key} id={field.key} label={field.label}
      theme={theme} disabled={disabled} multiline rows={field.rows} value={active[field.key]??""}
      onConfirm={value=>optional(field.key,value)}/>)}
    <ShotEditableField key={active.id+":scene"} id="scene" label="场景"
     theme={theme} disabled={disabled} type="select" options={sceneOptions}
     value={active.sceneId??""} placeholder="未指定场景"
     onConfirm={value=>{
      const next={...active};
      if(value)next.sceneId=value;
      else delete next.sceneId;
      // Changing the scene invalidates its variant, in the same explicit commit.
      delete next.sceneVariantId;
      write(next);
     }}/>
    {(scene?.variants?.length||active.sceneVariantId)?<ShotEditableField
     key={active.id+":sceneVariant"} id="sceneVariant" label="场景变体"
     theme={theme} disabled={disabled} type="select" options={sceneVariants}
     value={active.sceneVariantId??""} placeholder="默认场景"
     onConfirm={value=>optional("sceneVariantId",value)}/>:null}
   </div>
  </div>
 </fieldset>;
}
