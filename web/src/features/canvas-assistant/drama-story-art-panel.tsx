import {Fragment,useEffect,useId,useRef,useState} from "react";
import {ChevronDown,ChevronRight,Copy,Palette,Pencil} from "lucide-react";
import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import {DramaEditActions} from "./drama-edit-actions";
import {DramaInlineFeedback,useDramaFeedback} from "./drama-feedback";
import type {WorkspacePendingRegistration} from "./drama-creative-workspace";
import {storyArtFields,type PersistStoryDraft} from "./drama-story-state";

const fields=[{key:"videoRatio",label:"视频比例"},{key:"dramaFilmStyle",label:"影片风格"},...storyArtFields] as const;
type Field=typeof fields[number]["key"];
type Edit={key:Field;baseline:string;text:string};
function readValue(meta:CanvasNodeMetadata|undefined,key:Field):string{
 return key==="videoRatio"||key==="dramaFilmStyle"?meta?.[key]??"":meta?.dramaArtDirection?.[key]??"";
}
function fieldPatch(meta:CanvasNodeMetadata|undefined,key:Field,text:string):Partial<CanvasNodeMetadata>{
 if(key==="videoRatio")return {videoRatio:text||undefined};
 if(key==="dramaFilmStyle")return {dramaFilmStyle:text};
 return {dramaArtDirection:{palette:"",lighting:"",characterDesign:"",anchors:"",...meta?.dramaArtDirection,[key]:text}};
}
export function DramaStoryArtPanel({node,onChange,onPendingChange,disabled=false,interactionDisabled=false}:{
 node:CanvasNodeData;onChange:PersistStoryDraft;onPendingChange?:WorkspacePendingRegistration;disabled?:boolean;interactionDisabled?:boolean;
}){
 const theme=canvasThemes[useThemeStore(state=>state.theme)];
 const feedback=useDramaFeedback()?.api;
 const [expanded,setExpanded]=useState(false);
 const panelId=useId();
 const uiDisabled=disabled||interactionDisabled;
 const [edit,setEdit]=useState<Edit|null>(null),[saving,setSaving]=useState(false),[error,setError]=useState("");
 const locked=useRef(false),latest=useRef({edit,node});latest.current={edit,node};
 const commit=useRef<()=>Promise<void>>(async()=>{});
 const dirty=!!edit&&edit.text!==edit.baseline;
 const stale=!!edit&&readValue(node.metadata,edit.key)!==edit.baseline;
 commit.current=async()=>{
  const {edit:current,node:currentNode}=latest.current;
  if(!current)return;
  if(disabled||locked.current)return Promise.reject(Error("当前操作尚未完成"));
  if(readValue(currentNode.metadata,current.key)!==current.baseline){
   const reason="当前字段已在其他位置更新，请取消后重新编辑。";setError(reason);throw Error(reason);
  }
  if(current.text===current.baseline){setEdit(null);return;}
  locked.current=true;setSaving(true);setError("");
  const task=feedback?.beginTask("保存美术设定",fields.find(f=>f.key===current.key)?.label,true);
  try{
   task?.phase("保存草案");
   await onChange(fieldPatch(currentNode.metadata,current.key,current.text));
   setEdit(null);feedback?.notify("story-art:"+current.key,"success","美术设定草案已保存");
  }catch(cause){setError(cause instanceof Error?cause.message:"保存失败，请重试");throw cause;}
  finally{task?.end();locked.current=false;setSaving(false);}
 };
 useEffect(()=>{
  onPendingChange?.(node.id+":story-art",dirty?()=>commit.current():null);
  return ()=>onPendingChange?.(node.id+":story-art",null);
 },[node.id,dirty,onPendingChange]);
 const themeStyle={background:theme.node.fill,borderColor:theme.node.stroke,color:theme.node.text};
 const copy=async(value:string)=>{
  try{await navigator.clipboard.writeText(value);feedback?.notify("story-style-copy","success","影片风格已复制");}
  catch{setError("复制失败，请检查剪贴板权限");}
 };
 const style=readValue(node.metadata,"dramaFilmStyle"),ratio=readValue(node.metadata,"videoRatio");
 const configured=storyArtFields.filter(({key})=>readValue(node.metadata,key).trim()).length;
 return <section data-story-art-section="" className="min-w-0 shrink-0 rounded-lg border" style={{borderColor:theme.node.stroke,color:theme.node.text}}>
  <button type="button" data-story-art-toggle="" aria-expanded={expanded} aria-controls={expanded?panelId:undefined}
   aria-label={expanded?"收起美术设定":"展开美术设定"}
   title={edit?"请先保存或取消当前美术字段":expanded?"收起美术设定":"展开美术设定"}
   disabled={!!edit||saving}
   className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:opacity-80 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2"
   style={{color:theme.node.text,outlineColor:theme.node.activeStroke}} onClick={()=>setExpanded(value=>!value)}>
   <Palette size={14} className="shrink-0" aria-hidden="true"/>
   <strong className="shrink-0 font-medium">美术设定</strong>
   <span data-story-art-summary="" className="min-w-0 flex-1 truncate" title={`${ratio||"随模型"} · ${style||"未设置影片风格"} · 美术指导 ${configured}/${storyArtFields.length}`} style={{color:theme.node.muted}}>
    {ratio||"随模型"} · {style||"未设置影片风格"} · 美术指导 {configured}/{storyArtFields.length}
   </span>
   {edit&&<span className="shrink-0 text-[11px]" style={{color:theme.node.muted}}>{dirty?"未保存":"编辑中"}</span>}
   {expanded?<ChevronDown size={14} className="shrink-0" aria-hidden="true"/>:<ChevronRight size={14} className="shrink-0" aria-hidden="true"/>}
  </button>
  {expanded&&<div id={panelId} data-story-art-panel="" className="thin-scrollbar max-h-[min(36dvh,280px)] min-w-0 overflow-y-auto overscroll-contain border-t p-3" style={{borderColor:theme.node.stroke}}>
  <div className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
  {fields.map(({key,label},i)=>{
   const value=readValue(node.metadata,key),active=edit?.key===key;
   return <Fragment key={key}>
    {i===2&&<h3 className="col-span-full border-t pt-2 text-xs font-semibold" style={{borderColor:theme.node.stroke}}>作品美术指导</h3>}
    <section className="min-w-0 space-y-1.5">
    <div className="flex min-h-7 items-center gap-1.5 text-xs">
     <strong>{label}</strong>
     {!active&&<button type="button" aria-label={"编辑"+label} title={"编辑"+label}
      disabled={uiDisabled||saving||!!edit} className="inline-grid size-7 place-items-center rounded-md hover:opacity-80 disabled:opacity-45"
      style={{color:theme.node.muted}} onClick={()=>{setError("");setEdit({key,baseline:value,text:value});}}><Pencil size={13}/></button>}
     {key==="dramaFilmStyle"&&<button type="button" title="复制影片风格" aria-label="复制影片风格"
      disabled={!(active?edit.text:value)} className="inline-grid size-7 place-items-center rounded-md hover:opacity-80 disabled:opacity-45"
      style={{color:theme.node.muted}} onClick={()=>void copy(active?edit.text:value)}><Copy size={13}/></button>}
     {active&&key!=="videoRatio"&&<span className="ml-auto" style={{color:theme.node.muted}}>{edit.text.length} / {key==="dramaFilmStyle"?500:2000}</span>}
    </div>
    {active?<div className="space-y-2">
     {key==="videoRatio"?<select aria-label={label} autoFocus value={edit.text} disabled={uiDisabled||saving}
      className="w-full max-w-48 rounded-lg border px-3 py-2 text-sm" style={themeStyle}
      onChange={e=>setEdit({...edit,text:e.target.value})}>
      <option value="">随模型</option>{["16:9","9:16","1:1","4:3","3:4","21:9"].map(ratio=><option key={ratio}>{ratio}</option>)}
     </select>:<textarea aria-label={label} autoFocus value={edit.text} rows={key==="dramaFilmStyle"?2:3}
      maxLength={key==="dramaFilmStyle"?500:2000} disabled={uiDisabled||saving}
      className="w-full min-w-0 resize-y rounded-lg border px-3 py-2 text-sm leading-relaxed" style={themeStyle}
      onChange={e=>{setError("");setEdit({...edit,text:e.target.value});}}
      onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="s"){e.preventDefault();if(!uiDisabled)void commit.current().catch(()=>{});}}}/>}
     {stale&&!saving&&<DramaInlineFeedback theme={theme}>字段已更新，请取消后重新编辑。</DramaInlineFeedback>}
     {saving&&<DramaInlineFeedback theme={theme} level="info" pending>正在保存草案…</DramaInlineFeedback>}
     <DramaEditActions theme={theme} label={label} disabled={uiDisabled||saving||stale}
      confirmText="保存" onConfirm={()=>void commit.current().catch(()=>{})}
      onCancel={()=>{if(!locked.current){setEdit(null);setError("");}}}/>
    </div>:<div className="min-w-0 whitespace-pre-wrap break-words rounded-lg border-l-2 px-3 py-2 text-sm leading-relaxed"
     style={{background:theme.toolbar.activeBg,borderColor:theme.node.activeStroke}}>
     {value||<span style={{color:theme.node.muted}}>{key==="videoRatio"?"随模型":"未设置"}</span>}
    </div>}
   </section></Fragment>;
  })}
  </div>
  {error&&<DramaInlineFeedback theme={theme} level="error" error={error}/>}
  </div>}
 </section>;
}
