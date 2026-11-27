import type {CanvasNodeData,CanvasConnection} from "@/types/canvas";
import type {BackendCanvasGraph} from "./canvas-backend-sync";
import {canvasApi,type CanvasBackendProject} from "./canvas-api";

/** Read the authoritative graph and the same-revision view the canvas uses.
 * Lazy creative nodes are represented by creativePayloadRef in the editor,
 * whereas the normal GET hydrates all of their content. Keep expanded editors
 * expanded; never discard or substitute ordinary nodes, edges or metadata.
 * The hydrated graph is still used for generation source fingerprints.
 */
export async function readSavedCanvasGraph(projectId:string,local:BackendCanvasGraph,api:typeof canvasApi){
 const path="/api/v1/projects/"+encodeURIComponent(projectId);
 const lazyIds=new Set(local.nodes.filter(node=>node.metadata?.creativePayloadRef).map(node=>node.id));
 const remote=await api<CanvasBackendProject>(path);
 const asGraph=(doc:Record<string,unknown>):BackendCanvasGraph|null=>
  Array.isArray(doc.nodes)&&Array.isArray(doc.connections)?
   {nodes:doc.nodes as CanvasNodeData[],connections:doc.connections as CanvasConnection[]}:null;
 const hydrated=asGraph(remote.document);
 if(remote.id!==projectId||!Number.isSafeInteger(remote.revision)||!hydrated)return null;
 if(!lazyIds.size)return {remote,hydrated,projected:hydrated};
 // Do not compare incompatible snapshots if a worker or editor saved between
 // the reads. A later explicit generation can obtain the new revision.
 const compact=await api<CanvasBackendProject>(path+"?creative=summary");
 if(compact.id!==remote.id||compact.revision!==remote.revision)return null;
 const summary=asGraph(compact.document);
 if(!summary)return null;
 const compactById=new Map(summary.nodes.map(node=>[node.id,node]));
 const projected:BackendCanvasGraph={nodes:[],connections:hydrated.connections};
 for(const node of hydrated.nodes){
  if(!lazyIds.has(node.id)){projected.nodes.push(node);continue;}
  const compactNode=compactById.get(node.id);
  if(!compactNode?.metadata?.creativePayloadRef||compactNode.type!==node.type)return null;
  projected.nodes.push(compactNode);
 }
 return {remote:{...remote,document:{...remote.document,...projected}},hydrated,projected};
}
