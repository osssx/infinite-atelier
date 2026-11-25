import {useEffect,useState,type CSSProperties,type ReactNode} from "react";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {AlertTriangle,Clapperboard,LayoutGrid,List,Pencil,Plus,Trash2} from "lucide-react";
import {canvasThemes,type CanvasTheme} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import type {DramaAsset,DramaShot} from "./canvas-drama-pipeline";
import {DramaEditActions} from "./drama-edit-actions";
import {DramaInlineFeedback,useDramaFieldFeedback} from "./drama-feedback";
import {DramaAssetDirectoryPreview} from "./drama-asset-directory-preview";
import {isCanvasCasKey} from "@/features/backend-sync/canvas-cas";
import type {DramaShotProduction} from "./drama-pipeline-media";

export function shotDirectoryCover(setting?:DramaShotProduction){
 const key=setting?.gridInput?setting.gridImage:
  setting?.mode==="first_frame"||setting?.mode==="first_last_frame"?setting.firstFrame:undefined;
 return key&&isCanvasCasKey(key)?key:undefined;
}

type Choice={value:string;label:string};
type ShotFieldProps={
 id:string;label:string;value:string;theme:CanvasTheme;disabled:boolean;
 onConfirm:(value:string)=>void|Promise<void>;multiline?:boolean;rows?:number;
 type?:"text"|"number"|"select";options?:Choice[];placeholder?:string;
};
/** This component owns only a temporary field value; the graph changes at explicit confirmation. */
function ShotEditableField({id,label,value,theme,disabled,onConfirm,multiline=false,rows=2,
 type="text",options,placeholder="未填写"}:ShotFieldProps){
 const [editing,setEditing]=useState(false);
 const [draft,setDraft]=useState(value);
 const [baseline,setBaseline]=useState(value);
 const [busy,setBusy]=useState(false);
 const updated=useDramaFieldFeedback();
 const [error,setError]=useState("");
 const stale=editing&&baseline!==value;
 const valid=type!=="number"||draft.trim()===""||
  (Number.isFinite(Number(draft))&&Number(draft)>0);
 const fieldStyle={background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text,
  "--tw-ring-color":theme.node.activeStroke} as CSSProperties;
 const begin=()=>{setError("");setBaseline(value);setDraft(value);setEditing(true);};
 const cancel=()=>{if(busy)return;setError("");setEditing(false);setDraft(value);};
 const confirm=async()=>{
  if(disabled||busy||stale||!valid)return;
  setBusy(true);setError("");
  try{
   if(draft!==value){await onConfirm(draft);updated(label);}
   setEditing(false);
  }catch(error){setError(error instanceof Error?error.message:"保存失败，请检查镜头版本后重试");}
  finally{setBusy(false);}
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
   {stale&&<DramaInlineFeedback theme={theme}>内容已在其他位置更新，请取消并重新编辑。</DramaInlineFeedback>}
   {!valid&&<DramaInlineFeedback theme={theme}>镜头时长必须是大于 0 的数字，或留空。</DramaInlineFeedback>}
   {error&&<DramaInlineFeedback theme={theme} level="error" error={error}/>}
   {busy&&<DramaInlineFeedback theme={theme} level="info" pending>正在保存镜头草案…</DramaInlineFeedback>}
   <DramaEditActions theme={theme} label={label} disabled={disabled||busy||stale||!valid}
    onCancel={cancel} onConfirm={()=>void confirm()}/>
  </>:
   <div data-shot-readonly={id} aria-label={label+"内容"}
    className="min-w-0 rounded-md border-l-2 px-3 py-2.5 text-sm leading-relaxed"
    style={{background:theme.toolbar.activeBg,color:value.trim()?theme.node.text:theme.node.muted,
     borderLeftColor:theme.node.stroke}}>
    <div className="whitespace-pre-wrap break-words">{read}</div>
   </div>}
 </section>;
}

/** Asset references are edited as one local field transaction, matching the
 * existing read-only-first shot field UX. Unknown legacy IDs remain visible and
 * removable rather than silently disappearing on edit.
 */
