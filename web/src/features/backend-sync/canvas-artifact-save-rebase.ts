import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import {canonicalBackendGraph} from "./backend-source-fingerprint";

export type GraphForRebase={nodes:CanvasNodeData[];connections:CanvasConnection[]};
const validId=(id:unknown)=>typeof id==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(id);
const graphValid=(graph:GraphForRebase)=>{
 const nodes=new Set(graph.nodes.map(n=>n.id)),edges=new Set(graph.connections.map(e=>e.id));
 return nodes.size===graph.nodes.length&&edges.size===graph.connections.length&&
  graph.connections.every(e=>nodes.has(e.fromNodeId)&&nodes.has(e.toNodeId)&&e.fromNodeId!==e.toNodeId);
};
const nodeMatches=(a:CanvasNodeData,b:CanvasNodeData)=>canonicalBackendGraph({nodes:[a],connections:[]})===
 canonicalBackendGraph({nodes:[b],connections:[]});
const edgeMatches=(a:CanvasConnection,b:CanvasConnection)=>canonicalBackendGraph({nodes:[],connections:[a]})===
 canonicalBackendGraph({nodes:[],connections:[b]});
const generated=(node:CanvasNodeData)=>{
 const provenance=node.metadata?.comfyArtifact??node.metadata?.modelArtifact;
 return Boolean(provenance&&validId(provenance.artifactId)&&
  node.id==="artifact-"+provenance.artifactId&&
  ["image","video","audio","text"].includes(node.type)&&node.type===provenance.kind);
};
/** PATCH conflict recovery, restricted to the server having appended immutable
 * generated artifacts since our saved baseline. Local edits/deletions win for
 * their original nodes; remote generated nodes are never overwritten or lost.
 * Any remote modification to existing nodes/edges fails closed, preserving the
 * local draft until an explicit user reconciliation.
 */
export function rebaseCanvasArtifactAdditions(
 baseline:GraphForRebase,local:GraphForRebase,remote:GraphForRebase
):GraphForRebase|null{
 if(!graphValid(baseline)||!graphValid(local)||!graphValid(remote))return null;
 const baseNodes=new Map(baseline.nodes.map(n=>[n.id,n]));
 const localNodes=new Map(local.nodes.map(n=>[n.id,n]));
 const remoteNodes=new Map(remote.nodes.map(n=>[n.id,n]));
 const baseEdges=new Map(baseline.connections.map(e=>[e.id,e]));
 const localEdges=new Map(local.connections.map(e=>[e.id,e]));
 const remoteEdges=new Map(remote.connections.map(e=>[e.id,e]));
 for(const [id,n] of baseNodes){
  const current=remoteNodes.get(id);
  if(!current||!nodeMatches(current,n))return null;
 }
 for(const [id,e] of baseEdges){
  const current=remoteEdges.get(id);
  if(!current||!edgeMatches(current,e))return null;
 }
 const additions=remote.nodes.filter(n=>!baseNodes.has(n.id));
 if(additions.some(n=>!generated(n)||localNodes.has(n.id)||
    local.nodes.some(existing=>existing.metadata?.comfyArtifact?.artifactId===n.metadata?.comfyArtifact?.artifactId&&
     existing.metadata?.comfyArtifact?.artifactId!==undefined||
     existing.metadata?.modelArtifact?.artifactId===n.metadata?.modelArtifact?.artifactId&&
     existing.metadata?.modelArtifact?.artifactId!==undefined)))return null;
 const mergedNodes=[...local.nodes,...additions];
 const resultIds=new Set(mergedNodes.map(n=>n.id));
 const mergedEdges=[...local.connections];
 for(const edge of remote.connections){
  if(baseEdges.has(edge.id))continue;
  // Never silently consume a user's new edge with the same ID.
  if(localEdges.has(edge.id))return null;
  const target=remoteNodes.get(edge.toNodeId);
  if(!target||!generated(target)||!additions.some(n=>n.id===target.id))return null;
  const comfy=target.metadata?.comfyArtifact;
  const sourceId=comfy?.workflowNodeId??target.metadata?.modelArtifact?.sourceNodeId;
  if(edge.fromNodeId!==sourceId||
     (comfy?
      edge.fromPortId!==comfy.portId||edge.toPortId!=="comfy-artifact":
      Boolean(edge.fromPortId||edge.toPortId)))return null;
  // Local deletion of the source is intentional; retain the CAS artifact
  // detached instead of resurrecting a deleted source or dangling a link.
  if(resultIds.has(edge.fromNodeId))mergedEdges.push(edge);
 }
 // Local edits may legitimately delete existing edges and nodes. Never
 // resurrect them from the old backend revision.
 const result={nodes:mergedNodes,connections:mergedEdges};
 return graphValid(result)?result:null;
}
