import {useEffect,useState} from "react";
import {Check,ChevronLeft,ChevronRight,Image as ImageIcon,Plus,Search,X} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {canvasCasUrl} from "@/features/backend-sync/canvas-cas";
import {dramaNodeControl,dramaNodePrimary} from "./drama-node-style";

export type ReferenceImage={key:string;title:string};
const pageSize=24;
const button="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-1";

export function DramaImagePreview({image,theme,large=false}:{image:ReferenceImage;theme:CanvasTheme;large?:boolean}){
 const [failed,setFailed]=useState(false);
 const url=canvasCasUrl(image.key);
 return <span className={`relative grid w-full place-items-center overflow-hidden rounded-md ${large?"h-48":"aspect-[4/3]"}`}
  style={{background:theme.node.fill,color:theme.node.muted}}>
  {!failed&&url?<img src={url} alt={image.title} loading={large?"eager":"lazy"} decoding="async"
   className="absolute inset-0 size-full object-contain" onError={()=>setFailed(true)}/>:
   <span className="flex flex-col items-center gap-1 text-[11px]"><ImageIcon size={20}/>预览不可用</span>}
 </span>;
}

/** Scoped, inline image browser: no nested modal, no graph mutation until confirmed. */
export function DramaReferenceImagePicker({name,images,boundKeys,disabled,theme,onAdd,projectId,selectLabel,confirmLabel}:{
 name:string;images:ReferenceImage[];boundKeys:string[];disabled:boolean;theme:CanvasTheme;onAdd:(key:string)=>void;projectId?:string;selectLabel?:string;confirmLabel?:string;
}){
 const [open,setOpen]=useState(false),[query,setQuery]=useState(""),[page,setPage]=useState(0),[selectedKey,setSelectedKey]=useState("");
 const [times,setTimes]=useState<Record<string,number>>({});
 const [timeLoading,setTimeLoading]=useState(false);
 const [timeError,setTimeError]=useState(false);
 const imageKeys=images.map(image=>image.key).join(",");
 useEffect(()=>{
  if(!open||disabled||!projectId)return;
  const controller=new AbortController();
  setTimeLoading(true);setTimeError(false);setTimes({});
  void canvasApi<{images:{blobId:string;generatedAt:number}[]}>(`/api/v1/projects/${encodeURIComponent(projectId)}/image-generation-times`,"GET",undefined,controller.signal)
   .then(result=>{if(!controller.signal.aborted)setTimes(Object.fromEntries((result.images??[])
    .filter(item=>/^[a-f0-9]{64}$/.test(item.blobId)&&Number.isFinite(item.generatedAt))
    .map(item=>["cas:"+item.blobId,item.generatedAt])));})
   .catch(()=>{if(!controller.signal.aborted)setTimeError(true);})
   .finally(()=>{if(!controller.signal.aborted)setTimeLoading(false);});
  return ()=>controller.abort();
 },[open,disabled,projectId,imageKeys]);
 const control={...dramaNodeControl(theme),outlineColor:theme.node.activeStroke};
 const close=()=>{setOpen(false);setQuery("");setPage(0);setSelectedKey("");};
 useEffect(()=>{if(disabled){setOpen(false);setSelectedKey("");setQuery("");setPage(0);}},[disabled]);
 const bound=new Set(boundKeys);
 const unique=[...new Map(images.filter(image=>!bound.has(image.key)&&canvasCasUrl(image.key)).map(image=>[image.key,image])).values()]
  .sort((a,b)=>(times[b.key]??0)-(times[a.key]??0));
 const search=query.trim().toLocaleLowerCase();
 const matches=unique.filter(image=>image.title.toLocaleLowerCase().includes(search)||image.key.includes(search));
 const pageCount=Math.max(1,Math.ceil(matches.length/pageSize)),safePage=Math.min(page,pageCount-1);
 const selected=unique.find(image=>image.key===selectedKey);
 return <div className="min-w-0 flex-1 basis-52" data-drama-reference-picker="">
  <button type="button" aria-label={selectLabel??`添加${name}参考图`} aria-expanded={open&&!disabled}
   className={button+" w-full justify-start"} style={control} disabled={disabled}
   onClick={()=>{if(open)close();else setOpen(true);}}>
   <Plus size={14}/>{selectLabel??"从画布选择图片"}<span className="ml-auto text-[11px]" style={{color:theme.node.muted}}>{unique.length} 张</span>
  </button>
  {open&&!disabled&&<section aria-label={selectLabel?name+"图片选择器":`选择${name}参考图`} className="mt-2 min-w-0 space-y-2.5 rounded-lg border p-2.5" style={control}
   onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();close();}}}>
   <div className="flex items-center gap-2">
    <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2 py-1.5" style={{borderColor:theme.node.stroke}}>
     <Search size={14} style={{color:theme.node.muted}}/>
     <input aria-label="搜索画布图片" placeholder="搜索图片名称" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}
      className="min-w-0 flex-1 bg-transparent text-xs outline-none" style={{color:theme.node.text}}/>
    </label>
    <button type="button" className={button+" px-2"} style={control} aria-label="关闭图片选择" onClick={close}><X size={14}/></button>
   </div>
   <div className="flex items-center justify-between gap-2 text-[11px]" style={{color:theme.node.muted}}>
    <span>{matches.length} 张可选图片 · 最新生成优先</span><span>{selectLabel?"选择后确认":"已绑定图片不会重复显示"}</span>
   </div>
   {timeError&&<p role="status" className="text-[11px]" style={{color:theme.node.muted}}>无法读取生成时间，暂按画布顺序显示。</p>}
   <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,160px)]">
    <div role="group" aria-label="画布图片列表" tabIndex={0}
     className="thin-scrollbar grid max-h-[min(32dvh,288px)] min-w-0 grid-cols-[repeat(auto-fill,minmax(92px,1fr))] content-start gap-2 overflow-y-auto overscroll-contain pr-1"
     style={{scrollbarColor:`${theme.node.code.scrollbar} transparent`,outlineColor:theme.node.activeStroke}}>
     {timeLoading&&<p role="status" className="col-span-full py-4 text-center text-xs" style={{color:theme.node.muted}}>正在读取生成时间…</p>}
     {!timeLoading&&matches.slice(safePage*pageSize,(safePage+1)*pageSize).map(image=><button type="button" key={image.key}
      aria-label={`选择图片 ${image.title}`} aria-pressed={selectedKey===image.key} title={image.title}
      className="relative min-w-0 rounded-lg border p-1 text-left focus-visible:outline focus-visible:outline-1"
      style={{...control,borderColor:selectedKey===image.key?theme.node.activeStroke:theme.node.stroke,background:selectedKey===image.key?theme.toolbar.activeBg:theme.node.panel}}
      onClick={()=>setSelectedKey(image.key)}>
      <DramaImagePreview image={image} theme={theme}/>
      {selectedKey===image.key&&<span className="absolute right-1 top-1 grid size-5 place-items-center rounded-full" style={dramaNodePrimary(theme)}><Check size={12}/></span>}
      <span className="block truncate px-1 py-1 text-[11px]">{image.title}</span>
     </button>)}
     {!timeLoading&&!matches.length&&<p className="col-span-full py-5 text-center text-xs" style={{color:theme.node.muted}}>{unique.length?"没有匹配的图片":images.length?"所有可用图片均已绑定":"画布中暂无可用图片"}</p>}
    </div>
    {selected?<div className="min-w-0 space-y-1 rounded-lg border p-1.5" style={{borderColor:theme.node.stroke}}>
     <DramaImagePreview key={selected.key} image={selected} theme={theme} large/>
     <p className="break-words text-xs" style={{color:theme.node.text}}>{selected.title}</p>
    </div>:<div className="hidden min-h-24 items-center justify-center rounded-lg border border-dashed p-2 text-center text-xs sm:flex" style={{borderColor:theme.node.stroke,color:theme.node.muted}}>选择图片查看预览</div>}
   </div>
   <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2" style={{borderColor:theme.node.stroke}}>
    <div className="flex items-center gap-1 text-xs" style={{color:theme.node.muted}}>
     <button type="button" className={button+" px-1.5"} style={control} aria-label="图片上一页" disabled={safePage===0} onClick={()=>setPage(safePage-1)}><ChevronLeft size={13}/></button>
     {safePage+1}/{pageCount}
     <button type="button" className={button+" px-1.5"} style={control} aria-label="图片下一页" disabled={safePage>=pageCount-1} onClick={()=>setPage(safePage+1)}><ChevronRight size={13}/></button>
    </div>
    <div className="flex items-center gap-1.5">
     <button type="button" className={button} style={control} onClick={close}>取消</button>
     <button type="button" className={button} style={dramaNodePrimary(theme)} disabled={!selected||disabled} onClick={()=>{if(selected&&!disabled){onAdd(selected.key);close();}}}><Check size={13}/>{confirmLabel??"添加参考图"}</button>
    </div>
   </div>
  </section>}
 </div>;
}
