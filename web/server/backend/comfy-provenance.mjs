import {ARTIFACT_KINDS} from "./contracts.mjs";
/** Server-side materialization adapter for the existing CanvasNodeMetadata.comfyArtifact contract.
 * The workflowNodeId is the canvas source node, not a Comfy API graph node.
 */
export function makeComfyArtifactProvenance({runId,artifactId,workflowNodeId,portId,kind,index}){
 if(![runId,artifactId,workflowNodeId,portId].every(v=>typeof v==="string"&&v.length>0)
    ||!ARTIFACT_KINDS.includes(kind)||!Number.isSafeInteger(index)||index<0)
   throw Error("invalid_comfy_artifact_provenance");
 return {runId,artifactId,workflowNodeId,portId,kind,index};
}
export function attachComfyArtifactMetadata(metadata,artifact){
 return {...metadata,comfyArtifact:makeComfyArtifactProvenance(artifact)};
}