function ShotAssetMultiField({id,label,value,options,theme,disabled,onConfirm}:{
 id:string;label:string;value:string[];options:Choice[];theme:CanvasTheme;disabled:boolean;
 onConfirm:(value:string[])=>void|Promise<void>;
}){
 const [editing,setEditing]=useState(false);
 const [draft,setDraft]=useState<string[]>(value);
 const [baseline,setBaseline]=useState<string[]>(value);
 const [busy,setBusy]=useState(false);
 const updated=useDramaFieldFeedback();
 const [error,setError]=useState("");
 const stale=editing&&JSON.stringify(baseline)!==JSON.stringify(value);
 const choices=[...options,...value.filter(key=>!options.some(option=>option.value===key))
  .map(key=>({value:key,label:"待匹配 · "+key}))];
 const names=value.map(key=>choices.find(option=>option.value===key)?.label??key);
 const begin=()=>{setError("");setDraft([...value]);setBaseline([...value]);setEditing(true);};
 const cancel=()=>{if(busy)return;setError("");setDraft([...value]);setEditing(false);};
 const confirm=async()=>{
  if(disabled||busy||stale)return;
  setBusy(true);setError("");
  try{
   if(JSON.stringify(draft)!==JSON.stringify(value)){await onConfirm(draft);updated(label);}
   setEditing(false);
  }catch(error){setError(error instanceof Error?error.message:"保存失败，请检查镜头版本后重试");}
  finally{setBusy(false);}
 };
 const fieldStyle={background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text,
  "--tw-ring-color":theme.node.activeStroke} as CSSProperties;
 return <section data-shot-editable-field={id} data-shot-field-mode={editing?"editing":"reading"}
  aria-label={label+"区域"} className={editing?
   "min-w-0 space-y-3 rounded-xl border p-3 sm:p-4":"min-w-0 space-y-1.5 border border-transparent"}
  style={editing?{background:theme.node.fill,borderColor:theme.node.stroke}:undefined}>
  <div className="flex min-h-7 items-center justify-between gap-2 text-xs font-medium" style={{color:theme.node.muted}}>
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
   <div role="group" aria-label={label+"候选"} data-canvas-no-zoom
    className="thin-scrollbar max-h-48 min-w-0 space-y-1 overflow-y-auto rounded-lg border p-2"
    style={fieldStyle}>
    {choices.length?choices.map(option=><label key={option.value}
     className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:opacity-80">
     <input type="checkbox" className="mt-0.5 shrink-0" checked={draft.includes(option.value)}
      disabled={disabled} onChange={event=>setDraft(current=>event.target.checked?
       [...current,option.value]:current.filter(key=>key!==option.value))}/>
     <span className="min-w-0 break-words">{option.label}</span>
    </label>):<p className="px-2 py-2 text-xs" style={{color:theme.node.muted}}>
     暂无可选资产，请先在上游资产规划中确认对应资产。
    </p>}
   </div>
   {stale&&<DramaInlineFeedback theme={theme}>内容已在其他位置更新，请取消并重新编辑。</DramaInlineFeedback>}
   {error&&<DramaInlineFeedback theme={theme} level="error" error={error}/>}
   {busy&&<DramaInlineFeedback theme={theme} level="info" pending>正在保存镜头草案…</DramaInlineFeedback>}
   <DramaEditActions theme={theme} label={label} disabled={disabled||busy||stale}
    onCancel={cancel} onConfirm={()=>void confirm()}/>
  </>:
   <div data-shot-readonly={id} aria-label={label+"内容"}
    className="min-w-0 rounded-md border-l-2 px-3 py-2.5 text-sm leading-relaxed"
    style={{background:theme.toolbar.activeBg,color:names.length?theme.node.text:theme.node.muted,
     borderLeftColor:theme.node.stroke}}>
    <div className="whitespace-pre-wrap break-words">{names.join("、")||"未指定"}</div>
   </div>}
 </section>;
}

