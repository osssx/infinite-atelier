import type {CanvasConnection} from "@/types/canvas";
import type {ComfyWorkflowTemplate} from "./template-schema";
import type {MediaModeId} from "@/services/media-capabilities";

/** Shared UI projection of SQLite-backed ComfyUI runs and captured artifacts.
 * This is not a browser submission client. All execution uses JobCoordinator.
 */
export type ComfyRunArtifact={
 artifactId:string;runId:string;workflowNodeId:string;portId:string;
 kind:"image"|"video"|"audio"|"text";index:number;filename?:string;
 metadata?:{width?:number;height?:number;durationMs?:number;fps?:number;sampleRate?:number;channels?:number};
 mimeType:string;sha256:string;byteSize:number;url:string;
};
export type ComfyRunState={
 runId:string;status:string;promptId?:string|null;error?:string|null;
 workflowNodeId:string;artifacts:ComfyRunArtifact[];
};
export type ComfyInstance={id:string;url:string;reachable:boolean;classTypes:string[]};

/** Explicit mode rules supersede required flags on their mapped media slots.
 * Other optional media is handled by the compiler's absent policy.
 * Template sample filenames are never considered uploaded input.
 */
export function missingComfyMediaInputs(template:ComfyWorkflowTemplate,workflowNodeId:string,
 connections:readonly CanvasConnection[],modeId?:MediaModeId){
 const connected=new Set(connections.filter(edge=>edge.toNodeId===workflowNodeId).map(edge=>edge.toPortId));
 const useCase=template.mediaUseCase;
 const mode=useCase?.mediaCapabilities?.modes.find(item=>item.id===modeId&&item.enabled);
 const binding=mode&&useCase?.modeBindings?.[mode.id];
 const requiredByMode=new Set<string>();
 const modeSlots=new Set(binding?useCase?.slots.map(slot=>slot.id):[]);
 if(mode&&binding)for(const rule of mode.inputs){
  const ids=binding.rolePorts?.[rule.role]??[];
  const count=ids.filter(id=>connected.has(id)).length;
  for(const id of ids.filter(id=>!connected.has(id)).slice(0,Math.max(0,rule.minItems-count)))requiredByMode.add(id);
 }
 return template.ports.filter(port=>port.direction==="target"&&
  (requiredByMode.has(port.id)||(!modeSlots.has(port.id)&&port.required===true))&&
  ["IMAGE","MASK","VIDEO","AUDIO"].includes(port.valueKind)&&
  ["media-file","socket"].includes(port.inputBinding?.mode??"")&&!connected.has(port.id));
}
