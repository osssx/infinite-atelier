import type {BackendCanvasGraph} from "./canvas-backend-sync";

/** Mirrors backend/repository.mjs fingerprintSource, using the saved JSON view.
 * Fingerprints only upstream ancestors and all typed edges into the target.
 * Never include browser-only undefined properties or transient canvas state.
 */
function stableJson(value:unknown):string{
 if(Array.isArray(value))return "["+value.map(stableJson).join(",")+"]";
 if(value!==null&&typeof value==="object"){
  return "{"+Object.keys(value).sort().map(key=>
   JSON.stringify(key)+":"+stableJson((value as Record<string,unknown>)[key])).join(",")+"}";
 }
 if(value===undefined)throw Error("undefined_in_frozen_snapshot");
 return JSON.stringify(value);
}
export function canonicalBackendGraph(graph:BackendCanvasGraph):string{
 return stableJson(JSON.parse(JSON.stringify({nodes:graph.nodes,connections:graph.connections})));
}
// Exactly mirrors repository.mjs generationNode; unknown metadata is never ignored.
const PRESENTATION_META=new Set(["status","errorDetails","comfyExecution","videoTask",
 "videoDownloadError","skillTrace","skillMetrics","interactive","groupId",
 "fontSize","freeResize"]);
function generationNode(node:BackendCanvasGraph["nodes"][number]){
 const {title,position,width,height,metadata,...rest}=node;
 if(!metadata)return rest;
 const safe:Record<string,unknown>={...metadata};
 for(const key of PRESENTATION_META)delete safe[key];
 if(safe.comfyWorkflow&&typeof safe.comfyWorkflow==="object"){
  safe.comfyWorkflow={...safe.comfyWorkflow};
  delete (safe.comfyWorkflow as Record<string,unknown>).lastRunId;
  delete (safe.comfyWorkflow as Record<string,unknown>).bindingState;
 }
 if(safe.comfyMediaPreset&&typeof safe.comfyMediaPreset==="object"){
  safe.comfyMediaPreset={...safe.comfyMediaPreset};
  delete (safe.comfyMediaPreset as Record<string,unknown>).lastRunId;
 }
 if(Array.isArray(safe.images))safe.images=safe.images.map((image:Record<string,unknown>)=>{
  const {status,errorDetails,...stable}=image;return stable;
 });
 return Object.keys(safe).length?{...rest,metadata:safe}:rest;
}
/** Mirrors repository.mjs: previously generated media/text is a frozen input snapshot. */
function isMaterializedGenerationResource(node:BackendCanvasGraph["nodes"][number]):boolean{
 const kind=node.type,meta=node.metadata;
 if(!["text","image","video","audio"].includes(kind)||!meta)return false;
 return typeof meta.content==="string"&&meta.content.length>0||
  kind==="text"&&typeof meta.prompt==="string"&&meta.prompt.length>0||
  kind==="image"&&Array.isArray(meta.images)&&meta.images.some(image=>
   typeof image?.content==="string"&&image.content.length>0&&
   typeof image?.storageKey==="string"&&image.storageKey.length>0);
}
export async function fingerprintBackendSource(graph:BackendCanvasGraph,targetNodeId:string):Promise<string>{
 const doc=JSON.parse(canonicalBackendGraph(graph)) as BackendCanvasGraph;
 const byId=new Map(doc.nodes.map(node=>[node.id,node]));
 if(byId.size!==doc.nodes.length||!byId.has(targetNodeId))throw Error("stale_generation_source");
 const parents=new Map<string,typeof doc.connections>();
 for(const edge of doc.connections){
  if(!byId.has(edge.fromNodeId)||!byId.has(edge.toNodeId))throw Error("stale_generation_source");
  const list=parents.get(edge.toNodeId)??[];
  list.push(edge);parents.set(edge.toNodeId,list);
 }
 const ids=new Set<string>(),visiting=new Set<string>(),incoming:Array<Record<string,unknown>>=[];
 const visit=(id:string)=>{
  if(visiting.has(id))throw Error("cyclic_generation_source");
  if(ids.has(id))return;
  visiting.add(id);
   // Read saved ancestor contents without re-entering their provenance chain.
   if(id===targetNodeId||!isMaterializedGenerationResource(byId.get(id)!)){
    for(const edge of parents.get(id)??[]){const {id:_edgeId,...stableEdge}=edge;incoming.push(stableEdge);visit(edge.fromNodeId)}
    const target=byId.get(id)!;
    const slotBindings=[target.metadata?.comfyMediaPreset,...Object.values(target.metadata?.comfyWorkflowSelections??{})].filter(Boolean);
    const slots=Object.assign({},...slotBindings.map(binding=>binding?.slots??{})) as Record<string,{nodeId:string;imageId?:string}>;
    for(const [slotId,ref] of Object.entries(slots)){
     if(!ref||typeof ref.nodeId!=="string"||!byId.has(ref.nodeId))throw Error("stale_generation_source");
     const source=byId.get(ref.nodeId)!;
     incoming.push({fromNodeId:ref.nodeId,fromPortId:source.type,toNodeId:id,toPortId:slotId,mediaAssetId:ref.imageId??null});
     if(ref.nodeId!==id)visit(ref.nodeId);
    }
   }
   visiting.delete(id);ids.add(id);
 };
 visit(targetNodeId);
 const nodes=[...ids].sort().map(id=>generationNode(byId.get(id)!));
 const edges=incoming.map(({id,...edge})=>edge);
 edges.sort((a,b)=>{
  const left=stableJson(a),right=stableJson(b);
  return left<right?-1:left>right?1:0;
 });
 const bytes=new TextEncoder().encode(stableJson({nodes,incoming:edges}));
 const hash=await crypto.subtle.digest("SHA-256",bytes);
 return "v2:"+[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
export async function fingerprintComfyTargetBinding(graphFingerprint:string,targetBinding:{mode:string;binding:unknown}):Promise<string>{
 const bytes=new TextEncoder().encode(stableJson({graphFingerprint,targetBinding}));
 const hash=await crypto.subtle.digest("SHA-256",bytes);
 return "v2c:"+[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
