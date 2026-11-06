import {modelMatchesCapability,type AiConfig,type ModelCapability} from "@/stores/use-config-store";
import type {CanvasNodeData} from "@/types/canvas";
type WorkflowBinding=NonNullable<NonNullable<CanvasNodeData["metadata"]>["comfyMediaPreset"]>;
export function resolveComfyWorkflowSelection(config:AiConfig,node:CanvasNodeData|undefined,mode:ModelCapability):WorkflowBinding|undefined{
 if(mode==="text")return undefined;
 const metadata=node?.metadata;
 if(metadata?.comfyMediaPreset)return metadata.comfyMediaPreset;
 const modeBinding=metadata?.comfyWorkflowSelections?.[mode];
 if(modeBinding)return modeBinding;
 if(metadata?.model&&modelMatchesCapability(config,metadata.model,mode))return undefined;
 const fallback=config.comfyWorkflowDefaults?.[mode];
 return fallback?{...fallback,overrides:{},slots:{}}:undefined;
}
