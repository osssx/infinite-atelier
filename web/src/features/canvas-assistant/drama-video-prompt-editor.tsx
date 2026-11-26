import {useEffect,useRef,useState} from "react";
import {Copy,Pencil,RotateCcw} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";
import type {DramaShotProduction} from "./drama-pipeline-media";
import type {WorkspacePendingRegistration} from "./drama-creative-workspace";
import {dramaProductionSettingFingerprint,validateDramaVideoPrompt} from "./drama-video-production-resolver";
import {DramaEditActions} from "./drama-edit-actions";
import {DramaInlineFeedback,useDramaFeedback,useDramaFieldFeedback} from "./drama-feedback";

type Draft={baseline:string;source:string;text:string;restore:boolean};
export function DramaVideoPromptEditor({shotId,setting,automaticPrompt,promptSourceFingerprint,theme,disabled,onChange,onPendingChange,onEditingChange,onWaitForSave,existing}:{
 shotId:string;setting:DramaShotProduction;automaticPrompt:string;promptSourceFingerprint:string;theme:CanvasTheme;disabled:boolean;
 onChange?:(id:string,value:DramaShotProduction)=>void;onPendingChange?:WorkspacePendingRegistration;
 onEditingChange?:(editing:boolean)=>void;onWaitForSave?:()=>Promise<void>;existing:boolean;
}){
 const [draft,setDraft]=useState<Draft|null>(null),[saving,setSaving]=useState(false),[error,setError]=useState("");
 const busy=useRef(false),attempt=useRef<string|null>(null),commit=useRef<()=>Promise<void>>(async()=>{});
 const updated=useDramaFieldFeedback();
 const baseline=dramaProductionSettingFingerprint(setting);
 const current=setting.promptOverride?.text??automaticPrompt;
 const feedback=useDramaFeedback()?.api;
 const [copying,setCopying]=useState(false),[copyStatus,setCopyStatus]=useState("");
 const copyText=draft?.text??current;
 useEffect(()=>{setCopyStatus("");},[copyText]);
 const copy=async()=>{
  if(copying||!copyText.trim())return;
  setCopying(true);setCopyStatus("");
  try{
   await navigator.clipboard.writeText(copyText);
   if(feedback)feedback.notify("video-prompt-copy:"+shotId,"success","视频提示词已复制");
   else setCopyStatus("已复制");
  }catch{
   if(feedback)feedback.notify("video-prompt-copy:"+shotId,"warning","复制失败，请检查剪贴板权限后重试");
   else setCopyStatus("复制失败，请检查剪贴板权限");
  }finally{setCopying(false);}
 };

 const outdated=!!setting.promptOverride&&setting.promptOverride.sourceFingerprint!==promptSourceFingerprint;
 const stale=!!draft&&(draft.source!==promptSourceFingerprint||draft.baseline!==baseline&&attempt.current!==baseline);
 const dirty=!!draft&&(draft.restore?!!setting.promptOverride:draft.text!==current||outdated);
 let validation="";
 if(draft)try{validateDramaVideoPrompt(draft.text,!draft.restore);}catch(e){validation=e instanceof Error?e.message:"提示词无效";}
 const pendingKey="video-prompt:"+shotId;
 commit.current=async()=>{
  if(!draft)return;
  if(disabled||busy.current||!onChange||stale||validation){
   const reason=validation||"当前提示词或分镜来源已变化，请取消后重新编辑。";
   setError(reason);throw Error(reason);
  }
  busy.current=true;setSaving(true);setError("");
  try{
   const next={...setting};
   if(draft.restore)delete next.promptOverride;
   else if(dirty)next.promptOverride={text:draft.text,sourceFingerprint:promptSourceFingerprint};
   const fingerprint=dramaProductionSettingFingerprint(next);
   if(fingerprint!==baseline){attempt.current=fingerprint;onChange(shotId,next);}
   await onWaitForSave?.();
   if(dirty||attempt.current)updated("视频提示词");
   setDraft(null);attempt.current=null;
  }catch(e){setError(e instanceof Error?e.message:"保存视频提示词失败");throw e;}
  finally{busy.current=false;setSaving(false);}
 };
 useEffect(()=>{onEditingChange?.(!!draft);return ()=>onEditingChange?.(false);},[!!draft,onEditingChange]);
 // Keep a failed persistence attempt registered even if the optimistic value
 // already matches; a later save must still wait for persistence.
 const pending=!!draft&&(dirty||!!attempt.current);
 useEffect(()=>{onPendingChange?.(pendingKey,pending?()=>commit.current():null);
  return ()=>onPendingChange?.(pendingKey,null);
 },[pendingKey,pending,onPendingChange]);
 const start=(restore=false)=>{attempt.current=null;setError("");setDraft({baseline,source:promptSourceFingerprint,text:restore?automaticPrompt:current,restore});};
 const card={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
 const muted={color:theme.node.muted};
 return <section aria-label="视频提示词" data-video-prompt-editor={draft?"editing":"reading"} className="min-w-0 space-y-2">
  <div className="flex min-h-7 items-center gap-1.5 text-xs">
   <strong>视频提示词</strong>
   {!draft&&<button type="button" aria-label="编辑视频提示词" title="编辑视频提示词" disabled={disabled||!onChange}
    className="inline-grid size-7 place-items-center rounded-md hover:opacity-80 disabled:opacity-45" style={muted} onClick={()=>start()}><Pencil size={13}/></button>}
   <button type="button" aria-label="复制视频提示词" title={draft?"复制当前编辑内容":"复制视频提示词"} disabled={copying||!copyText.trim()}
    className="inline-grid size-7 place-items-center rounded-md hover:opacity-80 disabled:opacity-45" style={muted} onClick={()=>void copy()}><Copy size={13} aria-hidden="true"/></button>
   {copyStatus&&<span role="status" style={muted}>{copyStatus}</span>}
   <span className="ml-auto" style={muted}>{draft?"编辑中":setting.promptOverride?"已手动修改":"自动生成"}</span>
  </div>
  {outdated&&<DramaInlineFeedback theme={theme}>分镜、影片风格或输入模式已有更新，已保留人工提示词。请核对最新自动提示词。</DramaInlineFeedback>}
  {draft?<div className="space-y-2">
   <textarea aria-label="视频提示词" rows={12} value={draft.text} disabled={disabled||saving||stale}
    className="w-full min-w-0 resize-y rounded-lg border px-3 py-2.5 text-sm leading-relaxed"
    style={{...card,outlineColor:theme.node.activeStroke}}
    onChange={event=>setDraft(old=>old?{...old,text:event.target.value,restore:false}:old)}/>
   <div className="flex items-center justify-between gap-2 text-[11px]" style={muted}>
    <span>{draft.restore?"确认后恢复自动生成":"完整文字提示词，参考图片由素材绑定管理"}</span>
    <span className="shrink-0 tabular-nums">{draft.text.length} / 24000</span>
   </div>
   {(validation||error)&&<DramaInlineFeedback theme={theme} level="error" error={validation||error}/>}
   {stale&&<DramaInlineFeedback theme={theme}>编辑期间分镜来源或生产设置已变化，请取消后重新编辑。</DramaInlineFeedback>}
   {saving&&<DramaInlineFeedback theme={theme} level="info" pending>正在保存视频提示词…</DramaInlineFeedback>}
   <DramaEditActions theme={theme} label="视频提示词" confirmText="保存" disabled={disabled||saving||stale||!!validation||!onChange}
    onCancel={()=>{if(!busy.current){setDraft(null);attempt.current=null;setError("");}}} onConfirm={()=>void commit.current().catch(()=>{})}/>
  </div>:<>
   <pre className="thin-scrollbar max-h-96 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 text-sm" style={{...card,background:theme.toolbar.activeBg}}>{current}</pre>
   {setting.promptOverride&&<div className="flex justify-end"><button type="button" disabled={disabled||!onChange}
    className="inline-flex min-h-7 items-center gap-1 rounded-md border px-2 text-xs disabled:opacity-45" style={card} onClick={()=>start(true)}>
    <RotateCcw size={12}/>恢复自动生成</button></div>}
  </>}
  {setting.promptOverride&&outdated&&<details className="text-xs">
   <summary className="cursor-pointer" style={muted}>查看最新自动提示词</summary>
   <pre className="thin-scrollbar max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3" style={card}>{automaticPrompt}</pre>
  </details>}
  {existing&&<p className="text-[11px]" style={muted}>修改仅保存到镜头生产设置，不会自动覆盖已创建的视频配置。</p>}
 </section>;
}
