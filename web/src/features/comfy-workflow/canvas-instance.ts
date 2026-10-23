import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

/** Migrate the old workflow-node instance selection only if the entire canvas agreed on one. */
export function resolveCanvasComfyInstance(project: Pick<CanvasProject,"comfyInstanceId"|"nodes">):string|undefined {
    if(project.comfyInstanceId)return project.comfyInstanceId;
    const ids=new Set(project.nodes
        .map(n=>n.type==="comfy:workflow"?n.metadata?.comfyWorkflow?.instanceId:undefined)
        .filter((id):id is string=>typeof id==="string"&&id.length>0));
    return ids.size===1?[...ids][0]:undefined;
}
