import {useEffect,useRef,useState} from "react";
import {ImagePlus,ImageIcon,CheckCircle2,Pencil} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";
import {DramaImagePreview} from "./drama-reference-image-picker";
import {dramaReferencePolicy,type DramaReferencePolicy,type DramaReferencePolicies,type DramaVideoInput,type DramaShotProduction,type DramaVideoReferenceSlot} from "./drama-pipeline-media";
import {dramaProductionSettingFingerprint} from "./drama-video-production-resolver";
import type {WorkspacePendingRegistration} from "./drama-creative-workspace";
import {DramaEditActions} from "./drama-edit-actions";
import {useDramaFieldFeedback} from "./drama-feedback";
import {DramaInlineFeedback} from "./drama-feedback";
import {dramaVideoFeedback} from "./drama-video-feedback";

export type LocateVideoAsset=(assetId:string,variantId?:string)=>Promise<void>;
export function DramaVideoReferencePanel({input,setting,missingIds,theme,disabled,onLocate,onSettings,onChange,onPendingChange,onEditingChange,onWaitForSave}:{
 input:DramaVideoInput;setting:DramaShotProduction;missingIds:string[];theme:CanvasTheme;disabled:boolean;onLocate?:LocateVideoAsset;onSettings:()=>void;
 onChange?:(shotId:string,value:DramaShotProduction)=>void;onPendingChange?:WorkspacePendingRegistration;onEditingChange?:(value:boolean)=>void;onWaitForSave?:()=>Promise<void>;

}){
 const [error,setError]=useState(""),[busy,setBusy]=useState(false);
 const assetMode=setting.mode==="omni_reference"&&!setting.gridInput;
 const [draft,setDraft]=useState<{baseline:string;source:string;policies:DramaReferencePolicies}|null>(null);
 const [saving,setSaving]=useState(false);
 const savingRef=useRef(false),attempt=useRef<string|null>(null),commit=useRef<()=>Promise<void>>(async()=>{});
 const updated=useDramaFieldFeedback();
 const baseline=dramaProductionSettingFingerprint(setting);
 const source=JSON.stringify(input.referenceSlots);
 const policies=draft?.policies??setting.referencePolicies;
 const next={...setting};
 if(policies&&Object.keys(policies).length)next.referencePolicies=policies;else delete next.referencePolicies;
 const dirty=dramaProductionSettingFingerprint(next)!==baseline;
 const stale=!!draft&&(draft.source!==source||draft.baseline!==baseline&&attempt.current!==baseline);
 const pending=!!draft&&(dirty||!!attempt.current);
 const pendingKey="video-references:"+input.shot.id;
 commit.current=async()=>{
  if(!draft)return;
  if(disabled||!assetMode||!onChange||savingRef.current||stale){
   const reason="参考素材或生产设置已变化，请取消后重新编辑。";setError(reason);throw Error(reason);
  }
  savingRef.current=true;setSaving(true);setError("");
  try{
   if(dirty){attempt.current=dramaProductionSettingFingerprint(next);onChange(input.shot.id,next);}
   await onWaitForSave?.();
   if(dirty||attempt.current)updated("参考素材要求");
   setDraft(null);attempt.current=null;
  }catch(e){setError(dramaVideoFeedback(e));throw e;}
  finally{savingRef.current=false;setSaving(false);}
 };
 useEffect(()=>{onEditingChange?.(!!draft);return ()=>onEditingChange?.(false);},[!!draft,onEditingChange]);
 useEffect(()=>{onPendingChange?.(pendingKey,pending?()=>commit.current():null);return ()=>onPendingChange?.(pendingKey,null);},[pending,pendingKey,onPendingChange]);
 const changePolicy=(row:DramaVideoReferenceSlot,value:DramaReferencePolicy)=>{
  setDraft(old=>{
   if(!old)return old;
   const policies={...old.policies};
   if(value===(row.required?"required":"optional"))delete policies[row.id];
   else Object.defineProperty(policies,row.id,{value,enumerable:true,configurable:true,writable:true});
   return {...old,policies};
  });
 };
 const lock=disabled||saving||busy||stale;
 const policyLabel={required:"必需",optional:"可选",excluded:"不使用"};

 const labels={character:"角色",scene:"场景",prop:"道具"};
 const rows:DramaVideoReferenceSlot[]=assetMode?(input.referenceSlots??[
  ...input.referenceImages.map((ref,index)=>({id:ref.id,name:ref.name,kind:"prop" as const,required:false,imageKeys:ref.storageKey?[ref.storageKey]:[]})),
  ...missingIds.map((id,index)=>({id,name:"缺失参考素材 "+(index+1),kind:"prop" as const,required:true,imageKeys:[]}))
 ]):[];
 const frames=setting.gridInput?[{label:"分镜网格图",key:setting.gridImage}]:setting.mode==="first_last_frame"?[{label:"首帧",key:setting.firstFrame},{label:"尾帧",key:setting.lastFrame}]:setting.mode==="first_frame"?[{label:"首帧",key:setting.firstFrame}]:[];
 const missing=new Set(missingIds);
 const count=assetMode?new Set(rows.filter(row=>dramaReferencePolicy(row,policies)!=="excluded").flatMap(row=>row.imageKeys)).size:frames.filter(frame=>!!frame.key).length;
 const card={borderColor:theme.node.stroke,color:theme.node.text,background:theme.node.panel};
 const muted={color:theme.node.muted};
 const button="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1.5 text-xs disabled:opacity-40";
 const thumbnail=(key:string,label:string)=><div key={key} className="w-16 shrink-0"><DramaImagePreview image={{key,title:label}} theme={theme}/></div>;
 const locate=async(row:DramaVideoReferenceSlot)=>{
  if(!row.assetId||!onLocate||busy||disabled||draft)return;
  setError("");setBusy(true);
  try{await onLocate(row.assetId,row.variantId);}catch(e){setError(dramaVideoFeedback(e));}finally{setBusy(false);}
 };
 return <section aria-label="视频参考素材" className="min-w-0 space-y-2 text-xs">
  <div className="flex items-center gap-1.5"><strong>参考素材</strong>
   {assetMode&&input.referenceSlots?.length&&!draft&&<button type="button" aria-label="编辑参考素材要求" title="编辑参考素材要求" disabled={lock||!onChange} className="inline-grid size-7 place-items-center rounded-md disabled:opacity-45" style={muted} onClick={()=>{attempt.current=null;setError("");setDraft({baseline,source,policies:{...setting.referencePolicies}})}}><Pencil size={13}/></button>}
   <span className="ml-auto" style={muted}>参与生成 {count} 张图片</span></div>
  {draft&&<p style={muted}>必需：缺图阻止生成；可选：有图才使用；不使用：不传入图片。仅影响当前镜头。</p>}
  {draft&&<button type="button" disabled={lock} className="underline" style={muted} onClick={()=>setDraft(old=>old?{...old,policies:{}}:old)}>恢复默认要求</button>}
  {assetMode&&rows.map(row=>{
   const policy=dramaReferencePolicy(row,policies),required=policy==="required",absent=!row.imageKeys.length||missing.has(row.id);
   return <article key={row.id} className="flex min-w-0 items-start gap-3 rounded-lg border p-2.5" style={card}>
    <div className="flex max-w-[44%] shrink-0 flex-wrap gap-1.5">{row.imageKeys.length?row.imageKeys.map(key=>thumbnail(key,row.name)):
     <span className="grid size-16 place-items-center rounded-md border border-dashed" style={card}><ImagePlus size={20} style={muted}/></span>}</div>
    <div className="min-w-0 flex-1 space-y-1">
     <strong className="block break-words text-sm">{row.name}</strong>
     <div style={muted}>{labels[row.kind]}{row.variantName?" · "+row.variantName:""}{" · "+policyLabel[policy]}</div>
     <div className="flex items-center gap-1" style={muted}>{policy==="excluded"?"不参与生成":absent?(required?"缺少必需参考图":"未绑定可选参考图"):<><CheckCircle2 size={12}/>已绑定 {row.imageKeys.length} 张</>}</div>
    </div>
    {draft?<select aria-label={row.name+(row.variantName?" · "+row.variantName:"")+"参考图要求"} value={policy} disabled={lock} className="shrink-0 rounded-md border px-2 py-1.5 text-xs" style={card}
      onChange={e=>changePolicy(row,e.target.value as DramaReferencePolicy)}>
      <option value="required">必需</option><option value="optional">可选</option><option value="excluded">不使用</option>
     </select>:row.assetId&&onLocate&&<button type="button" className={button} style={card} disabled={disabled||busy} onClick={()=>void locate(row)}>{absent&&policy!=="excluded"?"前往补齐":"查看资产"}</button>}
   </article>;
  })}
  {frames.map(frame=><article key={frame.label} className="flex min-w-0 items-center gap-3 rounded-lg border p-2.5" style={card}>
   {frame.key?thumbnail(frame.key,frame.label):<span className="grid size-16 place-items-center rounded-md border border-dashed" style={card}><ImagePlus size={20} style={muted}/></span>}
   <div className="min-w-0 flex-1"><strong className="block text-sm">{frame.label}</strong><span style={muted}>{frame.key?"已绑定":"尚未选择图片"}</span></div>
   <button type="button" className={button} style={card} disabled={disabled} onClick={onSettings}>{frame.key?"更换图片":"选择图片"}</button>
  </article>)}
  {!assetMode&&!frames.length&&<div className="flex items-center gap-2 py-3" style={muted}><ImageIcon size={16}/>纯文本模式无需参考图片。</div>}
  {assetMode&&!rows.length&&<p style={muted}>当前镜头尚无资产参考素材，请检查分镜的资产绑定。</p>}
  {assetMode&&rows.some(row=>(!row.imageKeys.length||missing.has(row.id))&&dramaReferencePolicy(row,policies)==="required")&&<DramaInlineFeedback theme={theme}>请补齐必需参考图；可选素材不影响当前资产完整性检查。</DramaInlineFeedback>}
  {draft&&stale&&<DramaInlineFeedback theme={theme}>参考素材或生产设置已变化，请取消后重新编辑。</DramaInlineFeedback>}
  {draft&&<DramaEditActions theme={theme} label="参考素材要求" confirmText="保存" disabled={lock||!onChange}
    onCancel={()=>{if(!savingRef.current){setDraft(null);attempt.current=null;setError("");}}} onConfirm={()=>void commit.current().catch(()=>{})}/>}
  {draft&&saving&&<DramaInlineFeedback theme={theme} level="info" pending>正在保存参考素材要求…</DramaInlineFeedback>}
  {error&&<DramaInlineFeedback theme={theme} level="error">{error}</DramaInlineFeedback>}
 </section>;
}
