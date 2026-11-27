import type {MediaModeId} from "@/services/media-capabilities";
import type {ComfyWorkflowTemplate} from "./template-schema";

import {comfyModeLabels,comfyRoleLabels} from "./comfy-media-mode-config";

export function ComfyGenerationModeControl({template,value,activeMode,onChange,disabled=false}:{template:ComfyWorkflowTemplate;value?:MediaModeId;activeMode?:MediaModeId;onChange:(value:MediaModeId|undefined)=>void;disabled?:boolean}){
 const useCase=template.mediaUseCase;
 const modes=useCase?.mediaCapabilities?.modes.filter(mode=>mode.enabled&&useCase.modeBindings?.[mode.id])??[];
 if(!modes.length)return null;
 const selected=value??activeMode;
 const binding=selected?useCase?.modeBindings?.[selected]:undefined;
 const frameRoles=(["first_frame","last_frame"] as const).flatMap(role=>(binding?.rolePorts?.[role]??[]).map(id=>({role,label:template.ports.find(port=>port.id===id)?.label??id})));
 return <div className="mb-3 space-y-1.5" data-comfy-generation-mode>
  <label className="block text-xs font-medium">生成模式
   <select aria-label="生成模式" className="mt-1 w-full rounded-lg border border-current/20 bg-transparent px-2 py-2 text-sm" value={value??""} disabled={disabled}
    onChange={event=>{const next=event.target.value;onChange(modes.find(mode=>mode.id===next)?.id);}}>
    <option value="">自动（按参考素材选择{!value&&activeMode?" · "+comfyModeLabels[activeMode]:""}）</option>
    {value&&!modes.some(mode=>mode.id===value)?<option value={value} disabled>当前模式不可用</option>:null}
    {modes.map(mode=><option key={mode.id} value={mode.id}>{comfyModeLabels[mode.id]}</option>)}
   </select>
  </label>
  {frameRoles.length?<p className="text-[11px] opacity-70">{frameRoles.map(({role,label})=>comfyRoleLabels[role]+"："+label).join("；")}。如工作流需要提示词指示，请使用自己的提示词；不会自动添加提示词。</p>:null}
 </div>;
}
