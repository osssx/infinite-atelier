import {useState} from "react";
import {Button} from "antd";
import type {CanvasTheme} from "@/lib/canvas-theme";
import type {DramaVideoConfigReview} from "./drama-video-config-review";
import type {DramaRefreshFields} from "./drama-video-config";
import {DramaInlineFeedback,useDramaFeedback} from "./drama-feedback";
import {dramaVideoFeedback} from "./drama-video-feedback";
import {dramaMediaModes} from "./drama-production-audit";
import {dramaNodeControl,dramaNodePrimary} from "./drama-node-style";

export function DramaVideoConfigReviewPanel({review,theme,disabled,onApply,onBusyChange}:{review:DramaVideoConfigReview;theme:CanvasTheme;disabled:boolean;
 onApply:(fields:DramaRefreshFields)=>void|Promise<void>;onBusyChange?:(value:boolean)=>void}){
 const [prompt,setPrompt]=useState(false),[duration,setDuration]=useState(false),[aspect,setAspect]=useState(false),[route,setRoute]=useState(false);
 const [overwrite,setOverwrite]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const feedback=useDramaFeedback()?.api;
 const control=dramaNodeControl(theme),muted={color:theme.node.muted};
 const changes=review.routeChanged||review.promptChanged||review.durationChanged&&review.durationEditable||review.aspectChanged&&review.aspectEditable||review.executionManual;
 const lock=disabled||busy;
 const selected=route||prompt||duration||aspect;
 const requireOverwrite=(prompt||route)&&review.promptManual||(route||duration||aspect)&&review.executionManual;
 const canApply=selected&&(!review.routeChanged||route)&&(!requireOverwrite||overwrite)&&(!review.executionManual||route||!duration&&!aspect);
 const mode=(value:string)=>dramaMediaModes.find(item=>item.id===value)?.label??"未设置";
 const switchRoute=(checked:boolean)=>{setRoute(checked);setPrompt(checked);setDuration(checked);setAspect(checked);setOverwrite(false);};
 const apply=async()=>{
  if(lock||!canApply)return;
  const task=feedback?.beginTask("正在更新视频配置","校验并保存所选更新",true);
  if(feedback&&!task)return;
  setBusy(true);onBusyChange?.(true);setError("");
  try{await onApply({prompt:route||prompt,duration:route||duration,aspect:route||aspect,references:route,overwrite,expectedReview:review.token});
   setPrompt(false);setDuration(false);setAspect(false);setRoute(false);setOverwrite(false);feedback?.notify("video-review","success","已更新视频配置");
  }catch(e){const reason=dramaVideoFeedback(e);setError(reason);feedback?.notify("video-review-error","error",reason);}
  finally{task?.end();setBusy(false);onBusyChange?.(false);}
 };
 const field=(label:string,changed:boolean,checked:boolean,change:(value:boolean)=>void,oldValue:string,newValue:string,editable=true)=>(
  <div className="rounded-md border p-2" style={control}>
   <label className="flex items-center gap-2"><input type="checkbox" checked={route||checked} disabled={lock||route||review.routeChanged||!changed||!editable}
    style={{accentColor:theme.node.activeStroke}} onChange={e=>change(e.target.checked)}/><strong>{label}</strong>
    <span className="ml-auto text-[11px]" style={muted}>{!editable?"模板未声明可编辑":changed?"有差异":"一致"}</span></label>
   <div className="mt-1 grid grid-cols-2 gap-2 text-xs"><div className="min-w-0 break-words"><span style={muted}>现有： </span>{oldValue}</div><div className="min-w-0 break-words"><span style={muted}>新设置： </span>{newValue}</div></div>
  </div>);
 return <details className="min-w-0 rounded-lg border p-2.5 text-xs" style={control} aria-label="视频配置差异审核">
  <summary className="cursor-pointer font-medium">审核已有配置 · {changes?"存在差异":"与当前设置一致"}</summary>
  <div className="mt-2 space-y-2">
   {review.routeChanged&&<DramaInlineFeedback theme={theme}>渠道或参考素材有变化。为保证工作流端口与参数一致，需要整体采用生成设置及提示词。</DramaInlineFeedback>}
   {review.executionManual&&<DramaInlineFeedback theme={theme}>已有生成设置或连线经过人工修改，或旧配置缺少完整基线。请仔细审核，额外连线不会自动删除。</DramaInlineFeedback>}
   <div className="rounded-md border p-2" style={control}>
    <label className="flex items-center gap-2"><input type="checkbox" checked={route} disabled={lock||!review.routeChanged&&!review.executionManual}
     onChange={e=>switchRoute(e.target.checked)} style={{accentColor:theme.node.activeStroke}}/><strong>渠道、输入模式与参考素材</strong><span className="ml-auto" style={muted}>{review.routeChanged?"有差异":"一致"}</span></label>
    <div className="mt-1 grid grid-cols-2 gap-2">
     <div><span style={muted}>现有：</span>{review.currentEngine} · {mode(review.currentMode)} · {review.currentCount} 张</div>
     <div><span style={muted}>新设置：</span>{review.nextEngine} · {mode(review.nextMode)} · {review.nextCount} 张</div>
    </div>
   </div>
   <div className="rounded-md border p-2" style={control}>
    <label className="flex items-center gap-2"><input type="checkbox" checked={route||prompt} disabled={lock||route||review.routeChanged||!review.promptChanged}
     style={{accentColor:theme.node.activeStroke}} onChange={e=>setPrompt(e.target.checked)}/><strong>视频提示词</strong><span className="ml-auto" style={muted}>{review.promptManual?"配置有人工修改":review.promptChanged?"有差异":"一致"}</span></label>
    {review.promptChanged&&<div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
     {[["现有提示词",review.currentPrompt],["新提示词",review.nextPrompt]].map(([label,value])=><div key={label} className="min-w-0"><span style={muted}>{label}</span><pre className="thin-scrollbar mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded p-2" style={{background:theme.toolbar.activeBg}}>{value}</pre></div>)}
    </div>}
   </div>
   {field("时长（秒）",review.durationChanged,duration,setDuration,review.currentDuration,review.nextDuration,review.durationEditable)}
   {field("画幅",review.aspectChanged,aspect,setAspect,review.currentAspect,review.nextAspect,review.aspectEditable)}
   {requireOverwrite&&<label className="flex items-center gap-2"><input type="checkbox" checked={overwrite} disabled={lock} onChange={e=>setOverwrite(e.target.checked)}/>确认覆盖所选字段中的人工修改</label>}
   {error&&<DramaInlineFeedback theme={theme} level="error">{error}</DramaInlineFeedback>}
   <div className="flex items-center justify-end gap-2"><Button size="small" style={dramaNodePrimary(theme)} disabled={lock||!canApply} loading={busy} onClick={()=>void apply()}>采用所选更新</Button></div>
  </div>
 </details>;
}
