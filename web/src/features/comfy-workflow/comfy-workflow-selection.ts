import {modelMatchesCapability,type AiConfig,type ModelCapability} from "@/stores/use-config-store";
import type {CanvasNodeData} from "@/types/canvas";
type WorkflowBinding=NonNullable<NonNullable<CanvasNodeData["metadata"]>["comfyMediaPreset"]>;
export function resolveComfyWorkflowSelection(config:AiConfig,node:CanvasNodeData|undefined,mode:ModelCapability):WorkflowBinding|undefined{
 if(mode==="text")return undefined;
 const metadata=node?.metadata;
 if(metadata?.comfyMediaPreset)return metadata.comfyMediaPreset;
 const modeBinding=metadata?.comfyWorkflowSelections?.[mode];
 if(modeBinding)return modeBinding;
 // A storyboard-derived Config with an explicit model must never silently
 // switch to a global Comfy workflow if its channel is later removed.
 if(metadata?.model&&(mode==="video"&&metadata.dramaShotId||modelMatchesCapability(config,metadata.model,mode)))return undefined;
 const fallback=config.comfyWorkflowDefaults?.[mode];
 return fallback?{...fallback,overrides:{},slots:{}}:undefined;
}
