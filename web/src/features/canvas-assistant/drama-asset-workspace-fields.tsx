import {useEffect,useRef,useState,type ReactNode} from "react";
import {Box,ChevronLeft,ChevronRight,LayoutGrid,List,Mountain,Pencil,Plus,Trash2,UserRound} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";
import {dramaAssetSlots,type DramaAsset,type DramaAssetKind,type DramaAssetReference} from "./canvas-drama-pipeline";
import {useAssetDirectory} from "./drama-asset-directory-state";
import type {WorkspacePendingRegistration} from "./drama-creative-workspace";
import {DramaEditActions} from "./drama-edit-actions";
import {sameAssetEntry,type AssetEntryPatch} from "./drama-asset-entry-save";
import {collectDramaAssetUsage,type DramaAssetUsage} from "./drama-asset-usage-display";
import {DramaAssetUsageTags} from "./drama-asset-usage-tags";
import {assetDirectoryImages,DramaAssetDirectoryPreview} from "./drama-asset-directory-preview";
const kinds={character:"角色",scene:"场景",prop:"道具"} as const;
const icons={character:UserRound,scene:Mountain,prop:Box};
const pageSize=10;
type Field="name"|"description"|"aliases";
type Edit={assetId:string;variantId?:string;field:Field;baseline:string;entry:DramaAsset;value:string;label:string};
const button="inline-flex min-h-8 shrink-0 items-center justify-center gap-1 rounded-lg border px-2.5 text-xs font-medium hover:opacity-80 disabled:opacity-40";
const fieldClass="thin-scrollbar w-full min-w-0 rounded-lg border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2";
export function DramaAssetWorkspaceFields({assets,theme,disabled,onChange,renderReferences,references=[],usage={},onPendingChange,onEditingChange,onPatchAsset,onReloadAsset,loading=false}:{
 assets:DramaAsset[];theme:CanvasTheme;disabled:boolean;expanded?:boolean;onChange?:(next:DramaAsset[])=>void;
 renderReferences?:(asset:DramaAsset,variantId?:string)=>ReactNode;references?:readonly DramaAssetReference[];usage?:DramaAssetUsage;
 onPendingChange?:WorkspacePendingRegistration;onEditingChange?:(editing:boolean)=>void;
 onPatchAsset?:(baseline:DramaAsset,changes:AssetEntryPatch,variantId?:string)=>Promise<void>;
 onReloadAsset?:()=>Promise<void>;loading?:boolean;
}){
 const [{kind,activeId,query,page,view="list"},setDirectory]=useAssetDirectory();
 const cards=view==="cards";
 const setKind=(kind:DramaAssetKind)=>setDirectory(current=>({...current,kind}));
 const setActiveId=(activeId:string)=>setDirectory(current=>({...current,activeId}));
 const setQuery=(query:string)=>setDirectory(current=>({...current,query}));
 const setPage=(page:number)=>setDirectory(current=>({...current,page}));
 const [edit,setEdit]=useState<Edit|null>(null);
 const [deletion,setDeletion]=useState<{assetId:string;variantId?:string}|null>(null);
 const [error,setError]=useState("");
 const [saving,setSaving]=useState(false);
 const flight=useRef<Promise<void>|null>(null);
 const control={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke,outlineColor:theme.node.activeStroke};
 const selected={...control,background:theme.toolbar.activeBg,color:theme.toolbar.activeText};
 const rows=assets.filter(a=>a.kind===kind&&[a.name,...(a.aliases??[])].some(name=>name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
 const maxPage=Math.max(0,Math.ceil(rows.length/pageSize)-1),safePage=Math.min(page,maxPage);
 const pageRows=rows.slice(safePage*pageSize,(safePage+1)*pageSize);
 const active=(edit?(assets.find(a=>a.id===edit.assetId)??edit.entry):undefined)??pageRows.find(a=>a.id===activeId)??pageRows[0];
 const variants=active?.variants??[];
 const slots=active?dramaAssetSlots([active]):[];
 const locked=disabled||loading||saving||!onChange||!!edit;
 const referenceSlot=(a:DramaAsset,variantId?:string)=>{
  if(!renderReferences||!slots.some(slot=>slot.assetId===a.id&&slot.variantId===variantId))return null;
  return <fieldset disabled={locked} data-asset-reference-slot={variantId??a.id}
   className="min-w-0 space-y-2 border-0 p-0 disabled:opacity-75">
   {renderReferences(a,variantId)}
  </fieldset>;
 };
 const valueFor=(a:DramaAsset,field:Field,variantId?:string)=>{
  if(variantId){const variant=a.variants?.find(v=>v.id===variantId);return variant&&field!=="aliases"?variant[field]:undefined;}
  return field==="aliases"?(a.aliases??[]).join("\n"):a[field];
 };
 const latest=useRef({assets,onChange,disabled,edit,onPatchAsset,loading});latest.current={assets,onChange,disabled,edit,onPatchAsset,loading};
 const save=():Promise<void>=>{
  if(flight.current)return flight.current;
  const run=async()=>{
   const {assets:current,onChange:change,disabled:busy,edit:pending,onPatchAsset:patchAsset,loading:hydrating}=latest.current;
   if(!pending)return;
   if(busy||hydrating||!change)throw Error("当前资产不可编辑");
   const a=current.find(item=>item.id===pending.assetId);
   if(!a||!sameAssetEntry(a,pending.entry))throw Error("资产内容已更新，请取消并重新编辑");
   if(pending.value!==pending.baseline){
    if(patchAsset&&pending.field!=="aliases"){
     await patchAsset(pending.entry,{[pending.field]:pending.value},pending.variantId);
    }else{
     const patch=pending.field==="aliases"?{aliases:pending.value.split("\n").map(x=>x.trim()).filter(Boolean).slice(0,64)}:{[pending.field]:pending.value};
     change(current.map(item=>item.id!==a.id?item:pending.variantId?{...item,variants:item.variants?.map(v=>v.id===pending.variantId?{...v,...patch}:v)}:{...item,...patch}));
    }
   }
   // Keep search and page on normal saves. Only reset search if the edited
   // name/aliases no longer match, so the same asset stays selected.
   const names=pending.field==="name"&&!pending.variantId?[pending.value,...(a.aliases??[])]:
    pending.field==="aliases"?[a.name,...pending.value.split("\n")]:[a.name,...(a.aliases??[])];
   setDirectory(dir=>{
    const matches=names.some(name=>name.toLocaleLowerCase().includes(dir.query.trim().toLocaleLowerCase()));
    const nextQuery=matches?dir.query:"";
    const filtered=current.filter(item=>item.kind===a.kind&&(item.id===a.id||[item.name,...(item.aliases??[])].some(name=>name.toLocaleLowerCase().includes(nextQuery.trim().toLocaleLowerCase()))));
    const index=filtered.findIndex(item=>item.id===a.id);
    return {...dir,activeId:a.id,query:nextQuery,page:Math.max(0,Math.floor(index/pageSize))};
   });
   setEdit(null);setError("");
  };
  setSaving(true);setError("");
  const promise=run().finally(()=>{flight.current=null;setSaving(false);});flight.current=promise;return promise;
 };
 const saveRef=useRef(save);saveRef.current=save;
 useEffect(()=>{onEditingChange?.(!!edit);return ()=>onEditingChange?.(false);},[!!edit,onEditingChange]);
 const pendingKey=edit?"asset:"+edit.assetId+":"+(edit.variantId??"base")+":"+edit.field:"";
 useEffect(()=>{
  if(!onPendingChange||!pendingKey)return;
  onPendingChange(pendingKey,edit&&edit.value!==edit.baseline?()=>saveRef.current():null);
  return ()=>onPendingChange(pendingKey,null);
 },[pendingKey,edit?.value,edit?.baseline,onPendingChange]);
 const useCount=(a:DramaAsset,variantId?:string)=>collectDramaAssetUsage(usage,variantId?[variantId]:[a.id,...(a.variants??[]).map(v=>v.id)]);
 const add=()=>{
  if(locked)return;
  const id=kind+"_"+crypto.randomUUID();
  const a:DramaAsset={id,kind,name:"",description:"",sourceRefs:[],...(kind==="character"?{variants:[{id:"outfit_"+crypto.randomUUID(),name:"默认造型",description:""}]}:{})};
  onChange?.([...assets,a]);setQuery("");setPage(Math.floor(assets.filter(x=>x.kind===kind).length/pageSize));setActiveId(id);setDeletion(null);
 };
 const field=(a:DramaAsset,key:Field,label:string,variantId?:string)=>{
  const value=valueFor(a,key,variantId)??"";
  const editing=edit?.assetId===a.id&&edit.field===key&&edit.variantId===variantId;
  const beginEdit=()=>{setDeletion(null);setError("");setEdit({assetId:a.id,variantId,field:key,label,baseline:value,value,entry:structuredClone(a)});};
  if(key==="aliases"&&!editing){
   const aliases=(a.aliases??[]).filter(name=>name.trim());
   return <section data-asset-field="aliases" data-asset-field-mode="reading" className="flex min-w-0 flex-wrap items-center gap-1.5">
    {aliases.length>0&&<>
     <span className="shrink-0 text-xs" style={{color:theme.node.muted}}>别名</span>
     {aliases.map((name,index)=><span key={index} data-asset-alias-tag="" className="max-w-full break-words rounded-md border px-2 py-0.5 text-xs leading-relaxed"
      style={{background:theme.toolbar.activeBg,borderColor:theme.node.stroke,color:theme.node.text}}>{name}</span>)}
    </>}
    <button type="button" aria-label={aliases.length?"编辑别名":"添加别名"} title={aliases.length?"编辑别名":"添加别名"}
     className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:opacity-80 disabled:opacity-40"
     style={{color:theme.node.muted}} disabled={locked} onClick={beginEdit}>
     {aliases.length?<Pencil size={13}/>:<><Plus size={13}/>添加别名</>}
    </button>
   </section>;
  }
  return <section data-asset-field={key} data-asset-field-mode={editing?"editing":"reading"} className={editing?"space-y-2 rounded-xl border p-3":"min-w-0 space-y-1.5"}
   style={editing?{background:theme.node.fill,borderColor:theme.node.stroke}:undefined}>
   <div className="flex items-center gap-1 text-xs font-medium" style={{color:theme.node.muted}}>
    {label}{!editing&&<button type="button" aria-label={"编辑"+label} className="grid size-7 place-items-center rounded-md hover:opacity-80" disabled={locked}
     onClick={beginEdit}><Pencil size={13}/></button>}
   </div>
   {editing?<>
    {key==="name"?<input aria-label={label} className={fieldClass} style={control} maxLength={240} value={edit.value} disabled={disabled||saving||loading} onChange={e=>setEdit({...edit,value:e.target.value})}/>:
     <textarea aria-label={label} rows={key==="description"?5:3} maxLength={key==="description"?12000:20000} className={fieldClass+" resize-y"} style={control} value={edit.value} disabled={disabled||saving||loading} onChange={e=>setEdit({...edit,value:e.target.value})}/>}
    {!saving&&!sameAssetEntry(a,edit.entry)&&<p role="alert" className="text-xs">内容已更新，请取消并重新编辑。</p>}
    {saving&&<p role="status" className="text-xs">正在保存资产草案…</p>}
    {error&&<p role="alert" className="text-xs">{error}</p>}
    <DramaEditActions theme={theme} label={label} disabled={disabled||saving||loading||!assets.some(item=>item.id===a.id)||!sameAssetEntry(a,edit.entry)}
     onCancel={()=>{if(!flight.current){setEdit(null);setError("");}}} onConfirm={()=>void save().catch(e=>setError(e instanceof Error?e.message:"保存失败"))}/>
   </>:<div className="min-w-0 whitespace-pre-wrap break-words rounded-md border-l-2 px-3 py-2.5 text-sm leading-relaxed" style={{background:theme.toolbar.activeBg,borderColor:theme.node.stroke,color:value.trim()?theme.node.text:theme.node.muted}}>{value.trim()||"未填写"}</div>}
  </section>;
 };
 const deleteControl=(a:DramaAsset,variantId?:string)=>{
  const label=variantId?"变体":"资产",inUse=useCount(a,variantId).length>0;
  const confirming=deletion?.assetId===a.id&&deletion.variantId===variantId;
  return confirming?<div className="flex flex-wrap items-center gap-2 text-xs">
   <span>从当前草案删除{label}？</span>
   <button className={button} style={control} type="button" onClick={()=>setDeletion(null)}>取消</button>
   <button className={button} style={control} type="button" disabled={locked||inUse} onClick={()=>{
    onChange?.(variantId?assets.map(x=>x.id===a.id?{...x,variants:x.variants?.filter(v=>v.id!==variantId)}:x):assets.filter(x=>x.id!==a.id));setDeletion(null);
   }}>确认删除</button></div>:
   <button type="button" className={button} style={control} aria-label={"删除"+label} title={inUse?"已知分镜引用此条目，暂不可删除":"从草案删除"} disabled={locked||inUse} onClick={()=>setDeletion({assetId:a.id,variantId})}><Trash2 size={13}/></button>;
 };
 return <div data-asset-workspace-fields="" data-asset-workspace-view="editor" data-asset-directory-view={view} className={"grid min-h-0 min-w-0 flex-1 gap-3 md:grid-rows-[minmax(0,1fr)] "+(cards?"md:grid-cols-[minmax(0,55%)_minmax(0,1fr)]":"md:grid-cols-[minmax(0,30%)_minmax(0,1fr)]")}>
  <aside aria-label="资产目录" className="flex min-h-0 min-w-0 flex-col gap-3 rounded-xl border p-3" style={control}>
   <div className="flex items-center justify-between gap-2"><strong className="shrink-0 text-sm">资产目录</strong><div className="flex flex-wrap items-center justify-end gap-1.5"><div role="group" aria-label="资产目录显示方式" className="flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5" style={control}>
    {(["list","cards"] as const).map(mode=>{const Icon=mode==="list"?List:LayoutGrid;const label=mode==="list"?"列表视图":"卡片视图";return <button key={mode} type="button" aria-label={label} title={label} aria-pressed={view===mode} disabled={locked} className="grid size-7 place-items-center rounded-md hover:opacity-80 disabled:opacity-40" style={view===mode?selected:{color:theme.node.muted}} onClick={()=>setDirectory(current=>({...current,view:mode}))}><Icon size={15}/></button>;})}
   </div><button type="button" aria-label="添加资产" className={button} style={control} disabled={locked} onClick={add}><Plus size={14}/>添加</button></div></div>
   <div role="group" aria-label="资产类别" className="grid shrink-0 grid-cols-3 gap-1.5">
    {(Object.keys(kinds) as DramaAssetKind[]).map(k=>{const Icon=icons[k];return <button key={k} type="button" aria-pressed={kind===k} disabled={locked} onClick={()=>{setKind(k);setActiveId("");setPage(0);setQuery("");setDeletion(null);}}
     className="flex min-w-0 flex-col items-center gap-1 rounded-md border p-1.5 text-[11px] disabled:opacity-50" style={kind===k?selected:control}><Icon size={14}/>{kinds[k]} {assets.filter(a=>a.kind===k).length}</button>;})}
   </div>
   <input aria-label="搜索资产" placeholder="搜索名称或别名" className={fieldClass+" text-xs"} style={control} value={query} disabled={locked}
    onChange={e=>{setQuery(e.target.value);setPage(0);setActiveId("");setDeletion(null);}}/>
   <div data-asset-directory-list="" className={"thin-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain py-0.5 "+(cards?"grid max-h-64 grid-cols-3 content-start gap-2 md:max-h-none":"flex max-h-56 flex-col gap-1.5 md:max-h-[52dvh]")}>
    {pageRows.map(a=>{
     const name=a.name||"未命名"+kinds[kind],isSelected=a.id===active?.id;
     const images=cards?assetDirectoryImages(a,references):undefined;
     return <button type="button" key={a.id} aria-pressed={isSelected} disabled={locked} onClick={()=>{setActiveId(a.id);setDeletion(null);}}
      className={cards?"flex min-w-0 flex-col gap-1.5 rounded-lg border p-1.5 text-left text-xs disabled:opacity-50":"flex min-h-9 w-full min-w-0 shrink-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs disabled:opacity-50"}
      style={isSelected?(cards?{...selected,borderColor:theme.node.activeStroke}:selected):control} title={name}>
      {images?<><DramaAssetDirectoryPreview storageKey={images.cover} theme={theme}/><span className="flex w-full min-w-0 items-center gap-1 px-1"><span className="min-w-0 flex-1 truncate">{name}</span>{isSelected&&<ChevronRight size={13}/>}</span>
       <span className="px-1 pb-0.5 text-[11px]" style={{color:isSelected?theme.toolbar.activeText:theme.node.muted}}>{images.count} 张参考图</span></>:
       <><span className="min-w-0 flex-1 truncate">{name}</span>{isSelected&&<ChevronRight size={13}/>}</>}
     </button>;
    })}
    {!rows.length&&<p className="col-span-full p-2 text-xs" style={{color:theme.node.muted}}>暂无{kinds[kind]}{query?"匹配项":""}</p>}
   </div>
   <div className="flex items-center justify-between gap-2 text-xs"><span>{rows.length} 项</span><div className="flex items-center gap-1">
    <button type="button" aria-label="资产上一页" className={button} style={control} disabled={locked||safePage===0} onClick={()=>{setPage(safePage-1);setActiveId(rows[(safePage-1)*pageSize]?.id??"");setDeletion(null);}}><ChevronLeft size={13}/></button>
    <span>{safePage+1}/{maxPage+1}</span><button type="button" aria-label="资产下一页" className={button} style={control} disabled={locked||safePage===maxPage} onClick={()=>{setPage(safePage+1);setActiveId(rows[(safePage+1)*pageSize]?.id??"");setDeletion(null);}}><ChevronRight size={13}/></button>
   </div></div>
  </aside>
  <section aria-label="当前资产编辑区" className="thin-scrollbar min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain rounded-xl border p-3 sm:p-5" style={control}>
   {loading&&!edit?<p role="status" className="text-xs">正在加载资产草案…</p>:active?<><header className="flex items-center justify-between gap-2"><strong className="truncate">{active.name||"未命名"+kinds[kind]}</strong>{deleteControl(active)}</header>
    {onReloadAsset&&!edit&&<button type="button" className={button} style={control} disabled={disabled||loading||saving} onClick={()=>void onReloadAsset().catch(e=>setError(e instanceof Error?e.message:"刷新失败"))}>重新加载资产</button>}
    {!edit&&error&&<p role="alert" className="text-xs">{error}</p>}
    {edit&&!assets.some(a=>a.id===edit.assetId)&&!loading&&!saving&&<p role="alert" className="text-xs">资产已不存在，请取消编辑。</p>}
    <div className="min-w-0 space-y-2">{field(active,"name","名称")}{field(active,"aliases","别名（每行一个）")}</div>
    {field(active,"description","资产描述")}
    <DramaAssetUsageTags entries={useCount(active)} theme={theme}/>
    {referenceSlot(active)}
    {kind!=="prop"&&<div data-asset-variant-group="" className="min-w-0 space-y-3 pt-3">
     <div className="flex items-center justify-between gap-2"><strong className="text-sm">{kind==="character"?"角色造型":"场景变体"} · {variants.length}</strong>
      <button type="button" className={button} style={control} disabled={locked||variants.length>=32} onClick={()=>onChange?.(assets.map(a=>a.id===active.id?{...a,variants:[...variants,{id:"variant_"+crypto.randomUUID(),name:"",description:""}]}:a))}><Plus size={13}/>添加{kind==="character"?"造型":"变体"}</button></div>
     {variants.map((variant,index)=><section key={variant.id} className="space-y-3 rounded-lg border p-3" style={control}>
      <div className="flex items-center justify-between gap-2"><strong className="text-xs">{variant.name||"未命名变体"}</strong>{deleteControl(active,variant.id)}</div>
      {field(active,"name","变体 "+(index+1)+" 名称",variant.id)}
      {field(active,"description","变体 "+(index+1)+" 描述",variant.id)}
      {referenceSlot(active,variant.id)}
     </section>)}
    </div>}
    {kind==="prop"&&variants.map(variant=><div key={variant.id}>{referenceSlot(active,variant.id)}</div>)}
   </>:<p className="text-xs" style={{color:theme.node.muted}}>请选择或添加资产，也可生成资产候选。</p>}
  </section>
 </div>;
}