export function DramaStoryboardFields({shots,episodes,assets,expanded,disabled,control,onChange,initialEpisodeId,initialShotId,
 projectId,nodeId,onPatchShot,onReloadShot,onWaitForDraftSave,selectedEpisodeId,onEpisodeChange,selectedShotId,onShotChange,renderVideoConfig,videoStatusFor,production,navigationLocked=false}:{
 shots:DramaShot[];
 episodes:{id:string;title:string;targetDurationSec?:number;sequences?:{id:string;title:string}[]}[];
 assets:DramaAsset[];expanded:boolean;disabled:boolean;control?:CSSProperties;
 onChange:(shots:DramaShot[])=>void;initialEpisodeId?:string;initialShotId?:string;
 selectedEpisodeId?:string;onEpisodeChange?:(id:string)=>void;
 selectedShotId?:string;onShotChange?:(id:string)=>void;
 navigationLocked?:boolean;
 renderVideoConfig?:(shot:DramaShot)=>ReactNode;videoStatusFor?:(shot:DramaShot)=>string;
 production?:Readonly<Record<string,DramaShotProduction>>;
 projectId?:string;nodeId?:string;
 onPatchShot?:(shotId:string,expectedDigest:string,changes:Record<string,unknown>)=>Promise<void>;
 onReloadShot?:()=>Promise<void>;
 onWaitForDraftSave?:()=>Promise<void>;
}){
 const appearance=useThemeStore(state=>state.theme);
 const theme=canvasThemes[appearance];
 const card={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
 const caption={color:theme.node.muted};
 const fieldStyle={background:theme.node.fill,color:theme.node.text,borderColor:theme.node.stroke,
  "--tw-ring-color":theme.node.activeStroke} as CSSProperties;
 const [episodeId,setEpisodeId]=useState(initialEpisodeId||shots.find(shot=>shot.id===initialShotId)?.episodeId||"");
 const [shotId,setShotId]=useState(initialShotId??"");
 const [directoryView,setDirectoryView]=useState<"list"|"cards">("list");
 const cards=directoryView==="cards";
 const [pendingDelete,setPendingDelete]=useState<{episodeId:string;shotId:string;snapshot:string}|null>(null);
 const groups=[...new Set([...episodes.map(item=>item.id),...shots.map(shot=>shot.episodeId)])];
 const currentEpisode=selectedEpisodeId??episodeId;
 const activeEpisode=groups.includes(currentEpisode)?currentEpisode:groups[0];
 const episodeShots=shots.filter(shot=>shot.episodeId===activeEpisode).sort((a,b)=>a.order-b.order);
 const active=episodeShots.find(shot=>shot.id===(selectedShotId??shotId))??episodeShots[0];
 const episode=episodes.find(item=>item.id===activeEpisode);
 const duration=episodeShots.reduce((sum,shot)=>sum+(shot.durationSec??0),0);
 const chooseEpisode=(id:string)=>{if(navigationLocked)return;setPendingDelete(null);setEpisodeId(id);setShotId("");onShotChange?.("");onEpisodeChange?.(id);};
 const chooseShot=(id:string)=>{if(navigationLocked)return;setPendingDelete(null);setShotId(id);onShotChange?.(id);};
 const selectedShotIndex=active?episodeShots.findIndex(shot=>shot.id===active.id):-1;
 const summary=(shot:DramaShot)=>shot.shotSize?.trim()||"未设置景别";
 const smallAction="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40";
 const addShot=()=>{
  if(disabled||casBusy||navigationLocked||!activeEpisode)return;
  const used=new Set(shots.map(item=>item.id));
  let id:string;
  do{id="shot_"+crypto.randomUUID();}while(used.has(id));
  // Insert at the selected shot in logical order, not at the end of the draft.
  // Renumber only this episode; other episodes and all stable shot IDs stay intact.
  const insertAt=active?selectedShotIndex+1:0;
  const next:DramaShot={id,episodeId:activeEpisode,order:insertAt+1,description:"",
   characterVariantIds:[],propIds:[],keyPropIds:[]};
  const ordered=[...episodeShots];
  ordered.splice(insertAt,0,next);
  const orderById=new Map(ordered.map((shot,index)=>[shot.id,index+1]));
  const updated=shots.map(shot=>{
   const order=orderById.get(shot.id);
   return order!==undefined&&shot.order!==order?{...shot,order}:shot;
  });
  const position=active?shots.findIndex(shot=>shot.id===active.id)+1:updated.length;
  updated.splice(position,0,next);
  setPendingDelete(null);
  setEpisodeId(activeEpisode);setShotId(id);onShotChange?.(id);
  onChange(updated);
 };
 const scopedCas=Boolean(projectId&&nodeId&&onPatchShot);
 const [shotDigest,setShotDigest]=useState<{id:string;digest:string}|null>(null);
 const [casBusy,setCasBusy]=useState(false);
 const [casError,setCasError]=useState("");
 const [casRefresh,setCasRefresh]=useState(0);
 useEffect(()=>{
  if(!scopedCas||!active?.id||!projectId||!nodeId)return;
  let live=true;
  const abort=new AbortController();
  setShotDigest(null);setCasError("");
  const url=`/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/revision-scope?`+
   `nodeId=${encodeURIComponent(nodeId)}&draft=true&episodeId=${encodeURIComponent(active.episodeId)}`+
   `&entryId=${encodeURIComponent(active.id)}&limit=1`;
  const read=()=>canvasApi<{entries:DramaShot[];entryDigests:{id:string;digest:string}[]}>(url,"GET",undefined,abort.signal);
  void read().then(async first=>{
    if(!live)return;
    let result=first;
    // A newly inserted shot is visible in the local draft before the debounced
    // backend save. Flush that draft once before requesting its CAS digest again.
    if(!result.entries.some(item=>item.id===active.id)&&onWaitForDraftSave){
     await onWaitForDraftSave();
     if(!live)return;
     result=await read();
    }
    if(!live)return;
    const digest=result.entryDigests.find(item=>item.id===active.id)?.digest;
    const remote=result.entries[0];
    if(remote?.id!==active.id||!digest)throw Error("镜头版本无法定位，请重新载入");
    const keys=["description","shotSize","camera","action","dialogue","durationSec","sequenceId",
     "sceneId","sceneVariantId","characterVariantIds","propIds","keyPropIds","sourceRefs"] as const;
    if(keys.some(key=>JSON.stringify(remote[key]??null)!==JSON.stringify(active[key]??null)))
     throw Error("服务器镜头内容已更新，请重新加载后再编辑，避免覆盖其他修改");
    setShotDigest({id:active.id,digest});
   })
   .catch(error=>{if(live)setCasError(error instanceof Error?error.message:"无法读取镜头版本");});
  return ()=>{live=false;abort.abort();};
 },[scopedCas,projectId,nodeId,active?.id,active?.episodeId,casRefresh]);
 // Paginate large episode directories from the indexed server scope. The loaded
 // draft remains authoritative for structural insert/delete until that operation
 // is migrated; pagination limits mounted rows and reads only 15 indexed entries.
 const pageSize=15;
 const paginatedDirectory=expanded&&episodeShots.length>pageSize&&(scopedCas||cards);
 const useScopedDirectory=scopedCas&&paginatedDirectory;
 const [pageStart,setPageStart]=useState(0);
 const [serverPage,setServerPage]=useState<{episodeId:string;offset:number;entries:DramaShot[];total:number}|null>(null);
 const [pageError,setPageError]=useState("");
 const safePageStart=Math.min(Math.floor(pageStart/pageSize)*pageSize,
  Math.floor(Math.max(0,episodeShots.length-1)/pageSize)*pageSize);
 useEffect(()=>{
  if(!paginatedDirectory||!active)return;
  if(selectedShotIndex<safePageStart||selectedShotIndex>=safePageStart+pageSize)
   setPageStart(Math.floor(selectedShotIndex/pageSize)*pageSize);
 },[paginatedDirectory,active?.id,selectedShotIndex,safePageStart]);
 useEffect(()=>{
  if(!useScopedDirectory||!projectId||!nodeId||!activeEpisode)return;
  let current=true;
  const abort=new AbortController();
  setServerPage(null);setPageError("");
  const path=`/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/revision-scope?`+
   `nodeId=${encodeURIComponent(nodeId)}&draft=true&episodeId=${encodeURIComponent(activeEpisode)}`+
   `&offset=${safePageStart}&limit=${pageSize}`;
  void canvasApi<{total:number;entries:DramaShot[]}>(path,"GET",undefined,abort.signal)
   .then(result=>{if(current)setServerPage({episodeId:activeEpisode,offset:safePageStart,
    entries:result.entries,total:result.total});})
   .catch(error=>{if(current)setPageError(error instanceof Error?error.message:"按页读取失败");});
  return ()=>{current=false;abort.abort();};
 },[useScopedDirectory,projectId,nodeId,activeEpisode,safePageStart,casRefresh,shots]);
 const localPage=episodeShots.slice(safePageStart,safePageStart+pageSize);
 // Full creative drafts are still hydrated when opening the workspace. Until
 // true lazy editing lands, they are the authoritative view of pending local
 // structural changes. Server pagination can only be displayed if it exactly
 // agrees with this snapshot; otherwise it may hide newly inserted shots.
 // An empty storyboard has no active episode. A null page and an undefined
 // episode would otherwise compare equal before we access page.offset.
 const serverPageMatches=Boolean(serverPage&&serverPage.episodeId===activeEpisode&&
  serverPage.offset===safePageStart&&serverPage.total===episodeShots.length&&
  serverPage.entries.length===localPage.length&&
  serverPage.entries.every((shot,index)=>JSON.stringify(shot)===JSON.stringify(localPage[index])));
 const directoryShots=paginatedDirectory?(serverPageMatches&&serverPage?serverPage.entries:localPage):episodeShots;
 const changePage=(offset:number)=>{
  if(navigationLocked)return;
  const next=Math.max(0,Math.min(Math.floor(Math.max(0,episodeShots.length-1)/pageSize)*pageSize,offset));
  setPageStart(next);const shot=episodeShots[next];if(shot)chooseShot(shot.id);
 };
 if(!active)return <fieldset disabled={disabled} data-storyboard-editor-layout={expanded?"expanded":"compact"}
  className="min-w-0 rounded-xl border p-4" style={{...card,colorScheme:appearance}}>
  <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
   <div className="min-w-0 flex-1 space-y-2">
    <p className="text-sm font-semibold">{groups.length?"当前剧集暂无镜头":"尚无可编辑的分镜"}</p>
    <p className="text-xs" style={caption}>{groups.length?"可添加一个空白镜头，逐项填写内容。":"请先在剧集规划中确认剧集，再添加镜头。"}</p>
    {groups.length>0&&<select aria-label="选择分镜剧集" value={activeEpisode}
      className="min-w-0 max-w-full rounded-lg border px-2.5 py-2 text-xs"
      style={fieldStyle} onChange={event=>chooseEpisode(event.target.value)}>
      {groups.map(id=><option key={id} value={id}>{episodes.find(item=>item.id===id)?.title||id}</option>)}
    </select>}
   </div>
   <button type="button" className={smallAction} style={card} onClick={addShot}
    disabled={!activeEpisode||casBusy} aria-label="添加镜头"><Plus size={14} aria-hidden="true"/>添加镜头</button>
  </div>
 </fieldset>;
 const deleteStale=Boolean(pendingDelete&&(
  pendingDelete.shotId!==active.id||pendingDelete.episodeId!==active.episodeId||
  pendingDelete.snapshot!==JSON.stringify(active)));
 const deleteShot=()=>{
  if(disabled||casBusy||!pendingDelete||deleteStale)return;
  const index=episodeShots.findIndex(item=>item.id===active.id);
  const nextSelected=episodeShots[index+1]??episodeShots[index-1];
  const nextOrder=new Map(episodeShots.filter(shot=>shot.id!==active.id)
   .map((shot,index)=>[shot.id,index+1]));
  setShotId(nextSelected?.id??"");onShotChange?.(nextSelected?.id??"");
  setPendingDelete(null);
  onChange(shots.filter(shot=>shot.id!==active.id).map(shot=>{
   const order=nextOrder.get(shot.id);
   return order!==undefined&&order!==shot.order?{...shot,order}:shot;
  }));
 };
 const write=(next:DramaShot):void|Promise<void>=>{
  if(!scopedCas||!onPatchShot)return onChange(shots.map(shot=>shot.id===active.id?next:shot));
  if(casBusy||!shotDigest||shotDigest.id!==active.id)throw Error("正在同步当前镜头，请完成后再保存");
  const fields=["description","shotSize","camera","action","dialogue","durationSec",
   "sequenceId","sceneId","sceneVariantId","characterVariantIds","propIds","keyPropIds"] as const;
  const changes:Record<string,unknown>={};
  for(const key of fields){
   if(JSON.stringify(active[key])!==JSON.stringify(next[key]))
    changes[key]=next[key]===undefined?null:next[key];
  }
  if(!Object.keys(changes).length)return;
  setCasBusy(true);setCasError("");
  return onPatchShot(active.id,shotDigest.digest,changes)
   .then(()=>{setCasRefresh(value=>value+1);})
   .catch(error=>{
    const message=error instanceof Error?error.message:"保存失败";
    setCasError(message.includes("drama_candidate_conflict")?
     "镜头草案已被其他操作修改，未覆盖服务器数据。请重新加载后检查。":message);
    throw Error(message.includes("drama_candidate_conflict")?"镜头内容已发生冲突，请重新加载后编辑":message);
   })
   .finally(()=>setCasBusy(false));
 };
 const patch=<K extends keyof DramaShot>(key:K,value:DramaShot[K])=>write({...active,[key]:value});
 const optional=(key:"shotSize"|"camera"|"action"|"dialogue"|"sequenceId"|"sceneVariantId",value:string)=>{
  const next={...active};
  if(value.trim())next[key]=value;
  else delete next[key];
  return write(next);
 };
 const fieldLocked=disabled||navigationLocked||(scopedCas&&(!shotDigest||casBusy||shotDigest.id!==active.id));

 const scenes=assets.filter(item=>item.kind==="scene");
 const characters=assets.filter(item=>item.kind==="character");
 const props=assets.filter(item=>item.kind==="prop");
 const characterOptions:Choice[]=characters.flatMap(item=>[
  {value:item.id,label:item.name+(item.variants?.length?" · 默认":"")},
  ...(item.variants??[]).map(variant=>({value:variant.id,label:item.name+" · "+variant.name}))]);
 const propOptions:Choice[]=props.map(item=>({value:item.id,label:item.name}));
 const keyPropOptions=propOptions.filter(item=>active.propIds.includes(item.value));
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
 return <fieldset disabled={disabled} data-storyboard-editor-layout={expanded?"expanded":"compact"} data-shot-directory-view={expanded?directoryView:undefined}
  className={expanded?
   "grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(116px,0.28fr)_minmax(0,1fr)] gap-3 lg:grid-rows-[minmax(0,1fr)] "+(cards?"lg:grid-cols-[minmax(0,55%)_minmax(0,1fr)]":"lg:grid-cols-[minmax(0,30%)_minmax(0,1fr)]"):
   "grid min-w-0 gap-3"}
  style={{color:theme.node.text,colorScheme:appearance}}>
  {expanded?<aside aria-label="镜头目录" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border" style={card}>
   <div className="grid shrink-0 gap-2 border-b p-3" style={{borderColor:theme.node.stroke}}>
    <div className="flex flex-wrap items-center justify-between gap-2">
     <span className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold">
      <Clapperboard size={15} style={caption}/>镜头目录
     </span>
     <div className="flex flex-wrap items-center gap-1.5">
      <div role="group" aria-label="镜头目录显示方式" className="flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5" style={card}>
       {(["list","cards"] as const).map(mode=>{const Icon=mode==="list"?List:LayoutGrid;const label=mode==="list"?"列表视图":"卡片视图";return <button key={mode} type="button" aria-label={label} title={label} aria-pressed={directoryView===mode} disabled={disabled||navigationLocked||casBusy} className="grid size-7 place-items-center rounded-md hover:opacity-80 disabled:opacity-40" style={directoryView===mode?{background:theme.toolbar.activeBg,color:theme.toolbar.activeText}:caption} onClick={()=>setDirectoryView(mode)}><Icon size={15}/></button>;})}
      </div>
      <span className="rounded-md px-2 py-1 text-[11px] font-medium tabular-nums"
       style={{background:theme.toolbar.activeBg,color:theme.node.muted}}>{episodeShots.length} 镜</span>
      <button type="button" title="添加镜头" aria-label="添加镜头"
       className={smallAction} style={card} onClick={addShot} disabled={disabled||casBusy||navigationLocked}>
       <Plus size={13} aria-hidden="true"/>添加
      </button>
     </div>
    </div>
    <label className="grid min-w-0 gap-1 text-xs" style={caption}>当前剧集
     <select aria-label="选择分镜剧集" className="w-full min-w-0 rounded-lg border px-2.5 py-2 text-xs"
      style={fieldStyle} disabled={navigationLocked} value={activeEpisode} onChange={event=>chooseEpisode(event.target.value)}>
      {groups.map(id=><option key={id} value={id}>{episodes.find(item=>item.id===id)?.title||id}</option>)}
     </select>
    </label>
   </div>
   {navigationLocked&&<p role="status" className="shrink-0 px-3 py-1 text-[11px]" style={caption}>请先确认或取消视频输入模式编辑，再切换镜头。</p>}
   <nav aria-label="分镜镜头导航" className={"thin-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 "+(cards?"grid grid-cols-4 content-start gap-2":"flex flex-col gap-1")} data-canvas-no-zoom="">
    {directoryShots.map((shot,index)=>{
     const current=shot.id===active.id;
     const globalIndex=paginatedDirectory?safePageStart+index:index;
     return <button type="button" key={shot.id} aria-pressed={current}
      aria-label={`选择镜头 ${globalIndex+1}：${shot.shotSize||shot.id}`}
      disabled={navigationLocked} onClick={()=>chooseShot(shot.id)}
      className={"flex w-full min-w-0 shrink-0 rounded-lg border text-left transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 "+(cards?"flex-col gap-1.5 p-1.5":"items-start gap-2.5 px-3 py-3")}
      style={current?{background:theme.toolbar.activeBg,color:theme.node.text,
       borderColor:cards?theme.node.activeStroke:theme.node.stroke,outlineColor:theme.node.activeStroke}:
       {background:cards?theme.node.panel:"transparent",color:theme.node.text,borderColor:cards?theme.node.stroke:"transparent",
        outlineColor:theme.node.activeStroke}}>
      {cards&&<DramaAssetDirectoryPreview storageKey={shotDirectoryCover(production?.[shot.id])} theme={theme} aspect="16/9" emptyLabel="暂无画面图" loadingLabel="画面图"/>}
      <span className={cards?"flex w-full min-w-0 items-center gap-1":"contents"}>
      <span className="mt-0.5 shrink-0 text-[11px] font-semibold tabular-nums" style={caption}>
       {String(globalIndex+1).padStart(2,"0")}
      </span>
      <span className="min-w-0 flex-1">
       <span className="block truncate text-xs font-semibold">{summary(shot)}</span>
       {!cards&&<span className="mt-1 block truncate text-[11px]" style={caption}>{shot.description?.trim()||"暂无画面描述"}</span>}
      </span>
      {current&&<span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full"
       style={{background:theme.node.activeStroke}}/>}
      </span>
      {cards&&<span className="w-full min-w-0 truncate text-[11px]" style={caption}>{shot.description?.trim()||"暂无画面描述"}</span>}
      {videoStatusFor&&<span className="max-w-full shrink-0 truncate rounded-md border px-1.5 py-0.5 text-[10px]" style={{borderColor:theme.node.stroke,color:theme.node.muted}}>{videoStatusFor(shot)}</span>}
     </button>;
    })}
   </nav>
   {paginatedDirectory&&<div data-drama-scoped-directory="" className="shrink-0 space-y-1.5 border-t px-3 py-2"
     style={{borderColor:theme.node.stroke}}>
    <div className="flex items-center justify-between gap-2 text-[11px]" style={caption}>
     <span>{safePageStart+1}–{Math.min(safePageStart+pageSize,episodeShots.length)} / {episodeShots.length} 镜头</span>
     <span>每页 {pageSize} 镜</span>
    </div>
    <div className="flex items-center gap-2">
     <button type="button" className={smallAction+" flex-1"} style={card}
      disabled={navigationLocked||safePageStart===0} onClick={()=>changePage(safePageStart-pageSize)}>上一页</button>
     <button type="button" className={smallAction+" flex-1"} style={card}
      disabled={navigationLocked||safePageStart+pageSize>=episodeShots.length}
      onClick={()=>changePage(safePageStart+pageSize)}>下一页</button>
    </div>
    {pageError&&<p role="status" className="break-words text-[11px]" style={caption}>
     分页服务不可用，已使用当前加载的草案目录：{pageError}
    </p>}
   </div>}
  </aside>:
   <div className="grid grid-cols-2 gap-2">
    <label className="grid min-w-0 gap-1 text-xs">剧集
     <select className="w-full min-w-0 rounded-lg border px-3 py-2" style={fieldStyle}
      disabled={navigationLocked} value={activeEpisode} onChange={event=>chooseEpisode(event.target.value)}>
      {groups.map(id=><option key={id} value={id}>{episodes.find(item=>item.id===id)?.title||id}</option>)}
     </select>
    </label>
    <label className="grid min-w-0 gap-1 text-xs">镜头
     <select className="w-full min-w-0 rounded-lg border px-3 py-2" style={fieldStyle}
      disabled={navigationLocked} value={active.id} onChange={event=>chooseShot(event.target.value)}>
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
    <div className="flex shrink-0 flex-wrap items-center gap-2">
     <span className="rounded-lg border px-2 py-1 text-[11px] tabular-nums" style={card}>
      {active.durationSec??"—"} 秒 · {episodeShots.length} 镜
     </span>
     <button type="button" aria-label={`删除镜头 ${selectedShotIndex+1}`}
      className={smallAction} style={card} disabled={disabled||casBusy||navigationLocked}
      onClick={()=>setPendingDelete({episodeId:active.episodeId,shotId:active.id,snapshot:JSON.stringify(active)})}>
      <Trash2 size={13} aria-hidden="true"/>删除镜头
     </button>
    </div>
   </header>}
   {expanded&&pendingDelete?.episodeId===active.episodeId&&pendingDelete.shotId===active.id&&
    <div role="alertdialog" aria-label={`确认删除镜头 ${selectedShotIndex+1}`}
     className="space-y-3 rounded-xl border p-3 sm:p-4"
     style={{...card,background:theme.toolbar.activeBg}}>
     <div className="flex items-start gap-2">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" style={caption}/>
      <div className="min-w-0 space-y-1">
       <p className="text-sm font-semibold">确定删除当前第 {selectedShotIndex+1} 个镜头？</p>
       <p className="text-xs leading-relaxed" style={caption}>
        删除仅影响当前分镜草案。其他镜头、已确认版本、视频配置和已生成媒体不会自动删除。
        如有视频配置引用此镜头，后续需自行检查。
       </p>
       {deleteStale&&<p role="alert" className="text-xs" style={caption}>
        镜头内容已变化，请取消后重新发起删除。
       </p>}
      </div>
     </div>
     <div className="flex flex-wrap justify-end gap-2">
      <button type="button" className={smallAction} style={card} onClick={()=>setPendingDelete(null)}>取消</button>
      <button type="button" aria-label={`确认删除镜头 ${selectedShotIndex+1}`}
       className={smallAction+" font-semibold"} disabled={deleteStale}
       style={{background:theme.node.text,color:theme.node.panel,borderColor:theme.node.stroke}}
       onClick={deleteShot}>确认删除</button>
     </div>
    </div>}
   {episode?.targetDurationSec&&<p className="text-xs" style={caption}>
    当前剧集镜头时长合计 {duration} 秒 · 目标 {episode.targetDurationSec} 秒
   </p>}
   {scopedCas&&<div aria-label="当前镜头 CAS 状态" className="flex min-w-0 items-center justify-between gap-2 text-xs">
    {casError?<DramaInlineFeedback theme={theme} level="error" error={casError}/>:!shotDigest||casBusy?<DramaInlineFeedback theme={theme} level="info" pending>同步镜头版本中…</DramaInlineFeedback>:<span role="status" style={caption}>单镜头精确保存已启用</span>}
    {casError&&<button type="button" className={smallAction} style={card} disabled={casBusy}
     onClick={()=>{
      setCasBusy(true);
      void Promise.resolve().then(()=>onReloadShot?.()).then(()=>{
       setCasError("");setCasRefresh(value=>value+1);
      }).catch(error=>setCasError(error instanceof Error?error.message:"重新加载镜头失败"))
       .finally(()=>setCasBusy(false));
     }}>重新加载镜头内容</button>}
   </div>}
   <div className="grid min-w-0 gap-3 md:grid-cols-2">
    <ShotEditableField key={active.id+":duration"} id="duration" label="镜头时长（秒）"
     theme={theme} disabled={fieldLocked} type="number" placeholder="未设置"
     value={active.durationSec===undefined?"":String(active.durationSec)}
     onConfirm={value=>patch("durationSec",value.trim()?Number(value):undefined)}/>
    {(episode?.sequences?.length||active.sequenceId)?<ShotEditableField
     key={active.id+":sequence"} id="sequence" label="所属场次"
     theme={theme} disabled={fieldLocked} type="select" options={sceneSequenceOptions}
     value={active.sequenceId??""} placeholder="未指定场次"
     onConfirm={value=>optional("sequenceId",value)}/>:null}
    <div className="min-w-0 md:col-span-2">
     <ShotEditableField key={active.id+":description"} id="description" label="画面描述"
      theme={theme} disabled={fieldLocked} multiline rows={expanded?5:3}
      value={active.description} onConfirm={value=>patch("description",value)}/>
    </div>
    {([{key:"shotSize",label:"景别",rows:1},{key:"camera",label:"机位 / 运镜",rows:2},
      {key:"action",label:"动作",rows:3},{key:"dialogue",label:"对白",rows:3}] as const).map(field=>
     <ShotEditableField key={active.id+":"+field.key} id={field.key} label={field.label}
      theme={theme} disabled={fieldLocked} multiline rows={field.rows} value={active[field.key]??""}
      onConfirm={value=>optional(field.key,value)}/>)}
    <div role="group" aria-label="当前镜头人物、道具与场景" className="grid min-w-0 gap-3 md:col-span-2 md:grid-cols-2">
     <div className="min-w-0 md:col-span-2">
      <h4 className="text-xs font-semibold" style={caption}>当前镜头资产</h4>
     </div>
     <ShotAssetMultiField key={active.id+":characters"} id="characters" label="人物（角色造型）"
      value={active.characterVariantIds} options={characterOptions} theme={theme} disabled={fieldLocked}
      onConfirm={value=>patch("characterVariantIds",value)}/>
     <ShotEditableField key={active.id+":scene"} id="scene" label="场景"
      theme={theme} disabled={fieldLocked} type="select" options={sceneOptions}
      value={active.sceneId??""} placeholder="未指定场景"
      onConfirm={value=>{
       const next={...active};
       if(value)next.sceneId=value;
       else delete next.sceneId;
       // Changing the scene invalidates its variant, in the same explicit commit.
       delete next.sceneVariantId;
       return write(next);
      }}/>
     <ShotAssetMultiField key={active.id+":props"} id="props" label="可见道具"
      value={active.propIds} options={propOptions} theme={theme} disabled={fieldLocked}
      onConfirm={value=>write({...active,propIds:value,
       keyPropIds:active.keyPropIds.filter(id=>value.includes(id))})}/>
     <ShotAssetMultiField key={active.id+":keyProps"} id="keyProps" label="关键道具"
      value={active.keyPropIds} options={keyPropOptions} theme={theme} disabled={fieldLocked}
      onConfirm={value=>patch("keyPropIds",value)}/>
     {(scene?.variants?.length||active.sceneVariantId)?<ShotEditableField
      key={active.id+":sceneVariant"} id="sceneVariant" label="场景变体"
      theme={theme} disabled={fieldLocked} type="select" options={sceneVariants}
      value={active.sceneVariantId??""} placeholder="默认场景"
      onConfirm={value=>optional("sceneVariantId",value)}/>:null}
    </div>
   </div>
   {renderVideoConfig?.(active)}
  </div>
 </fieldset>;
}
