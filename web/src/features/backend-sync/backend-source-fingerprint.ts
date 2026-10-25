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
 const ids=new Set<string>(),visiting=new Set<string>(),incoming:typeof doc.connections=[];
 const visit=(id:string)=>{
  if(visiting.has(id))throw Error("cyclic_generation_source");
  if(ids.has(id))return;
  visiting.add(id);
  for(const edge of parents.get(id)??[]){incoming.push(edge);visit(edge.fromNodeId)}
  visiting.delete(id);ids.add(id);
 };
 visit(targetNodeId);
 const nodes=[...ids].sort().map(id=>byId.get(id));
 incoming.sort((a,b)=>{
  const left=stableJson(a),right=stableJson(b);
  return left<right?-1:left>right?1:0;
 });
 const bytes=new TextEncoder().encode(stableJson({nodes,incoming}));
 const hash=await crypto.subtle.digest("SHA-256",bytes);
 return [...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
