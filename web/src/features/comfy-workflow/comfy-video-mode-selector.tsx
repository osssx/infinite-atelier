import type {MediaModeId} from "@/services/media-capabilities";
import type {ComfyWorkflowTemplate} from "./template-schema";
const labels:Partial<Record<MediaModeId,string>>={text_to_video:"文生视频",first_frame:"首帧生成",last_frame:"尾帧生成",first_last_frame:"首尾帧生成",omni_reference:"全能参考"};
/** Explicit video mode is per canvas instance; undefined preserves auto assignment. */
export function ComfyVideoModeSelector({template,value,activeMode,onChange}:{template:ComfyWorkflowTemplate;value?:MediaModeId;activeMode?:MediaModeId;onChange:(mode:MediaModeId|undefined)=>void}){
 const useCase=template.mediaUseCase;
 const modes=useCase?.mediaCapabilities?.modes.filter(mode=>mode.enabled&&useCase.modeBindings?.[mode.id]&&labels[mode.id])??[];
 if(useCase?.channel!=="video"||modes.length<2)return null;
 const current=value??activeMode??useCase.mediaCapabilities?.defaultMode;
 const binding=current?useCase.modeBindings?.[current]:undefined;
 const promptPort=template.ports.find(port=>port.id===(binding?.promptPortId??useCase.promptPortId));
 const h3ReferencePrompt=promptPort?.inputBinding?.targets.some(target=>target.inputName==="prompt"&&template.apiGraph[target.nodeId]?.class_type==="MiniMaxH3ReferenceToVideo");
 const roleLabel=(role:"first_frame"|"last_frame")=>{
  const id=binding?.rolePorts?.[role]?.[0];
  return id?template.ports.find(port=>port.id===id)?.label:undefined;
 };
 const keyframeLabels=[roleLabel("first_frame")&&roleLabel("first_frame")+" → 首帧",roleLabel("last_frame")&&roleLabel("last_frame")+" → 尾帧"].filter(Boolean).join("；");
 return <div className="min-w-0 space-y-2" data-comfy-video-mode>
  <label className="block text-xs font-medium">生成模式
   <select aria-label="工作流生成模式" className="mt-1 block w-full min-w-0 rounded-lg border border-current/20 bg-transparent px-2 py-2 text-sm" style={{colorScheme:"inherit"}} value={value??""}
    onChange={event=>onChange(event.target.value?event.target.value as MediaModeId:undefined)}>
    <option value="">自动{activeMode&&labels[activeMode]?" · "+labels[activeMode]:""}</option>
    {modes.map(mode=><option key={mode.id} value={mode.id}>{labels[mode.id]}</option>)}
   </select>
  </label>
  {h3ReferencePrompt&&keyframeLabels?<p className="text-[11px] leading-4 opacity-70">{keyframeLabels}。请在自己的提示词中指明首尾帧用途，系统原样提交提示词；不保证像素级锁定。</p>:null}
 </div>;
}
