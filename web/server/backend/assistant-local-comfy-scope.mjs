/** P4.5a local Comfy preauthorization: deliberately static, single-root
 * workflow only. All dynamic/asset/graph input bindings require a new explicit
 * approval. Projection excludes ONLY known per-submit IDs/revision fields.
 */
import {stableJson} from "./repository.mjs";

const fail=()=>Object.assign(Error("assistant_local_comfy_scope_unsupported"),{code:"assistant_local_comfy_scope_unsupported",statusCode:400});
const keys=(obj,allowed)=>obj&&typeof obj==="object"&&!Array.isArray(obj)&&
 Object.keys(obj).every(key=>allowed.includes(key));
const nonempty=x=>typeof x==="string"&&x.trim().length>0&&x.length<=128;

/** Returns a stable full-template-and-parameters scope, or rejects fail-closed. */
export function frozenLocalComfyScope(snapshot,{projectId,targetNodeId,document}={}){
 const node=document?.nodes?.find(n=>n.id===targetNodeId);
 const binding=node?.metadata?.comfyWorkflow;
 const request=snapshot?.comfyRequest;
 if(node?.type!=="comfy:workflow"||!binding||node.metadata?.comfyMediaPreset||
  !nonempty(projectId)||!nonempty(targetNodeId)||
  document.connections?.some(edge=>edge.toNodeId===targetNodeId)||
  !keys(snapshot,["adapterKind","instanceId","comfyRequest","comfyTemplate"])||
  snapshot.adapterKind!=="comfy"||!nonempty(snapshot.instanceId)||
  !keys(request,["schemaVersion","projectId","canvasRevision","instanceId",
   "rootOutputs","nodes","edges","externalInputs","runOptions","idempotencyKey"])||
  request.schemaVersion!==2||request.projectId!==projectId||
  request.instanceId!==snapshot.instanceId||
  !/^[1-9]\d*$/.test(String(request.canvasRevision))||
  !Array.isArray(request.nodes)||request.nodes.length!==1||
  !Array.isArray(request.rootOutputs)||request.rootOutputs.length<1||
  request.rootOutputs.length>16||!Array.isArray(request.edges)||request.edges.length||
  !Array.isArray(request.externalInputs)||request.externalInputs.length||
  stableJson(request.runOptions)!=="{}"||
  !keys(request.nodes[0],["id","templateId","templateRevision","inputOverrides"])||
  request.nodes[0].id!==targetNodeId||
  request.nodes[0].templateId!==binding.templateId||
  request.nodes[0].templateRevision!==binding.templateRevision||
  stableJson(request.nodes[0].inputOverrides)!==stableJson(binding.inputOverrides??{})||
  !request.rootOutputs.every(out=>keys(out,["nodeId","portId"])&&
   out.nodeId===targetNodeId&&nonempty(out.portId))||
  new Set(request.rootOutputs.map(out=>out.portId)).size!==request.rootOutputs.length||
  !request.rootOutputs.every(out=>snapshot.comfyTemplate?.ports?.some(port=>
   port.id===out.portId&&port.direction==="source"&&
   port.capture?.kind!=="none"&&typeof port.capture?.adapterId==="string"&&
   port.capture.adapterId.length>0))||
  !snapshot.comfyTemplate||snapshot.comfyTemplate.id!==binding.templateId||
  snapshot.comfyTemplate.revision!==binding.templateRevision)
  throw fail();
 // Intentionally exclude ephemeral submission id, canvasRevision, and node id
 // while comparing EVERYTHING else (including pinned template bytes).
 return {instanceId:snapshot.instanceId,template:snapshot.comfyTemplate,
  templateId:binding.templateId,templateRevision:binding.templateRevision,
  inputOverrides:request.nodes[0].inputOverrides,
  outputPortIds:request.rootOutputs.map(out=>out.portId),
  runOptions:request.runOptions};
}
