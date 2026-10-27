import type {CanvasConnection} from "@/types/canvas";
import type {ComfyWorkflowTemplate} from "./template-schema";

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

/** Fail before scheduling a GPU job if required media input is disconnected.
 * A template example filename must never be used as an implicit reference.
 */
export function missingComfyMediaInputs(template:ComfyWorkflowTemplate,workflowNodeId:string,
 connections:readonly CanvasConnection[]){
 return template.ports.filter(port=>port.direction==="target"&&port.inputBinding?.mode==="media-file"&&
  !connections.some(edge=>edge.toNodeId===workflowNodeId&&edge.toPortId===port.id));
}
