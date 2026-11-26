import {useState} from "react";
import {ImagePlus,ImageIcon,CheckCircle2} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";
import {DramaImagePreview} from "./drama-reference-image-picker";
import type {DramaVideoInput,DramaShotProduction,DramaVideoReferenceSlot} from "./drama-pipeline-media";
import {DramaInlineFeedback} from "./drama-feedback";
import {dramaVideoFeedback} from "./drama-video-feedback";

export type LocateVideoAsset=(assetId:string,variantId?:string)=>Promise<void>;
export function DramaVideoReferencePanel({input,setting,missingIds,theme,disabled,onLocate,onSettings}:{
 input:DramaVideoInput;setting:DramaShotProduction;missingIds:string[];theme:CanvasTheme;disabled:boolean;onLocate?:LocateVideoAsset;onSettings:()=>void;
}){
 const [error,setError]=useState(""),[busy,setBusy]=useState(false);
 const assetMode=setting.mode==="omni_reference"&&!setting.gridInput;
 const labels={character:"角色",scene:"场景",prop:"道具"};
 const rows:DramaVideoReferenceSlot[]=assetMode?(input.referenceSlots??[
  ...input.referenceImages.map((ref,index)=>({id:ref.id,name:ref.name,kind:"prop" as const,required:false,imageKeys:ref.storageKey?[ref.storageKey]:[]})),
  ...missingIds.map((id,index)=>({id,name:"缺失参考素材 "+(index+1),kind:"prop" as const,required:true,imageKeys:[]}))
 ]):[];
 const frames=setting.gridInput?[{label:"分镜网格图",key:setting.gridImage}]:setting.mode==="first_last_frame"?[{label:"首帧",key:setting.firstFrame},{label:"尾帧",key:setting.lastFrame}]:setting.mode==="first_frame"?[{label:"首帧",key:setting.firstFrame}]:[];
 const missing=new Set(missingIds);
 const count=assetMode?new Set(rows.flatMap(row=>row.imageKeys)).size:frames.filter(frame=>!!frame.key).length;
 const card={borderColor:theme.node.stroke,color:theme.node.text,background:theme.node.panel};
 const muted={color:theme.node.muted};
 const button="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1.5 text-xs disabled:opacity-40";
 const thumbnail=(key:string,label:string)=><div key={key} className="w-16 shrink-0"><DramaImagePreview image={{key,title:label}} theme={theme}/></div>;
 const locate=async(row:DramaVideoReferenceSlot)=>{
  if(!row.assetId||!onLocate||busy||disabled)return;
  setError("");setBusy(true);
  try{await onLocate(row.assetId,row.variantId);}catch(e){setError(dramaVideoFeedback(e));}finally{setBusy(false);}
 };
 return <section aria-label="视频参考素材" className="min-w-0 space-y-2 text-xs">
  <div className="flex items-center justify-between gap-2"><strong>参考素材</strong><span style={muted}>已绑定 {count} 张图片</span></div>
  {assetMode&&rows.map(row=>{
   const required=row.required||missing.has(row.id),absent=!row.imageKeys.length||missing.has(row.id);
   return <article key={row.id} className="flex min-w-0 items-start gap-3 rounded-lg border p-2.5" style={card}>
    <div className="flex max-w-[44%] shrink-0 flex-wrap gap-1.5">{row.imageKeys.length?row.imageKeys.map(key=>thumbnail(key,row.name)):
     <span className="grid size-16 place-items-center rounded-md border border-dashed" style={card}><ImagePlus size={20} style={muted}/></span>}</div>
    <div className="min-w-0 flex-1 space-y-1">
     <strong className="block break-words text-sm">{row.name}</strong>
     <div style={muted}>{labels[row.kind]}{row.variantName?" · "+row.variantName:""}{required?" · 必需":" · 可选"}</div>
     <div className="flex items-center gap-1" style={muted}>{absent?(required?"缺少必需参考图":"未绑定可选参考图"):<><CheckCircle2 size={12}/>已绑定 {row.imageKeys.length} 张</>}</div>
    </div>
    {row.assetId&&onLocate&&<button type="button" className={button} style={card} disabled={disabled||busy} onClick={()=>void locate(row)}>{absent?"前往补齐":"查看资产"}</button>}
   </article>;
  })}
  {frames.map(frame=><article key={frame.label} className="flex min-w-0 items-center gap-3 rounded-lg border p-2.5" style={card}>
   {frame.key?thumbnail(frame.key,frame.label):<span className="grid size-16 place-items-center rounded-md border border-dashed" style={card}><ImagePlus size={20} style={muted}/></span>}
   <div className="min-w-0 flex-1"><strong className="block text-sm">{frame.label}</strong><span style={muted}>{frame.key?"已绑定":"尚未选择图片"}</span></div>
   <button type="button" className={button} style={card} disabled={disabled} onClick={onSettings}>{frame.key?"更换图片":"选择图片"}</button>
  </article>)}
  {!assetMode&&!frames.length&&<div className="flex items-center gap-2 py-3" style={muted}><ImageIcon size={16}/>纯文本模式无需参考图片。</div>}
  {assetMode&&!rows.length&&<p style={muted}>当前镜头尚无资产参考素材，请检查分镜的资产绑定。</p>}
  {assetMode&&rows.some(row=>!row.imageKeys.length&&row.required)&&<DramaInlineFeedback theme={theme}>请补齐必需参考图；可选素材不影响当前资产完整性检查。</DramaInlineFeedback>}
  {error&&<DramaInlineFeedback theme={theme} level="error">{error}</DramaInlineFeedback>}
 </section>;
}
